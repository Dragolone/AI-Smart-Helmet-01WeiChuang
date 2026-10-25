// 边界补测（2026-10-03）：api 客户端。audit-auth-client 钉住了「并发 401 只刷新一次」与会话交错，
// 这里补它没覆盖的：不该刷新的 401、刷新后仍 401、非 JSON / 空响应体、超时、刷新结果不合法、
// 迟到的 401、以及错误 → 文案的兜底。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { Mock } from "jest-mock";
import type { AuthTokens } from "@helmet/shared";

import { translate } from "@/i18n";
import { authApi } from "../auth";
import {
  ApiRequestError,
  REQUEST_TIMEOUT_MS,
  api,
  apiList,
  apiPage,
  attachSession,
  clientTimeZone,
  forceRefreshTokens,
} from "../client";
import { toUserMessage } from "../error-messages";
import { sosApi } from "../sos";
import {
  __resetServerClockForTests,
  serverClockOffsetMs,
} from "@/services/server-clock";

type Init = RequestInit & { headers?: Record<string, string> };
type FetchMock = Mock<(url: string, init?: Init) => Promise<unknown>>;

const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn(async () => body),
});
/** 响应体不是 JSON（网关错误页 / 空体）：json() 抛 SyntaxError */
const nonJson = (status: number) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    throw new SyntaxError("Unexpected token < in JSON");
  },
});
/** 永不返回、只响应 abort 的请求（黑洞网络） */
const hang = (_url: string, init?: Init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    });
  });

const authOf = (init?: Init) => init?.headers?.Authorization;
const callsTo = (fetchMock: FetchMock, suffix: string) =>
  fetchMock.mock.calls.filter((c) => c[0].endsWith(suffix));

let tokens: AuthTokens | null;
let setTokens: Mock<(t: AuthTokens) => Promise<void>>;
let clearSession: Mock<() => Promise<void>>;
let fetchMock: FetchMock;

beforeEach(() => {
  tokens = { accessToken: "acc_0", refreshToken: "ref_0" };
  setTokens = jest.fn<(t: AuthTokens) => Promise<void>>(async (t) => {
    tokens = t;
  });
  clearSession = jest.fn<() => Promise<void>>(async () => {
    tokens = null;
  });
  attachSession({ getTokens: () => tokens, setTokens, clearSession });
  fetchMock = jest.fn<(url: string, init?: Init) => Promise<unknown>>();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
});
afterEach(() => {
  jest.useRealTimers();
});

/** 服务端：每次刷新发下一代 token（acc_n / ref_n）；业务接口只认 validAccess 里的 access token */
function rotatingServer(validAccess: () => string): {
  refreshes: () => number;
} {
  let generation = 0;
  fetchMock.mockImplementation(async (url, init) => {
    if (url.endsWith("/auth/refresh")) {
      generation += 1;
      return res(200, {
        accessToken: `acc_${generation}`,
        refreshToken: `ref_${generation}`,
      });
    }
    return authOf(init) === `Bearer ${validAccess()}`
      ? res(200, { ok: true })
      : res(401, { code: "UNAUTHORIZED", message: "expired" });
  });
  return { refreshes: () => callsTo(fetchMock, "/auth/refresh").length };
}

