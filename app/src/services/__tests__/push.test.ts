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
type AliasResult = { code: number; sequence: number; alias?: string };
let aliasListener: ((r: AliasResult) => void) | null = null;
const mockQueryAlias = jest.fn((_p: { sequence: number }) => undefined);
const mockRouterPush = jest.fn();
const mockActive = jest.fn(async (_deviceId: string) => ({
  sos: null as unknown,
}));
const mockSecure = new Map<string, string>();

jest.mock("jpush-react-native", () => ({
  __esModule: true,
  default: {
    init: (p: unknown) => mockInit(p),
    setAlias: (p: unknown) => mockSetAlias(p),
    deleteAlias: (p: unknown) => mockDeleteAlias(p),
    addNotificationListener: (cb: Listener) => mockAddNotificationListener(cb),
    addConnectEventListener: () => undefined,
    addTagAliasListener: (cb: (r: AliasResult) => void) => {
      aliasListener = cb;
    },
    queryAlias: (p: { sequence: number }) => mockQueryAlias(p),
    setLoggerEnable: () => undefined,
    getRegistrationID: (cb: (r: { registerID: string }) => void) =>
      cb({ registerID: "rid" }),
  },
}));
jest.mock("expo-router", () => ({
  router: { navigate: (h: string) => mockRouterPush(h) },
}));
jest.mock("@/api/sos", () => ({
  sosApi: { active: (d: string) => mockActive(d) },
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
const mockLastResponse = jest.fn((): unknown => null);
const mockClearLastResponse = jest.fn();
jest.mock("expo-notifications", () => ({
  getLastNotificationResponse: () => mockLastResponse(),
  clearLastNotificationResponse: () => mockClearLastResponse(),
}));
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
  extrasFromLaunchResponse,
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
      expect.objectContaining({
        appKey: "79cce150234ce38063213ccd",
        channel: "official",
      }),
    );
    expect(mockSetAlias).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "u1" }),
    );
  });

  it("已同意：立即 init，且监听先于 init 挂上", () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    expect(mockAddNotificationListener).toHaveBeenCalledTimes(1);
    expect(
      mockAddNotificationListener.mock.invocationCallOrder[0],
    ).toBeLessThan(mockInit.mock.invocationCallOrder[0]);
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
    expect(mockSetAlias).toHaveBeenLastCalledWith(
      expect.objectContaining({ alias: "u2" }),
    );
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
      expect.objectContaining({
        appKey: expect.stringMatching(/^[0-9a-f]{24}$/),
      }),
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
    expect(await landFromPush({ sosId: "s1", deviceId: "d1" })).toBe(
      "/accident/s1",
    );
    mockActive.mockResolvedValueOnce({ sos: null });
    expect(await landFromPush({ sosId: "s2", deviceId: "d1" })).toBe(
      "/accident/s2",
    );
  });

  it("查询失败也能落地到详情；没有 sosId 不跳", async () => {
    mockActive.mockRejectedValueOnce(new Error("offline"));
    expect(await landFromPush({ sosId: "s3", deviceId: "d1" })).toBe(
      "/accident/s3",
    );
    expect(await landFromPush({})).toBeNull();
  });

  it("只响应 notificationOpened，到达事件不跳转", async () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    const cb = openedListener();
    cb({
      notificationEventType: "notificationArrived",
      extras: { sosId: "s1", deviceId: "d1" },
    });
    await Promise.resolve();
    expect(mockRouterPush).not.toHaveBeenCalled();
    mockActive.mockResolvedValueOnce({ sos: null });
    cb({
      notificationEventType: "notificationOpened",
      extras: { sosId: "s1", deviceId: "d1" },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRouterPush).toHaveBeenCalledWith("/accident/s1");
  });
});

