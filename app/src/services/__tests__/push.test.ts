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

import { presentedSos } from "@/services/sos-sync";
import { useConsentStore } from "@/stores/consent-store";

import {
  __resetPushForTests,
  landFromPush,
  extrasFromLaunchResponse,
  readPushConfig,
  setPushArrivalHandler,
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
  presentedSos.current.clear();
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
    // 登记为已拉起：随后的 WS 推送 / 冷启动补拉不会再 push 一页
    expect(presentedSos.current.has("s1")).toBe(true);
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

  it("查询失败 ≠ 已结束：进倒计时页（它自己拉权威状态），不落到没有取消键的事故详情", async () => {
    // 用户点的是「倒计时已开始」，刚唤醒的网络第一下不通——这时最可能的真实状态恰恰是 pending
    mockActive.mockRejectedValueOnce(new Error("offline"));
    expect(await landFromPush({ sosId: "s3", deviceId: "d1" })).toBe(
      "/sos-active?sosId=s3&deviceId=d1",
    );
  });

  it("extras 没带 deviceId：查不了 active，只能进事故详情（详情页对进行中的单有回倒计时页的按钮）；没有 sosId 不跳", async () => {
    expect(await landFromPush({ sosId: "s4" })).toBe("/accident/s4");
    expect(mockActive).not.toHaveBeenCalled();
    expect(presentedSos.current.has("s4")).toBe(false);
    expect(await landFromPush({})).toBeNull();
    expect(
      await landFromPush({ sosId: 42 as unknown as string, deviceId: "d1" }),
    ).toBeNull();
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

describe("远程推送到达（不是被点开）→ 触发一次补拉（前台 + WS 没连上时倒计时页的唯一来源）", () => {
  const boot = () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    return openedListener();
  };

  it("带 sosId 的到达事件交给注册的回调；不直接跳转（以 REST 为准，由补拉决定开不开页）", () => {
    const arrived = jest.fn();
    setPushArrivalHandler(arrived);
    boot()({
      notificationEventType: "notificationArrived",
      extras: { sosId: "s1", deviceId: "d1" },
    });
    expect(arrived).toHaveBeenCalledWith({ sosId: "s1", deviceId: "d1" });
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("没有 sosId 的到达事件（别的推送）/ extras 缺失：不回调", () => {
    const arrived = jest.fn();
    setPushArrivalHandler(arrived);
    const cb = boot();
    cb({ notificationEventType: "notificationArrived", extras: {} });
    cb({ notificationEventType: "notificationArrived" });
    expect(arrived).not.toHaveBeenCalled();
  });

  it("回调抛错不带崩监听；注销后不再回调", () => {
    setPushArrivalHandler(() => {
      throw new Error("boom");
    });
    const cb = boot();
    expect(() =>
      cb({
        notificationEventType: "notificationArrived",
        extras: { sosId: "s1" },
      }),
    ).not.toThrow();
    const arrived = jest.fn();
    setPushArrivalHandler(arrived);
    setPushArrivalHandler(null);
    cb({
      notificationEventType: "notificationArrived",
      extras: { sosId: "s1" },
    });
    expect(arrived).not.toHaveBeenCalled();
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

  it("点的是远程推送上的「我没事，取消」按钮：落地但不清这条启动点击——sos-alert 还要读它发取消", async () => {
    mockLastResponse.mockReturnValue({
      actionIdentifier: "cancel",
      ...launch({ sosId: "s8", deviceId: "d1" }),
    });
    mockActive.mockResolvedValue({ sos: null });
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u8");
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRouterPush).toHaveBeenCalledWith("/accident/s8");
    expect(mockClearLastResponse).not.toHaveBeenCalled();
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

describe("登出解绑别名也要等结果（断网登出 / 刚设完就被动登出时，已登出的手机不能继续收原账号的 SOS 推送）", () => {
  const lastDeleteSeq = () =>
    (mockDeleteAlias.mock.calls.at(-1)?.[0] as { sequence: number }).sequence;
  const bootAndSignOut = () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("u1");
    stopPush();
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("极光拒绝 → 3 s 后重发，再失败 10 s；成功后不再有动作", () => {
    bootAndSignOut();
    expect(mockDeleteAlias).toHaveBeenCalledTimes(1);
    const first = lastDeleteSeq();
    aliasListener?.({ code: 6002, sequence: first });
    jest.advanceTimersByTime(2_999);
    expect(mockDeleteAlias).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(mockDeleteAlias).toHaveBeenCalledTimes(2);
    expect(lastDeleteSeq()).not.toBe(first);
    aliasListener?.({ code: 6022, sequence: lastDeleteSeq() });
    jest.advanceTimersByTime(10_000);
    expect(mockDeleteAlias).toHaveBeenCalledTimes(3);
    aliasListener?.({ code: 0, sequence: lastDeleteSeq() });
    jest.advanceTimersByTime(300_000);
    expect(mockDeleteAlias).toHaveBeenCalledTimes(3);
  });

  it("重试有上限，不会无限打极光", () => {
    bootAndSignOut();
    for (let i = 0; i < 10; i++) {
      aliasListener?.({ code: 6002, sequence: lastDeleteSeq() });
      jest.advanceTimersByTime(60_000);
    }
    expect(mockDeleteAlias).toHaveBeenCalledTimes(5);
  });

  it("重试等待期间有人登录：不再解绑（新账号的 setAlias 说了算），迟到的失败结果也不触发", () => {
    bootAndSignOut();
    const seq = lastDeleteSeq();
    aliasListener?.({ code: 6002, sequence: seq });
    startPush("u2"); // 3 s 的重试定时器还没到
    jest.advanceTimersByTime(120_000);
    expect(mockDeleteAlias).toHaveBeenCalledTimes(1);
    expect(mockSetAlias).toHaveBeenLastCalledWith(
      expect.objectContaining({ alias: "u2" }),
    );
  });

  it("登出后立刻登录：解绑结果在登录之后才回来（失败）也不重发，别把新账号的别名删了", () => {
    bootAndSignOut();
    const seq = lastDeleteSeq();
    startPush("u2");
    const setSeq = (mockSetAlias.mock.calls.at(-1)?.[0] as { sequence: number })
      .sequence;
    aliasListener?.({ code: 0, sequence: setSeq, alias: "u2" }); // 排了 2 s 后的校验
    mockQueryAlias.mockClear();
    aliasListener?.({ code: 6002, sequence: seq }); // 迟到的解绑失败
    jest.advanceTimersByTime(2_000);
    // 新账号的别名校验不能被这条迟到的结果冲掉（两者共用一个定时器槽）
    expect(mockQueryAlias).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(120_000);
    expect(mockDeleteAlias).toHaveBeenCalledTimes(1);
  });

  it("解绑成功后不去 queryAlias 校验（别名不存在时 iOS 桥接层可能拿到 nil）", () => {
    bootAndSignOut();
    mockQueryAlias.mockClear();
    aliasListener?.({ code: 0, sequence: lastDeleteSeq() });
    jest.advanceTimersByTime(60_000);
    expect(mockQueryAlias).not.toHaveBeenCalled();
  });
});