describe("哪些 401 不该触发刷新", () => {
  it("auth:false 的请求（登录密码错）收到 401：不刷新、不清会话，错误码取自响应体", async () => {
    fetchMock.mockResolvedValue(
      res(401, {
        code: "UNAUTHORIZED",
        message: "手机号或密码错误",
        requestId: "req-1",
      }),
    );
    const err = await api("/auth/login", {
      method: "POST",
      body: {},
      auth: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
      requestId: "req-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authOf(fetchMock.mock.calls[0][1])).toBeUndefined();
    expect(clearSession).not.toHaveBeenCalled();
    expect(tokens?.refreshToken).toBe("ref_0");
  });

  it("未登录（没有 token）却调了需鉴权的接口：不带 Authorization，401 后不发 /auth/refresh，直接按会话终结处理", async () => {
    tokens = null;
    fetchMock.mockResolvedValue(res(401, { code: "UNAUTHORIZED" }));
    await expect(api("/users/me")).rejects.toMatchObject({ status: 401 });
    expect(authOf(fetchMock.mock.calls[0][1])).toBeUndefined();
    expect(callsTo(fetchMock, "/auth/refresh")).toHaveLength(0);
    expect(clearSession).toHaveBeenCalledTimes(1);
    await expect(forceRefreshTokens()).resolves.toBe("invalid");
    expect(callsTo(fetchMock, "/auth/refresh")).toHaveLength(0);
  });
});

describe("刷新之后", () => {
  it("刷新成功但重试仍 401（账号被停用等）：把 401 抛给调用方，只刷新一次，不陷入循环", async () => {
    const server = rotatingServer(() => "never-valid");
    await expect(api("/x")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(server.refreshes()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 刷新本身是成功的：新 token 留着，会话不清
    expect(tokens?.accessToken).toBe("acc_1");
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("先后两轮过期各刷新一次（单飞 Promise 用完即弃，不会永远复用第一次的结果）", async () => {
    let valid = "acc_1";
    const server = rotatingServer(() => valid);
    await expect(api("/a")).resolves.toEqual({ ok: true });
    valid = "acc_2";
    await expect(api("/b")).resolves.toEqual({ ok: true });
    expect(server.refreshes()).toBe(2);
    expect(tokens).toEqual({ accessToken: "acc_2", refreshToken: "ref_2" });
  });

  it("迟到的 401：请求带旧 token 发出、别的请求已完成刷新后才收到 401 → 用最新 refresh token 再换一次并重试成功", async () => {
    let releaseSlow: (v: unknown) => void = () => undefined;
    let generation = 0;
    const refreshBodies: string[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith("/auth/refresh")) {
        refreshBodies.push(String(init?.body));
        generation += 1;
        return res(200, {
          accessToken: `acc_${generation}`,
          refreshToken: `ref_${generation}`,
        });
      }
      if (url.endsWith("/slow") && authOf(init) === "Bearer acc_0") {
        return new Promise((resolve) => {
          releaseSlow = resolve;
        });
      }
      return authOf(init) === `Bearer acc_${generation}` && generation > 0
        ? res(200, { url })
        : res(401, { code: "UNAUTHORIZED" });
    });
    const slow = api<{ url: string }>("/slow");
    await expect(api("/fast")).resolves.toBeDefined(); // 触发并完成第一次刷新
    releaseSlow(res(401, { code: "UNAUTHORIZED" }));
    await expect(slow).resolves.toMatchObject({
      url: expect.stringContaining("/slow"),
    });
    expect(
      refreshBodies.map(
        (b) => (JSON.parse(b) as { refreshToken: string }).refreshToken,
      ),
    ).toEqual(["ref_0", "ref_1"]);
    expect(tokens?.refreshToken).toBe("ref_2");
  });

  it("forceRefreshTokens 与某个请求的 401 同时发生：共用同一次 /auth/refresh", async () => {
    let releaseRefresh: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith("/auth/refresh")) {
        return new Promise((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return authOf(init) === "Bearer acc_1"
        ? res(200, { ok: true })
        : res(401, {});
    });
    const pending = api("/x");
    const forced = forceRefreshTokens();
    await new Promise((r) => setTimeout(r, 5));
    releaseRefresh(res(200, { accessToken: "acc_1", refreshToken: "ref_1" }));
    await expect(forced).resolves.toBe("ok");
    await expect(pending).resolves.toEqual({ ok: true });
    expect(callsTo(fetchMock, "/auth/refresh")).toHaveLength(1);
    expect(setTokens).toHaveBeenCalledTimes(1);
  });

  it("刷新在途时换了账号、旧会话的刷新回 401：被否定的是旧会话那把 token，不能把新账号的会话清掉", async () => {
    let releaseRefresh: (r: unknown) => void = () => undefined;
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith("/auth/refresh")) {
        return new Promise((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return res(401, { code: "UNAUTHORIZED" });
    });
    const pending = api("/devices").catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    tokens = { accessToken: "acc_B", refreshToken: "ref_B" }; // A 登出、B 登录
    releaseRefresh(res(401, { code: "UNAUTHORIZED" }));
    await expect(pending).resolves.toMatchObject({ status: 401 });
    expect(clearSession).not.toHaveBeenCalled();
    expect(tokens).toEqual({ accessToken: "acc_B", refreshToken: "ref_B" });
    // 同一把 token 被否定仍然清会话（没有误伤正常路径）
    fetchMock.mockImplementation(async () =>
      res(401, { code: "UNAUTHORIZED" }),
    );
    await expect(api("/devices")).rejects.toMatchObject({ status: 401 });
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it("刷新在途时换了账号：旧会话换到的新 refresh token 被送去 /auth/logout 作废；作废请求失败也不影响任何人", async () => {
    let releaseRefresh: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith("/auth/refresh")) {
        return new Promise((resolve) => {
          releaseRefresh = resolve;
        });
      }
      if (url.endsWith("/auth/logout"))
        throw new TypeError("Network request failed");
      return res(401, { code: "UNAUTHORIZED" });
    });
    const pending = api("/x").catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    tokens = { accessToken: "acc_B", refreshToken: "ref_B" };
    releaseRefresh(
      res(200, { accessToken: "acc_orphan", refreshToken: "ref_orphan" }),
    );
    await expect(pending).resolves.toMatchObject({ status: 401 });
    const logout = callsTo(fetchMock, "/auth/logout");
    expect(logout).toHaveLength(1);
    expect(JSON.parse(String(logout[0][1]?.body))).toEqual({
      refreshToken: "ref_orphan",
    });
    expect(tokens).toEqual({ accessToken: "acc_B", refreshToken: "ref_B" });
    expect(clearSession).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0)); // 作废请求的失败已被吞掉，不留未处理拒绝
  });

  it("刷新接口回 200 但响应体不是 JSON（劫持页 / 网关异常）：不写 token、不清会话，下一次 401 能重新刷新", async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return refreshCalls === 1
          ? nonJson(200)
          : res(200, { accessToken: "acc_1", refreshToken: "ref_1" });
      }
      return authOf(init) === "Bearer acc_1"
        ? res(200, { ok: true })
        : res(401, {});
    });
    await expect(api("/x")).rejects.toBeInstanceOf(SyntaxError);
    expect(setTokens).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    expect(tokens?.refreshToken).toBe("ref_0");
    await expect(api("/x")).resolves.toEqual({ ok: true });
    expect(refreshCalls).toBe(2);
  });

  it.each([
    ["空对象", {}],
    ["只有 accessToken", { accessToken: "acc_1" }],
    ["只有 refreshToken", { refreshToken: "ref_1" }],
    ["两个都是空串", { accessToken: "", refreshToken: "" }],
    ["类型不对", { accessToken: 1, refreshToken: null }],
    ["null", null],
  ])(
    "刷新接口回 200 但体里没有一对 token（%s）：不写 token、不清会话，把原 401 交给调用方，下一次还能刷新",
    async (_name, body) => {
      let refreshCalls = 0;
      fetchMock.mockImplementation(async (url, init) => {
        if (url.endsWith("/auth/refresh")) {
          refreshCalls += 1;
          return refreshCalls === 1
            ? res(200, body)
            : res(200, { accessToken: "acc_1", refreshToken: "ref_1" });
        }
        return authOf(init) === "Bearer acc_1"
          ? res(200, { ok: true })
          : res(401, {});
      });
      await expect(api("/x")).rejects.toMatchObject({ status: 401 });
      expect(setTokens).not.toHaveBeenCalled();
      expect(clearSession).not.toHaveBeenCalled();
      expect(tokens).toEqual({ accessToken: "acc_0", refreshToken: "ref_0" });
      expect(callsTo(fetchMock, "/auth/logout")).toHaveLength(0);
      await expect(api("/x")).resolves.toEqual({ ok: true });
      expect(refreshCalls).toBe(2);
    },
  );

  it("token 落盘失败（钥匙串暂不可用）但内存里已换上新 token：刷新算成功，原请求照常重试，不清会话", async () => {
    const server = rotatingServer(() => "acc_1");
    setTokens.mockImplementationOnce(async (t) => {
      tokens = t;
      throw new Error("User interaction is not allowed");
    });
    await expect(api("/x")).resolves.toEqual({ ok: true });
    expect(server.refreshes()).toBe(1);
    expect(tokens).toEqual({ accessToken: "acc_1", refreshToken: "ref_1" });
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("写 token 整个失败（内存里也没换上）：按「暂时刷不了」处理——把原 401 交给调用方，不清会话", async () => {
    rotatingServer(() => "acc_1");
    setTokens.mockImplementationOnce(async () => {
      throw new Error("store unavailable");
    });
    await expect(api("/x")).rejects.toMatchObject({ status: 401 });
    expect(tokens).toEqual({ accessToken: "acc_0", refreshToken: "ref_0" });
    expect(clearSession).not.toHaveBeenCalled();
  });
});

