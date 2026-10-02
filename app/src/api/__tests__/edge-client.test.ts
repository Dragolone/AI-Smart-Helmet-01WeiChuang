// 边界补测（2026-10-03）：api 客户端。audit-auth-client 钉住了「并发 401 只刷新一次」与会话交错，
// 这里补它没覆盖的：不该刷新的 401、刷新后仍 401、非 JSON / 空响应体、超时、刷新结果不合法、
// 迟到的 401、以及错误 → 文案的兜底。
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Mock } from "jest-mock";
import type { AuthTokens } from "@helmet/shared";

import { translate } from "@/i18n";
import { ApiRequestError, api, attachSession, forceRefreshTokens } from "../client";
import { toUserMessage } from "../error-messages";

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
function rotatingServer(validAccess: () => string): { refreshes: () => number } {
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
      res(401, { code: "UNAUTHORIZED", message: "手机号或密码错误", requestId: "req-1" }),
    );
    const err = await api("/auth/login", { method: "POST", body: {}, auth: false }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 401, code: "UNAUTHORIZED", requestId: "req-1" });
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
    await expect(api("/x")).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
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
        return res(200, { accessToken: `acc_${generation}`, refreshToken: `ref_${generation}` });
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
    await expect(slow).resolves.toMatchObject({ url: expect.stringContaining("/slow") });
    expect(refreshBodies.map((b) => (JSON.parse(b) as { refreshToken: string }).refreshToken)).toEqual([
      "ref_0",
      "ref_1",
    ]);
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
      return authOf(init) === "Bearer acc_1" ? res(200, { ok: true }) : res(401, {});
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

  it("刷新在途时换了账号：旧会话换到的新 refresh token 被送去 /auth/logout 作废；作废请求失败也不影响任何人", async () => {
    let releaseRefresh: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith("/auth/refresh")) {
        return new Promise((resolve) => {
          releaseRefresh = resolve;
        });
      }
      if (url.endsWith("/auth/logout")) throw new TypeError("Network request failed");
      return res(401, { code: "UNAUTHORIZED" });
    });
    const pending = api("/x").catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    tokens = { accessToken: "acc_B", refreshToken: "ref_B" };
    releaseRefresh(res(200, { accessToken: "acc_orphan", refreshToken: "ref_orphan" }));
    await expect(pending).resolves.toMatchObject({ status: 401 });
    const logout = callsTo(fetchMock, "/auth/logout");
    expect(logout).toHaveLength(1);
    expect(JSON.parse(String(logout[0][1]?.body))).toEqual({ refreshToken: "ref_orphan" });
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
      return authOf(init) === "Bearer acc_1" ? res(200, { ok: true }) : res(401, {});
    });
    await expect(api("/x")).rejects.toBeInstanceOf(SyntaxError);
    expect(setTokens).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    expect(tokens?.refreshToken).toBe("ref_0");
    await expect(api("/x")).resolves.toEqual({ ok: true });
    expect(refreshCalls).toBe(2);
  });
});

describe("响应体形态", () => {
  it("204：返回 undefined，不去解析响应体", async () => {
    const r = res(204);
    fetchMock.mockResolvedValue(r);
    await expect(api<void>("/devices/x/binding", { method: "DELETE" })).resolves.toBeUndefined();
    expect(r.json).not.toHaveBeenCalled();
  });

  it.each([
    ["网关错误页（非 JSON）", () => nonJson(502)],
    ["JSON null", () => res(502, null)],
    ["JSON 字符串", () => res(502, "Bad Gateway")],
  ])("错误响应体是%s：兜底成 INTERNAL_ERROR + HTTP 状态，文案走「服务异常」而不是「未知错误」", async (_l, make) => {
    fetchMock.mockResolvedValue(make());
    const err = await api("/x", { auth: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 502, code: "INTERNAL_ERROR", message: "HTTP 502" });
    expect(toUserMessage(err)).toBe(translate("error.internal"));
  });

  it("请求体：未传 body 不带 Content-Type；0 / false / null / 空串是合法 JSON，照常序列化", async () => {
    fetchMock.mockImplementation(async () => res(200, {}));
    await api("/x", { auth: false });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", headers: {} });
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
    for (const body of [0, false, null, ""]) {
      fetchMock.mockClear();
      await api("/x", { method: "POST", body, auth: false });
      const init = fetchMock.mock.calls[0][1];
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(init?.body).toBe(JSON.stringify(body));
    }
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
      return authOf(init) === "Bearer acc_1" ? res(200, { ok: true }) : res(401, { code: "UNAUTHORIZED" });
    });
    const first = api("/x").catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(15_000);
    await expect(first).resolves.toMatchObject({ status: 401 });
    expect(clearSession).not.toHaveBeenCalled();
    expect(tokens?.refreshToken).toBe("ref_0");
    await expect(api("/x")).resolves.toEqual({ ok: true });
  });
});

describe("toUserMessage 兜底", () => {
  it("抛出来的不是 Error（字符串 / undefined / null / 普通对象）：一律按网络失败提示，不抛", () => {
    for (const thrown of ["boom", undefined, null, {}, 42]) {
      expect(toUserMessage(thrown)).toBe(translate("error.network"));
    }
  });

  it("未收录的错误码：把原始 code 带进文案，便于用户截图报障", () => {
    const m = toUserMessage(new ApiRequestError(409, { code: "CHANNEL_FULL" }));
    expect(m).toBe(translate("error.unknown", { code: "CHANNEL_FULL" }));
    expect(m).toContain("CHANNEL_FULL");
  });
});
