// 2026-09-13 全面审计 §6（auth，App 侧）：api 客户端 401 静默刷新——并发只刷新一次；
// 刷新返回与 signOut / 另一账号 signIn 交错时不得把旧会话写回；非 401 的刷新失败不应清会话（观察）。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Mock } from "jest-mock";
import type { AuthTokens } from "@helmet/shared";
import { api, attachSession, forceRefreshTokens } from "../client";

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<unknown>>;

const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("审计 §6 App api client：401 刷新排队与会话交错", () => {
  let tokens: AuthTokens | null;
  let setTokens: Mock<(t: AuthTokens) => Promise<void>>;
  let clearSession: Mock<() => Promise<void>>;
  let fetchMock: FetchMock;

  beforeEach(() => {
    tokens = { accessToken: "acc_old", refreshToken: "ref_old" };
    setTokens = jest.fn<(t: AuthTokens) => Promise<void>>(async (t) => {
      tokens = t;
    });
    clearSession = jest.fn<() => Promise<void>>(async () => {
      tokens = null;
    });
    attachSession({ getTokens: () => tokens, setTokens, clearSession });
    fetchMock =
      jest.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  const routeFetch = (opts: {
    refresh: () => Promise<unknown> | unknown;
    firstAuthed?: Set<string>;
  }): void => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) return opts.refresh();
      const authz = (init?.headers as Record<string, string> | undefined)
        ?.Authorization;
      if (authz === "Bearer acc_new") return res(200, { ok: true, url });
      return res(401, { code: "UNAUTHORIZED", message: "expired" });
    });
  };

  it("三个并发请求同时 401：只调用一次 /auth/refresh，三个请求都用新 token 重试成功", async () => {
    let refreshCalls = 0;
    routeFetch({
      refresh: async () => {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return res(200, { accessToken: "acc_new", refreshToken: "ref_new" });
      },
    });
    const results = await Promise.all([
      api<{ ok: boolean }>("/a"),
      api<{ ok: boolean }>("/b"),
      api<{ ok: boolean }>("/c"),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(setTokens).toHaveBeenCalledTimes(1);
    expect(tokens?.refreshToken).toBe("ref_new");
    // 3 次原请求 + 1 次 refresh + 3 次重试
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("【AUTH-09 缺陷断言】刷新进行中用户 signOut：刷新返回后不得把新 token 写回（会话复活）", async () => {
    let resolveRefresh: (v: unknown) => void = () => undefined;
    routeFetch({
      refresh: () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    });
    const pending = api<{ ok: boolean }>("/x").catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 5)); // 让 401 → refresh 发出
    // 用户此刻登出：本地会话清空（auth-store.dropSession 同效）
    await clearSession();
    expect(tokens).toBeNull();
    resolveRefresh(
      res(200, { accessToken: "acc_new", refreshToken: "ref_new" }),
    );
    await pending;
    // 期望：登出后会话保持为空；实际：setTokens 把刷新结果写回 → 已登出的账号复活
    expect(setTokens).not.toHaveBeenCalled();
    expect(tokens).toBeNull();
  });

  it("【AUTH-09 缺陷断言】刷新进行中另一账号 signIn：旧账号的刷新结果不得覆盖新账号 token", async () => {
    let resolveRefresh: (v: unknown) => void = () => undefined;
    routeFetch({
      refresh: () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    });
    const pending = api<{ ok: boolean }>("/y").catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 5));
    // 账号 B 登录（signIn 直接 set store，等价）
    tokens = { accessToken: "acc_B", refreshToken: "ref_B" };
    resolveRefresh(
      res(200, { accessToken: "acc_new", refreshToken: "ref_new" }),
    );
    await pending;
    expect(tokens?.refreshToken).toBe("ref_B");
  });

  it("刷新遇 429 / 5xx / 网络错误不清会话，只有 401 才是会话终结【AUTH-10 修复验证】", async () => {
    const outcomes: Record<string, string> = {};
    for (const [label, refresh] of [
      ["429", () => res(429, { code: "RATE_LIMITED" })],
      ["503", () => res(503, { code: "INTERNAL_ERROR" })],
      ["network", () => Promise.reject(new Error("Network request failed"))],
      ["401", () => res(401, { code: "UNAUTHORIZED" })],
    ] as Array<[string, () => unknown]>) {
      tokens = { accessToken: "acc_old", refreshToken: "ref_old" };
      clearSession.mockClear();
      routeFetch({ refresh });
      await api("/z").catch(() => undefined);
      outcomes[label] = clearSession.mock.calls.length
        ? "clearSession"
        : "kept";
    }
    // 只有 401 才是「会话终结」的确定信号；429/5xx/断网清会话会把用户误登出
    expect(outcomes).toEqual({
      "429": "kept",
      "503": "kept",
      network: "kept",
      "401": "clearSession",
    });
    // eslint-disable-next-line no-console
    console.log(`[audit] refresh 失败路径 → ${JSON.stringify(outcomes)}`);
  });

  // 2026-09-23 iPhone 真机：WS 每 8–30 秒被网关以 4401「访问令牌已过期」断开后反复重连。
  // 原因是断线后只发了个普通请求、指望它 401 才触发刷新——同一个 token 在 REST 这边还没到
  // 判过期那一刻，请求返回 200、不刷新，于是拿着同一个 token 死循环。4401 必须主动换新 token。
  it("forceRefreshTokens：不依赖某个请求先 401，直接换新 token", async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return res(200, { accessToken: "acc_new", refreshToken: "ref_new" });
      }
      return res(200, { ok: true }); // 业务请求一律 200：靠它等不到刷新
    });

    expect(await api("/users/me")).toEqual({ ok: true });
    expect(refreshCalls).toBe(0);

    await expect(forceRefreshTokens()).resolves.toBe("ok");
    expect(refreshCalls).toBe(1);
    expect(tokens?.accessToken).toBe("acc_new");
  });

  it("forceRefreshTokens：refresh token 被否定时清会话，不继续重连", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/refresh"))
        return res(401, { code: "UNAUTHORIZED" });
      return res(200, { ok: true });
    });
    await expect(forceRefreshTokens()).resolves.toBe("invalid");
    expect(clearSession).toHaveBeenCalled();
  });
});