describe("响应体形态", () => {
  it("204：返回 undefined，不去解析响应体", async () => {
    const r = res(204);
    fetchMock.mockResolvedValue(r);
    await expect(
      api<void>("/devices/x/binding", { method: "DELETE" }),
    ).resolves.toBeUndefined();
    expect(r.json).not.toHaveBeenCalled();
  });

  it.each([
    ["网关错误页（非 JSON）", () => nonJson(502)],
    ["JSON null", () => res(502, null)],
    ["JSON 字符串", () => res(502, "Bad Gateway")],
  ])(
    "错误响应体是%s：兜底成 INTERNAL_ERROR + HTTP 状态，文案走「服务异常」而不是「未知错误」",
    async (_l, make) => {
      fetchMock.mockResolvedValue(make());
      const err = await api("/x", { auth: false }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err).toMatchObject({
        status: 502,
        code: "INTERNAL_ERROR",
        message: "HTTP 502",
      });
      expect(toUserMessage(err)).toBe(translate("error.internal"));
    },
  );

  it("429 带 Retry-After：错误对象记下秒数，文案说「请 N 秒后再试」（决策 #53；负责人 2026-10-07 iPhone 2.6 实测只说「太频繁」不知要等多久）", async () => {
    fetchMock.mockResolvedValue({
      ...res(429, { code: "RATE_LIMITED", message: "请求过于频繁" }),
      headers: { get: (k: string) => (k === "retry-after" ? "47" : null) },
    });
    const err = await api("/devices/bind", { method: "POST", body: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 47 });
    expect(toUserMessage(err)).toBe(
      translate("error.rateLimitedRetry", { seconds: 47 }),
    );
  });

  it.each([
    [90, translate("error.rateLimitedRetry", { seconds: 90 })],
    [91, translate("error.rateLimitedRetryMinutes", { minutes: 2 })],
    [5400, translate("error.rateLimitedRetryMinutes", { minutes: 90 })],
    // 发码日限（同 IP 每天 50 条）：Retry-After 可达 86400，不能写「请 86231 秒后再试」
    [86_231, translate("error.rateLimitedRetryHours", { hours: 24 })],
  ])("429 Retry-After=%d 换成人读得懂的单位", (seconds, text) => {
    const err = new ApiRequestError(429, { code: "RATE_LIMITED" }, seconds);
    expect(toUserMessage(err)).toBe(text);
  });

  it("429 没有 Retry-After（或值不是秒数）：退回原来的「请稍后再试」", async () => {
    fetchMock.mockResolvedValue({
      ...res(429, { code: "RATE_LIMITED" }),
      headers: { get: () => "Wed, 07 Oct 2026 01:00:00 GMT" },
    });
    const err = await api("/x", { auth: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterSec: undefined,
    });
    expect(toUserMessage(err)).toBe(translate("error.rateLimited"));
  });

  it("请求体：未传 body 不带 Content-Type；0 / false / null / 空串是合法 JSON，照常序列化", async () => {
    fetchMock.mockImplementation(async () => res(200, {}));
    await api("/x", { auth: false });
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty(
      "Content-Type",
    );
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
    for (const body of [0, false, null, ""]) {
      fetchMock.mockClear();
      await api("/x", { method: "POST", body, auth: false });
      const init = fetchMock.mock.calls[0][1];
      expect(init?.headers).toMatchObject({
        "Content-Type": "application/json",
      });
      expect(init?.body).toBe(JSON.stringify(body));
    }
  });
});