describe("冷启动由通知拉起（4.8：极光还没初始化时点击被 expo 收走）", () => {
  const launch = (payload: Record<string, unknown>, type = "push") => ({
    notification: { request: { trigger: { type, payload } } },
  });

  it("只认远程推送且带 sosId 的启动点击；本地通知 / 无 sosId / 空 → null", () => {
    expect(
      extrasFromLaunchResponse(
        launch({ sosId: "s1", deviceId: "d1" }) as never,
      ),
    ).toEqual({ sosId: "s1", deviceId: "d1" });
    expect(extrasFromLaunchResponse(launch({ sosId: "s1" }) as never)).toEqual({
      sosId: "s1",
      deviceId: undefined,
    });
    expect(
      extrasFromLaunchResponse(launch({ deviceId: "d1" }) as never),
    ).toBeNull();
    expect(
      extrasFromLaunchResponse(
        launch({ sosId: "s1" }, "timeInterval") as never,
      ),
    ).toBeNull();
    expect(extrasFromLaunchResponse(null)).toBeNull();
  });

  it("初始化时取回这次点击并落地：已到期的单进事故详情；用掉即清；同进程只处理一次", async () => {
    mockLastResponse.mockReturnValue(launch({ sosId: "s9", deviceId: "d1" }));
    mockActive.mockResolvedValue({ sos: null });
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRouterPush).toHaveBeenCalledWith("/accident/s9");
    expect(mockClearLastResponse).toHaveBeenCalledTimes(1);
    mockRouterPush.mockClear();
    startPush("u2"); // 换账号重新 start 不再重复落地
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRouterPush).not.toHaveBeenCalled();
    mockLastResponse.mockReturnValue(null);
  });

  it("不是由通知拉起（null）：什么都不做", async () => {
    mockLastResponse.mockReturnValue(null);
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(mockClearLastResponse).not.toHaveBeenCalled();
  });
});

describe("别名确认与重试（10-05 iPhone：别名丢了，被杀后推送静默失效）", () => {
  const lastSetSeq = () =>
    (mockSetAlias.mock.calls.at(-1)?.[0] as { sequence: number }).sequence;
  const lastQuerySeq = () =>
    (mockQueryAlias.mock.calls.at(-1)?.[0] as { sequence: number }).sequence;
  const boot = () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockQueryAlias.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("设置成功 → 2 s 后向服务端查一次；查到的就是自己 → 确认，不再有动作", () => {
    boot();
    aliasListener?.({ code: 0, sequence: lastSetSeq(), alias: "u1" });
    expect(mockQueryAlias).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2_000);
    expect(mockQueryAlias).toHaveBeenCalledTimes(1);
    aliasListener?.({ code: 0, sequence: lastQuerySeq(), alias: "u1" });
    jest.advanceTimersByTime(120_000);
    expect(mockSetAlias).toHaveBeenCalledTimes(1);
  });

  it("极光拒绝（操作太频繁等）→ 3 s 后重设，再失败 10 s，用新的 sequence", () => {
    boot();
    const first = lastSetSeq();
    aliasListener?.({ code: 6022, sequence: first });
    jest.advanceTimersByTime(2_999);
    expect(mockSetAlias).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(mockSetAlias).toHaveBeenCalledTimes(2);
    expect(lastSetSeq()).not.toBe(first);
    aliasListener?.({ code: 6002, sequence: lastSetSeq() });
    jest.advanceTimersByTime(10_000);
    expect(mockSetAlias).toHaveBeenCalledTimes(3);
  });

  it("设置成功但服务端查出来不是自己（被紧挨着的 deleteAlias 盖掉）→ 重设", () => {
    boot();
    aliasListener?.({ code: 0, sequence: lastSetSeq(), alias: "u1" });
    jest.advanceTimersByTime(2_000);
    aliasListener?.({ code: 0, sequence: lastQuerySeq(), alias: "" });
    jest.advanceTimersByTime(3_000);
    expect(mockSetAlias).toHaveBeenCalledTimes(2);
  });

  it("登出后迟到的结果与定时器都不再触发重设；旧 sequence 的结果被忽略", () => {
    boot();
    const seq = lastSetSeq();
    aliasListener?.({ code: 6022, sequence: seq });
    stopPush();
    jest.advanceTimersByTime(120_000);
    expect(mockSetAlias).toHaveBeenCalledTimes(1);
    aliasListener?.({ code: 6022, sequence: seq });
    aliasListener?.({ code: 0, sequence: 9999 });
    jest.advanceTimersByTime(120_000);
    expect(mockSetAlias).toHaveBeenCalledTimes(1);
  });

  it("重试有上限（3s/10s/30s/60s 后放弃），不会无限打极光", () => {
    boot();
    for (let i = 0; i < 10; i++) {
      aliasListener?.({ code: 6022, sequence: lastSetSeq() });
      jest.advanceTimersByTime(60_000);
    }
    expect(mockSetAlias).toHaveBeenCalledTimes(5);
  });
});
