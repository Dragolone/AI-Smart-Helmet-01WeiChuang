// O19-A（负责人 10-21 定）：倒计时页在屏、这单还在倒数时会话被服务端否定（别处改了密码 / 刷新被判复用……），
// 先不登出，倒数结束（多留 3 s）再清——原来直接回登录页，倒计时页和警报一起消失，误报也取消不了。
// 期间接口在本地直接按「会话已结束」拒掉、不再拿死掉的 refresh 去试；倒计时页上点「重新登录后取消」立刻清。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { Mock } from "jest-mock";
import type { UserProfile } from "@helmet/shared";

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
jest.mock("@/api/auth", () => ({
  authApi: { logout: async () => undefined },
}));

import { SessionEndedError, api, forceRefreshTokens } from "@/api/client";
import { setCountdownHold } from "@/services/countdown-hold";
import { useAuthStore } from "../auth-store";

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<unknown>>;
const res = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
let fetchMock: FetchMock;
const user = { id: "u1", phone: "13900000042" } as unknown as UserProfile;
const signedIn = () =>
  useAuthStore.setState({
    tokens: { accessToken: "acc", refreshToken: "ref" },
    user,
    sessionExpired: false,
    sessionDeadUntil: null,
    expiredDuringSos: false,
  });
/** 业务接口 401、刷新也 401：服务端否定了这次会话 */
const rejectSession = () =>
  fetchMock.mockImplementation(async (url) =>
    url.endsWith("/auth/refresh")
      ? res(401, { code: "UNAUTHORIZED" })
      : res(401, { code: "UNAUTHORIZED" }),
  );
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-10-21T04:00:00Z") });
  fetchMock = jest.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  signedIn();
});
afterEach(async () => {
  setCountdownHold(null);
  await useAuthStore.getState().dropSession();
  jest.useRealTimers();
});

describe("没有在倒数的单", () => {
  it("和原来一样：立刻清会话、登录页说明被动登出", async () => {
    rejectSession();
    await expect(api("/contacts")).rejects.toBeInstanceOf(SessionEndedError);
    const s = useAuthStore.getState();
    expect(s.tokens).toBeNull();
    expect(s.sessionExpired).toBe(true);
    expect(s.expiredDuringSos).toBe(false);
    expect(s.sessionDeadUntil).toBeNull();
  });

  it("登记的截止时刻已经过了（倒数走完、页面还没收到终态）：也立刻清", async () => {
    setCountdownHold(Date.now() - 1);
    rejectSession();
    await api("/contacts").catch(() => undefined);
    expect(useAuthStore.getState().tokens).toBeNull();
  });
});

describe("倒计时页在屏、还剩 20 秒", () => {
  const until = () => Date.now() + 20_000;

  it("先不登出：会话标成已否定，倒数结束 + 3 s 才清，登录页多说一句联系人已收到通知", async () => {
    const deadline = until();
    setCountdownHold(deadline);
    rejectSession();
    await expect(api("/contacts")).rejects.toBeInstanceOf(SessionEndedError);
    let s = useAuthStore.getState();
    expect(s.tokens).not.toBeNull();
    expect(s.sessionDeadUntil).toBe(deadline);
    expect(s.sessionExpired).toBe(false);

    await jest.advanceTimersByTimeAsync(22_999);
    expect(useAuthStore.getState().tokens).not.toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    s = useAuthStore.getState();
    expect(s.tokens).toBeNull();
    expect(s.user).toBeNull();
    expect(s.sessionExpired).toBe(true);
    expect(s.expiredDuringSos).toBe(true);
    expect(s.sessionDeadUntil).toBeNull();
  });

  it("等的这段时间：带会话的请求不发出去、直接按会话已结束拒掉；不再拿死掉的 refresh 去试；再撞一次 401 不重排定时器", async () => {
    setCountdownHold(until());
    rejectSession();
    await api("/contacts").catch(() => undefined);
    const firstUntil = useAuthStore.getState().sessionDeadUntil;
    fetchMock.mockClear();

    await expect(
      api("/sos/s1/cancel", { method: "POST" }),
    ).rejects.toBeInstanceOf(SessionEndedError);
    await expect(forceRefreshTokens()).resolves.toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().sessionDeadUntil).toBe(firstUntil);
    expect(useAuthStore.getState().tokens).not.toBeNull();
    // 不带会话的接口（登录页要用）照常发
    fetchMock.mockResolvedValue(res(200, { ok: true }));
    await api("/legal/version", { auth: false }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("点「重新登录后取消」：立刻清会话回登录页，不说联系人已收到通知；之后定时器不再动", async () => {
    setCountdownHold(until());
    rejectSession();
    await api("/contacts").catch(() => undefined);
    await useAuthStore.getState().endDeadSession();
    let s = useAuthStore.getState();
    expect(s.tokens).toBeNull();
    expect(s.sessionExpired).toBe(true);
    expect(s.expiredDuringSos).toBe(false);
    expect(s.sessionDeadUntil).toBeNull();

    useAuthStore.setState({ sessionExpired: false });
    await jest.advanceTimersByTimeAsync(30_000);
    s = useAuthStore.getState();
    expect(s.sessionExpired).toBe(false);
    expect(s.expiredDuringSos).toBe(false);
  });

  it("页面上的单都结束了、按到点通知收尾：登录页说明里多那一句（倒计时页见 sos-active 的用例）", async () => {
    setCountdownHold(until());
    rejectSession();
    await api("/contacts").catch(() => undefined);
    await useAuthStore.getState().endDeadSession({ duringSos: true });
    const s = useAuthStore.getState();
    expect(s.tokens).toBeNull();
    expect(s.expiredDuringSos).toBe(true);
  });

  it("会话没被否定时点它：什么都不做", async () => {
    await useAuthStore.getState().endDeadSession();
    expect(useAuthStore.getState().tokens).not.toBeNull();
    expect(useAuthStore.getState().sessionExpired).toBe(false);
  });

  it("等的时候重新登录（signIn）：标记清掉、定时器作废，新会话不会被到点清掉", async () => {
    setCountdownHold(until());
    rejectSession();
    await api("/contacts").catch(() => undefined);
    await useAuthStore.getState().signIn({
      accessToken: "acc2",
      refreshToken: "ref2",
      user,
    } as never);
    await jest.advanceTimersByTimeAsync(30_000);
    const s = useAuthStore.getState();
    expect(s.tokens?.accessToken).toBe("acc2");
    expect(s.sessionDeadUntil).toBeNull();
    expect(s.sessionExpired).toBe(false);
  });

  it("本来就没登录：401 不算被动登出，也不进等待", async () => {
    setCountdownHold(until());
    useAuthStore.setState({ tokens: null, user: null });
    rejectSession();
    await api("/contacts").catch(() => undefined);
    const s = useAuthStore.getState();
    expect(s.sessionDeadUntil).toBeNull();
    expect(s.sessionExpired).toBe(false);
  });
});