describe("列表接口应答不是数组（10-21 夜测：开屏层对设备列表调 .find，App 每次一开就闪退）", () => {
  it("字符串 / 对象 / null 都按服务端出错（INTERNAL_ERROR）处理；数组照常返回", async () => {
    for (const bad of ["unexpected", { error: "blocked" }, null, 42]) {
      fetchMock.mockResolvedValueOnce(res(200, bad));
      const e = await apiList("/devices").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiRequestError);
      expect((e as ApiRequestError).code).toBe("INTERNAL_ERROR");
      expect(toUserMessage(e)).toBe(translate("error.internal"));
    }
    fetchMock.mockResolvedValueOnce(res(200, [{ deviceId: "d1" }]));
    await expect(apiList("/devices")).resolves.toEqual([{ deviceId: "d1" }]);
  });
});

describe("分页接口应答的 items 不是数组（10-25 iOS 改写应答：安全页对 undefined 取下标整页崩、冷启动补拉求救遍历时抛错）", () => {
  it("字符串 / null / 数字 / 数组 / 没有 items / items 不是数组 都按服务端出错（INTERNAL_ERROR）；正常分页照常返回", async () => {
    for (const bad of [
      "unexpected",
      null,
      42,
      [1, 2],
      {},
      { items: null, total: 0 },
      { items: "x", total: 1 },
    ]) {
      fetchMock.mockResolvedValueOnce(res(200, bad));
      const e = await apiPage("/devices/d1/accidents").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiRequestError);
      expect((e as ApiRequestError).code).toBe("INTERNAL_ERROR");
      expect(toUserMessage(e)).toBe(translate("error.internal"));
    }
    const page = { items: [{ sosId: "s1" }], total: 1, page: 1, pageSize: 20 };
    fetchMock.mockResolvedValueOnce(res(200, page));
    await expect(apiPage("/devices/d1/accidents")).resolves.toEqual(page);
  });
});

