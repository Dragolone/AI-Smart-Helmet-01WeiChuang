// 远程推送接入的四条不变式：
//   ① 没同意隐私政策绝不 init（合规硬约束），同意的那一刻补做；
//   ② 监听先于 init 挂上（Android 被杀点通知会在 init 里回放缓存的那次点击）；
//   ③ alias = 用户 ID，登出 deleteAlias；同一用户重复 start 不重复 init/setAlias；
//   ④ 点通知落地：进行中 → 倒计时页，否则 → 事故详情（accidentId = sosId）。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

type Listener = (r: {
  notificationEventType: "notificationArrived" | "notificationOpened";
  extras?: Record<string, string>;
}) => void;

const mockInit = jest.fn();
const mockSetAlias = jest.fn();
const mockDeleteAlias = jest.fn();
const mockAddNotificationListener = jest.fn((_cb: Listener) => undefined);
const mockRouterPush = jest.fn();
const mockActive = jest.fn(async (_deviceId: string) => ({ sos: null as unknown }));
const mockSecure = new Map<string, string>();

jest.mock("jpush-react-native", () => ({
  __esModule: true,
  default: {
    init: (p: unknown) => mockInit(p),
    setAlias: (p: unknown) => mockSetAlias(p),
    deleteAlias: (p: unknown) => mockDeleteAlias(p),
    addNotificationListener: (cb: Listener) => mockAddNotificationListener(cb),
    addConnectEventListener: () => undefined,
    setLoggerEnable: () => undefined,
    getRegistrationID: (cb: (r: { registerID: string }) => void) =>
      cb({ registerID: "rid" }),
  },
}));
jest.mock("expo-router", () => ({ router: { push: (h: string) => mockRouterPush(h) } }));
jest.mock("@/api/sos", () => ({ sosApi: { active: (d: string) => mockActive(d) } }));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => mockSecure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    mockSecure.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    mockSecure.delete(k);
  },
}));

import { useConsentStore } from "@/stores/consent-store";

import {
  __resetPushForTests,
  landFromPush,
  readPushConfig,
  startPush,
  stopPush,
} from "../push";

const openedListener = (): Listener => {
  const cb = mockAddNotificationListener.mock.calls[0]?.[0];
  if (!cb) throw new Error("监听没挂上");
  return cb;
};

beforeEach(() => {
  __resetPushForTests();
  useConsentStore.setState({ privacyAccepted: false, hydrated: true });
  mockSecure.clear();
});
afterEach(() => {
  jest.clearAllMocks();
});

describe("推送初始化门控", () => {
  it("未同意隐私政策：不 init、不 setAlias", () => {
    startPush("u1");
    expect(mockInit).not.toHaveBeenCalled();
    expect(mockSetAlias).not.toHaveBeenCalled();
  });

  it("同意的那一刻补做 init + setAlias", async () => {
    startPush("u1");
    await useConsentStore.getState().accept();
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({ appKey: "79cce150234ce38063213ccd", channel: "official" }),
    );
    expect(mockSetAlias).toHaveBeenCalledWith(expect.objectContaining({ alias: "u1" }));
  });

  it("已同意：立即 init，且监听先于 init 挂上", () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    expect(mockAddNotificationListener).toHaveBeenCalledTimes(1);
    expect(mockAddNotificationListener.mock.invocationCallOrder[0]).toBeLessThan(
      mockInit.mock.invocationCallOrder[0],
    );
  });

  it("同一用户重复 start：init 与 setAlias 都只做一次；换用户只重设 alias", () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    startPush("u1");
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockSetAlias).toHaveBeenCalledTimes(1);
    startPush("u2");
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockSetAlias).toHaveBeenCalledTimes(2);
    expect(mockSetAlias).toHaveBeenLastCalledWith(expect.objectContaining({ alias: "u2" }));
  });

  it("登出 deleteAlias；未初始化时登出不报错也不调 SDK", () => {
    stopPush();
    expect(mockDeleteAlias).not.toHaveBeenCalled();
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    stopPush();
    expect(mockDeleteAlias).toHaveBeenCalledTimes(1);
  });

  it("AppKey 直接来自 app.json extra.jpush（与原生插件同一份）", () => {
    expect(readPushConfig()).toEqual(
      expect.objectContaining({ appKey: expect.stringMatching(/^[0-9a-f]{24}$/) }),
    );
    // 传 undefined 会命中默认参数（读真 app.json），所以用空对象表示「没配」
    expect(readPushConfig({})).toBeNull();
    expect(readPushConfig({ jpush: {} })).toBeNull();
  });

  it("没配 appKey：什么都不做", () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1", null);
    expect(mockInit).not.toHaveBeenCalled();
  });
});

describe("点通知落地", () => {
  it("SOS 进行中 → 倒计时页", async () => {
    mockActive.mockResolvedValueOnce({
      sos: { sosId: "s1", deviceId: "d1", status: "pending" },
    });
    const target = await landFromPush({ sosId: "s1", deviceId: "d1" });
    expect(target).toBe("/sos-active?sosId=s1&deviceId=d1");
    expect(mockRouterPush).toHaveBeenCalledWith(target);
  });

  it("SOS 已结束（或进行中的是另一单）→ 事故详情", async () => {
    mockActive.mockResolvedValueOnce({
      sos: { sosId: "other", deviceId: "d1", status: "pending" },
    });
    expect(await landFromPush({ sosId: "s1", deviceId: "d1" })).toBe("/accident/s1");
    mockActive.mockResolvedValueOnce({ sos: null });
    expect(await landFromPush({ sosId: "s2", deviceId: "d1" })).toBe("/accident/s2");
  });

  it("查询失败也能落地到详情；没有 sosId 不跳", async () => {
    mockActive.mockRejectedValueOnce(new Error("offline"));
    expect(await landFromPush({ sosId: "s3", deviceId: "d1" })).toBe("/accident/s3");
    expect(await landFromPush({})).toBeNull();
  });

  it("只响应 notificationOpened，到达事件不跳转", async () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    const cb = openedListener();
    cb({ notificationEventType: "notificationArrived", extras: { sosId: "s1", deviceId: "d1" } });
    await Promise.resolve();
    expect(mockRouterPush).not.toHaveBeenCalled();
    mockActive.mockResolvedValueOnce({ sos: null });
    cb({ notificationEventType: "notificationOpened", extras: { sosId: "s1", deviceId: "d1" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRouterPush).toHaveBeenCalledWith("/accident/s1");
  });
});
