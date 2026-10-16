// 带会话的请求被 401 之后的三种结局（2026-10-17 评审）：原来刷新没成（429 / 5xx / 超时）时把原 401 抛给页面，
// 页面显示的是登录页那句「手机号或密码不正确」。现在：刷新暂时不成 → 「登录状态校验失败，请稍后重试」，按暂时失败处理；
// 会话被服务端否定 → 单独的错误（页面不必再弹，登录页有说明）；登录接口自己的 401 仍是「手机号或密码不正确」。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Mock } from "jest-mock";
import type { AuthTokens } from "@helmet/shared";

import { translate, useLocaleStore } from "@/i18n";
import {
  ApiRequestError,
  SessionCheckUnavailableError,
  SessionEndedError,
  api,
  attachSession,
} from "../client";
import {
  isSessionEnded,
  isTransientFailure,
  toUserMessage,
} from "../error-messages";

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<unknown>>;
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

let tokens: AuthTokens | null;
let clearSession: Mock<() => Promise<void>>;
let fetchMock: FetchMock;
beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN" });
  tokens = { accessToken: "acc_0", refreshToken: "ref_0" };
  clearSession = jest.fn<() => Promise<void>>(async () => {
    tokens = null;
  });
  attachSession({
    getTokens: () => tokens,
    setTokens: async (t) => {
      tokens = t;
    },
    clearSession,
  });
  fetchMock = jest.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
});

/** 业务接口一律 401，刷新接口按 refresh() 回 */
const route = (refresh: () => unknown) =>
  fetchMock.mockImplementation(async (url) =>
    url.endsWith("/auth/refresh")
      ? refresh()
      : res(401, { code: "UNAUTHORIZED", message: "expired" }),
  );

describe("刷新暂时不成（429 / 5xx / 断网）", () => {
  it.each([
    ["429", () => res(429, { code: "RATE_LIMITED" })],
    ["503", () => res(503, { code: "INTERNAL_ERROR" })],
    ["断网", () => Promise.reject(new TypeError("Network request failed"))],
  ])(
    "%s：抛「暂时核对不了」——不清会话、文案不是「手机号或密码不正确」、算暂时失败",
    async (_label, refresh) => {
      route(refresh);
      const err = await api("/contacts").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionCheckUnavailableError);
      // 按状态码分流的调用方（中转队列、取消提醒）看到的还是 401，行为不变
      expect(err).toMatchObject({ status: 401 });
      expect(err).not.toBeInstanceOf(ApiRequestError);
      expect(clearSession).not.toHaveBeenCalled();
      expect(toUserMessage(err)).toBe("登录状态校验失败，请稍后重试");
      expect(toUserMessage(err)).not.toBe(translate("error.unauthorized"));
      expect(isTransientFailure(err)).toBe(true);
      expect(isSessionEnded(err)).toBe(false);
    },
  );
});

describe("会话被服务端否定（refresh 401）", () => {
  it("清会话，抛「会话已结束」：页面据此不再弹提示；文案说要重新登录；不算暂时失败", async () => {
    route(() => res(401, { code: "UNAUTHORIZED" }));
    const err = await api("/contacts").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionEndedError);
    expect(err).toMatchObject({ status: 401 });
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(isSessionEnded(err)).toBe(true);
    expect(toUserMessage(err)).toBe("登录已失效，请重新登录");
    expect(isTransientFailure(err)).toBe(false);
  });
});

describe("UNAUTHORIZED 的文案看是哪种请求", () => {
  it("刷新成功但重试仍 401（带着会话）：「登录状态校验失败」，不是登录页那句", async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith("/auth/refresh")) {
        n += 1;
        return res(200, { accessToken: `acc_${n}`, refreshToken: `ref_${n}` });
      }
      return res(401, { code: "UNAUTHORIZED" });
    });
    const err = await api("/contacts").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ code: "UNAUTHORIZED", withSession: true });
    expect(toUserMessage(err)).toBe("登录状态校验失败，请稍后重试");
  });

  it("登录接口（不带会话）的 401：仍是「手机号或密码不正确」", async () => {
    fetchMock.mockResolvedValue(res(401, { code: "UNAUTHORIZED" }));
    const err = await api("/auth/login", {
      method: "POST",
      body: {},
      auth: false,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "UNAUTHORIZED", withSession: false });
    expect(toUserMessage(err)).toBe(translate("error.unauthorized"));
    expect(translate("error.unauthorized")).toBe("手机号或密码不正确");
  });

  it("三种语言都有这两条文案", () => {
    for (const locale of ["zh-CN", "zh-TW", "en"] as const) {
      useLocaleStore.setState({ locale });
      for (const err of [
        new SessionCheckUnavailableError(),
        new SessionEndedError(),
        new ApiRequestError(401, { code: "UNAUTHORIZED" }, undefined, true),
      ]) {
        const m = toUserMessage(err);
        expect(m).not.toMatch(/^error\./);
        expect(m).not.toBe(translate("error.unauthorized"));
      }
    }
  });
});