describe("不用 HTTP 缓存（10-21 夜测：手机时间往回拨后 OkHttp 一直给旧应答）", () => {
  it("每个请求都带 Cache-Control: no-store，登录前的、带会话的、带请求体的都一样", async () => {
    fetchMock.mockImplementation(async () => res(200, {}));
    await api("/x", { auth: false });
    await api("/devices");
    await api("/x", { method: "POST", body: { a: 1 } });
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ "Cache-Control": "no-store" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("超时（15 s）", () => {
  it("请求挂起：14.999 s 还在等，15 s 被中止；文案是「超时」而不是「没有网络」，会话不动", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(hang);
    let settled: unknown = "pending";
    const p = api("/x").catch((e: unknown) => {
      settled = e;
    });
    await jest.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe("pending");
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toMatchObject({ name: "AbortError" });
    expect(toUserMessage(settled)).toBe(translate("error.timeout"));
    expect(translate("error.timeout")).not.toBe(translate("error.network"));
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("请求按时返回后不留下 15 s 定时器（否则每个请求都拖一个定时器到超时点）", async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(res(200, {}));
    await api("/x");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("刷新请求本身挂起到超时：按「暂时刷不了」处理——保留会话，把原 401 交给调用方，之后还能再刷", async () => {
    jest.useFakeTimers();
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return refreshCalls === 1
          ? hang(url, init)
          : res(200, { accessToken: "acc_1", refreshToken: "ref_1" });
      }
      return authOf(init) === "Bearer acc_1"
        ? res(200, { ok: true })
        : res(401, { code: "UNAUTHORIZED" });
    });
    const first = api("/x").catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(15_000);
    await expect(first).resolves.toMatchObject({ status: 401 });
    expect(clearSession).not.toHaveBeenCalled();
    expect(tokens?.refreshToken).toBe("ref_0");
    await expect(api("/x")).resolves.toEqual({ ok: true });
  });
});

describe("按调用传超时（timeoutMs，O7 10-20）", () => {
  it("传 8 s：7.999 s 还在等、8 s 被中止，文案同样是「超时」；同时发出、没传的那个仍等到 15 s", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(hang);
    let short: unknown = "pending";
    let long: unknown = "pending";
    const p1 = api("/x", { timeoutMs: 8_000 }).catch((e: unknown) => {
      short = e;
    });
    const p2 = api("/y").catch((e: unknown) => {
      long = e;
    });
    await jest.advanceTimersByTimeAsync(7_999);
    expect(short).toBe("pending");
    await jest.advanceTimersByTimeAsync(1);
    await p1;
    expect(short).toMatchObject({ name: "AbortError" });
    expect(toUserMessage(short)).toBe(translate("error.timeout"));
    expect(long).toBe("pending");
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 8_000);
    await p2;
    expect(long).toMatchObject({ name: "AbortError" });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("求救：倒计时页的取消 / 立即求救 8 s 就放弃；锁屏通知按钮那条显式传全局超时的取消、快照照旧 15 s", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(hang);
    const gaveUp: string[] = [];
    const track = (k: string, p: Promise<unknown>) =>
      p.catch(() => {
        gaveUp.push(k);
      });
    const all = Promise.all([
      track("cancel", sosApi.cancel("s1")),
      track("confirm", sosApi.confirm("s1")),
      track("bg", sosApi.cancel("s1", { timeoutMs: REQUEST_TIMEOUT_MS })),
      track("snapshot", sosApi.snapshot("s1")),
    ]);
    await jest.advanceTimersByTimeAsync(7_999);
    expect(gaveUp).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(gaveUp.sort()).toEqual(["cancel", "confirm"]);
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 8_000);
    await all;
    expect(gaveUp.sort()).toEqual(["bg", "cancel", "confirm", "snapshot"]);
  });

  it("401 后：中间的刷新照旧给 15 s（全账号共用的一次，不被急着要结果的接口掐掉）；刷新成功后重发的那次按调用的 8 s", async () => {
    jest.useFakeTimers();
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return refreshCalls === 1
          ? hang(url, init)
          : res(200, { accessToken: "acc_1", refreshToken: "ref_1" });
      }
      return authOf(init) === "Bearer acc_1"
        ? hang(url, init)
        : res(401, { code: "UNAUTHORIZED" });
    });
    // 第一次：刷新挂起——8 s 时还在等，15 s 才按「暂时核对不了」交回
    let first: unknown = "pending";
    const p1 = api("/x", { timeoutMs: 8_000 }).catch((e: unknown) => {
      first = e;
    });
    await jest.advanceTimersByTimeAsync(8_000);
    expect(first).toBe("pending");
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 8_000);
    await p1;
    expect(first).toMatchObject({ code: "SESSION_CHECK_UNAVAILABLE" });
    // 第二次：刷新立刻成功，换了 token 重发的那次挂起——8 s 被中止
    let second: unknown = "pending";
    const p2 = api("/x", { timeoutMs: 8_000 }).catch((e: unknown) => {
      second = e;
    });
    await jest.advanceTimersByTimeAsync(7_999);
    expect(second).toBe("pending");
    await jest.advanceTimersByTimeAsync(1);
    await p2;
    expect(second).toMatchObject({ name: "AbortError" });
  });
});

describe("toUserMessage 兜底", () => {
  it("抛出来的不是 Error（字符串 / undefined / null / 普通对象）：一律按网络失败提示，不抛", () => {
    for (const thrown of ["boom", undefined, null, {}, 42]) {
      expect(toUserMessage(thrown)).toBe(translate("error.network"));
    }
  });

  it("未收录的错误码：把原始 code 带进文案，便于用户截图报障", () => {
    // CHANNEL_FULL 10-16 已补文案，这里换一个后端没有的码
    const m = toUserMessage(
      new ApiRequestError(409, { code: "SOME_FUTURE_CODE" }),
    );
    expect(m).toBe(translate("error.unknown", { code: "SOME_FUTURE_CODE" }));
    expect(m).toContain("SOME_FUTURE_CODE");
  });

  it("错误码恰好是 Object.prototype 的成员名：照样按未收录的码给文案，不返回 undefined", () => {
    for (const code of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
      "valueOf",
    ]) {
      const m = toUserMessage(new ApiRequestError(400, { code }));
      expect(m).toBe(translate("error.unknown", { code }));
      expect(typeof m).toBe("string");
    }
  });
});

describe("请求体里带 token 的接口：401 重试时要重取（2026-10-05 评审）", () => {
  const bodyOf = (call: [string, Init?]) =>
    JSON.parse(String(call[1]?.body)) as Record<string, unknown>;

  it("body 传函数时每次发请求现算；传普通值时原样重发", async () => {
    rotatingServer(() => "acc_1");
    let n = 0;
    await api("/x", { method: "POST", body: () => ({ n: (n += 1) }) });
    const calls = callsTo(fetchMock, "/x") as [string, Init?][];
    expect(calls.map(bodyOf)).toEqual([{ n: 1 }, { n: 2 }]);
    fetchMock.mockClear();
    tokens = { accessToken: "acc_0", refreshToken: "ref_1" };
    rotatingServer(() => "acc_1");
    await api("/y", { method: "POST", body: { fixed: true } });
    expect((callsTo(fetchMock, "/y") as [string, Init?][]).map(bodyOf)).toEqual(
      [{ fixed: true }, { fixed: true }],
    );
  });

  it("改密恰好撞上 access token 过期：重试带的是轮换后的 refresh token——否则服务端保留的是已作废的那把，本机 15 分钟内被静默登出", async () => {
    rotatingServer(() => "acc_1");
    await authApi.changePassword({
      oldPassword: "old-pass-1",
      newPassword: "new-pass-1",
    });
    const calls = callsTo(fetchMock, "/auth/change-password") as [
      string,
      Init?,
    ][];
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0])).toEqual({
      oldPassword: "old-pass-1",
      newPassword: "new-pass-1",
      refreshToken: "ref_0",
    });
    expect(bodyOf(calls[1]).refreshToken).toBe("ref_1");
  });

  it("没登录时改密（不该发生）：refreshToken 为空串，不抛", async () => {
    tokens = null;
    fetchMock.mockResolvedValue(res(204));
    await authApi.changePassword({ oldPassword: "a", newPassword: "b" });
    expect(
      bodyOf(
        (callsTo(fetchMock, "/auth/change-password") as [string, Init?][])[0],
      ).refreshToken,
    ).toBe("");
  });
});

describe("服务端时钟（F-3）", () => {
  it("每个响应的 Date 头都喂给 server-clock；没有 headers 的假响应不报错", async () => {
    __resetServerClockForTests();
    const serverDate = new Date(Date.now() - 90_000).toUTCString();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      headers: { get: (k: string) => (k === "date" ? serverDate : null) },
    });
    await api("/x");
    expect(serverClockOffsetMs()).toBeLessThan(-80_000);
    fetchMock.mockResolvedValue(res(200, { ok: true })); // 没有 headers
    await expect(api("/x")).resolves.toEqual({ ok: true });
    __resetServerClockForTests();
  });
});

describe("时区头（O13，负责人 10-21 定：推送里的时间按用户时区写）", () => {
  const realIntl = Intl.DateTimeFormat;
  const withTz = (tz: unknown) => {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = (() => ({
      resolvedOptions: () => ({ timeZone: tz }),
    })) as unknown;
  };
  afterEach(() => {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = realIntl;
  });

  it("每个请求都带手机此刻的时区（IANA 名），登录前的接口也带；每次现取，跨时区后下一个请求就是新的", async () => {
    fetchMock.mockImplementation(async () => res(200, {}));
    withTz("Australia/Sydney");
    await api("/x", { auth: false });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      "X-Client-Timezone": "Australia/Sydney",
    });
    withTz("Asia/Shanghai");
    await api("/x");
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      "X-Client-Timezone": "Asia/Shanghai",
    });
  });

  it("取不到（Intl 抛错 / 空串 / 带怪字符）：不带这个头，请求照发", async () => {
    fetchMock.mockImplementation(async () => res(200, {}));
    for (const bad of ["", "Asia/Shang hai", "x\ny", undefined]) {
      withTz(bad);
      expect(clientTimeZone()).toBeNull();
    }
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = (() => {
      throw new Error("no Intl");
    }) as unknown;
    await api("/x", { auth: false });
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty(
      "X-Client-Timezone",
    );
  });
});
