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
  title?: string;
  notificationId?: number;
}) => void;

const mockInit = jest.fn();
const mockClearById = jest.fn();
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
const mockActiveForAccount = jest.fn(async () => ({
  items: [] as { sosId: string; deviceId: string; deadline: string }[],
}));
const mockSecure = new Map<string, string>();

/** 原生模块没打进包（Expo Go / 旧 dev-client）：置真后 push.ts 取 default 就抛，同 require 失败 */
let mockNativeMissing = false;
/** getRegistrationID 回给 JS 的值：首次启动还没注册上时极光给空串 */
let mockRegistrationId = "rid";
let connectListener: ((r: { connectEnable: boolean }) => void) | null = null;
jest.mock("jpush-react-native", () => ({
  __esModule: true,
  get default() {
    if (mockNativeMissing) throw new Error("JPushModule is null");
    return {
      init: (p: unknown) => mockInit(p),
      setAlias: (p: unknown) => mockSetAlias(p),
      deleteAlias: (p: unknown) => mockDeleteAlias(p),
      addNotificationListener: (cb: Listener) =>
        mockAddNotificationListener(cb),
      addConnectEventListener: (
        cb: (r: { connectEnable: boolean }) => void,
      ) => {
        connectListener = cb;
      },
      addTagAliasListener: (cb: (r: AliasResult) => void) => {
        aliasListener = cb;
      },
      queryAlias: (p: { sequence: number }) => mockQueryAlias(p),
      clearNotificationById: (p: unknown) => mockClearById(p),
      setLoggerEnable: () => undefined,
      getRegistrationID: (cb: (r: { registerID: string }) => void) =>
        cb({ registerID: mockRegistrationId }),
    };
  },
}));
jest.mock("expo-router", () => ({
  router: { navigate: (h: string) => mockRouterPush(h) },
}));
jest.mock("@/api/sos", () => ({
  sosApi: {
    active: (d: string) => mockActive(d),
    activeForAccount: () => mockActiveForAccount(),
  },
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

import {
  SOS_START_PUSH_TITLE,
  clearSosStartPush,
} from "@/services/sos-start-push";
import { devLog } from "@/services/dev-log";
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
  connectListener = null;
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

  it("APNs 环境跟着 __DEV__ 走：调试包连 development，正式包（Release / TestFlight）连 production（标反了 iPhone 收不到远程推送）", () => {
    const g = globalThis as unknown as { __DEV__: boolean };
    const dev = g.__DEV__;
    try {
      useConsentStore.setState({ privacyAccepted: true });
      g.__DEV__ = true;
      startPush("u1");
      expect(mockInit).toHaveBeenLastCalledWith(
        expect.objectContaining({ production: false }),
      );
      __resetPushForTests();
      g.__DEV__ = false;
      startPush("u1");
      expect(mockInit).toHaveBeenLastCalledWith(
        expect.objectContaining({ production: true }),
      );
    } finally {
      g.__DEV__ = dev;
    }
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

  it("冷启动时同意标记还没从存储读出来：先挂起，日志写「在等读取」而不是「未同意」；读出来是未同意就接着等，勾选那一刻才初始化", () => {
    useConsentStore.setState({ privacyAccepted: false, hydrated: false });
    startPush("u1");
    expect(devLog).toHaveBeenCalledWith(
      "PUSH",
      "等同意标记读取完再决定是否初始化",
    );
    expect(devLog).not.toHaveBeenCalledWith(
      "PUSH",
      "未同意隐私政策，推送 SDK 暂不初始化",
    );
    useConsentStore.setState({ hydrated: true }); // 读出来了：这台设备上没同意过
    expect(mockInit).not.toHaveBeenCalled();
    useConsentStore.setState({ privacyAccepted: true });
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockSetAlias).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "u1" }),
    );
  });

  it("极光原生模块没打进包（Expo Go / 旧 dev-client，加载就抛）：登录照常不抛，不 init、不挂监听、不设别名；登出也不碰 SDK", () => {
    mockNativeMissing = true;
    try {
      useConsentStore.setState({ privacyAccepted: true });
      expect(() => startPush("u1")).not.toThrow();
      expect(devLog).toHaveBeenCalledWith(
        "PUSH",
        "极光原生模块不可用（需要重建原生包）",
        expect.any(Error),
      );
      expect(mockAddNotificationListener).not.toHaveBeenCalled();
      expect(mockInit).not.toHaveBeenCalled();
      expect(mockSetAlias).not.toHaveBeenCalled();
      expect(() => stopPush()).not.toThrow();
      expect(mockDeleteAlias).not.toHaveBeenCalled();
    } finally {
      mockNativeMissing = false;
    }
  });

  it("还没拿到 registrationID、极光连接断开 / 恢复：只记日志（真机排查靠它），不影响初始化和别名", () => {
    mockRegistrationId = "";
    try {
      useConsentStore.setState({ privacyAccepted: true });
      startPush("u1");
      expect(devLog).toHaveBeenCalledWith(
        "PUSH",
        "registrationID （尚未注册）",
      );
      connectListener?.({ connectEnable: false });
      expect(devLog).toHaveBeenCalledWith("PUSH", "极光连接 断");
      connectListener?.({ connectEnable: true });
      expect(devLog).toHaveBeenCalledWith("PUSH", "极光连接 上");
      expect(mockInit).toHaveBeenCalledTimes(1);
      expect(mockSetAlias).toHaveBeenCalledTimes(1);
    } finally {
      mockRegistrationId = "rid";
    }
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

  it("SOS 已结束、这顶头盔也没有别的单在倒数 → 事故详情", async () => {
    mockActive.mockResolvedValueOnce({ sos: null });
    expect(await landFromPush({ sosId: "s2", deviceId: "d1" })).toBe(
      "/accident/s2",
    );
    expect(presentedSos.current.has("s2")).toBe(false);
  });

  it("点的是旧单留下的推送、同一顶头盔有更新的一单在倒数 → 去那一单的倒计时，不把旧单的记录页压在倒计时上（4.27 加测，10-17 华为实测）", async () => {
    mockActive.mockResolvedValueOnce({
      sos: { sosId: "other", deviceId: "d1", status: "pending" },
    });
    expect(await landFromPush({ sosId: "s1", deviceId: "d1" })).toBe(
      "/sos-active?sosId=other&deviceId=d1",
    );
    // 登记的是正在倒数的那一单（随后的 WS 推送 / 补拉不再为它再拉一页）
    expect(presentedSos.current.has("other")).toBe(true);
    expect(presentedSos.current.has("s1")).toBe(false);
  });

  it("这顶头盔没有在倒数的单、账号下别的头盔有：去先到期的那一单的倒计时，不把这单的记录页压上去（10-17）", async () => {
    mockActive.mockResolvedValueOnce({ sos: null });
    mockActiveForAccount.mockResolvedValueOnce({
      items: [
        { sosId: "b2", deviceId: "d3", deadline: "2026-10-17T10:00:40.000Z" },
        { sosId: "b1", deviceId: "d2", deadline: "2026-10-17T10:00:20.000Z" },
      ],
    });
    expect(await landFromPush({ sosId: "a1", deviceId: "d1" })).toBe(
      "/sos-active?sosId=b1&deviceId=d2",
    );
    expect(presentedSos.current.has("b1")).toBe(true);
    expect(presentedSos.current.has("a1")).toBe(false);
  });

  it("账号级查询失败：照旧进这单的事故详情（兜底不能把人带错页）", async () => {
    mockActive.mockResolvedValueOnce({ sos: null });
    mockActiveForAccount.mockRejectedValueOnce(new Error("offline"));
    expect(await landFromPush({ sosId: "a2", deviceId: "d1" })).toBe(
      "/accident/a2",
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

  it("安卓：「倒计时已开始」到达时记下极光的通知编号（补丁带上来的），这单结束时按编号撤掉（O12）", () => {
    boot()({
      notificationEventType: "notificationArrived",
      extras: { sosId: "s1", deviceId: "d1" },
      title: SOS_START_PUSH_TITLE,
      notificationId: 501,
    });
    clearSosStartPush("s1");
    // 声明写的是字符串，原生按整数读：原样把数字交过去
    expect(mockClearById).toHaveBeenCalledWith({ notificationId: 501 });
  });

  it("没有 sosId 的到达事件（别的推送）/ extras 缺失：不回调", () => {
    const arrived = jest.fn();
    setPushArrivalHandler(arrived);
    const cb = boot();
    cb({ notificationEventType: "notificationArrived", extras: {} });
    cb({ notificationEventType: "notificationArrived" });
    expect(arrived).not.toHaveBeenCalled();
  });

  it("通知被划掉（安卓极光把 notificationDismissed 也发到同一个监听）：不跳页，也不当成「到达」去补拉", async () => {
    const arrived = jest.fn();
    setPushArrivalHandler(arrived);
    const cb = boot() as unknown as (r: {
      notificationEventType: string;
      extras?: Record<string, string>;
    }) => void;
    cb({
      notificationEventType: "notificationDismissed",
      extras: { sosId: "s1", deviceId: "d1" },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRouterPush).not.toHaveBeenCalled();
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

  it("校验时服务端给回的别名缺省（iOS 桥接层可能拿到 nil）：当作没设上，3 s 后重设", () => {
    boot();
    aliasListener?.({ code: 0, sequence: lastSetSeq(), alias: "u1" });
    jest.advanceTimersByTime(2_000);
    aliasListener?.({ code: 0, sequence: lastQuerySeq() });
    jest.advanceTimersByTime(3_000);
    expect(mockSetAlias).toHaveBeenCalledTimes(2);
    expect(mockSetAlias).toHaveBeenLastCalledWith(
      expect.objectContaining({ alias: "u1" }),
    );
  });

  it("校验时服务端的别名是别人的（上一个账号的设置后发先至）：当没设上，3 s 后重设自己的", () => {
    boot();
    aliasListener?.({ code: 0, sequence: lastSetSeq(), alias: "u1" });
    jest.advanceTimersByTime(2_000);
    aliasListener?.({ code: 0, sequence: lastQuerySeq(), alias: "u0" });
    jest.advanceTimersByTime(3_000);
    expect(mockSetAlias).toHaveBeenCalledTimes(2);
    expect(mockSetAlias).toHaveBeenLastCalledWith(
      expect.objectContaining({ alias: "u1" }),
    );
  });

  it("上一个账号把重试次数用光了：换账号登录后，新账号的别名照样有完整的一轮重试", () => {
    boot();
    for (let i = 0; i < 5; i++) {
      aliasListener?.({ code: 6022, sequence: lastSetSeq() });
      jest.advanceTimersByTime(60_000);
    }
    expect(mockSetAlias).toHaveBeenCalledTimes(5);
    startPush("u2");
    expect(mockSetAlias).toHaveBeenCalledTimes(6);
    aliasListener?.({ code: 6022, sequence: lastSetSeq() });
    jest.advanceTimersByTime(3_000);
    expect(mockSetAlias).toHaveBeenCalledTimes(7);
    expect(mockSetAlias).toHaveBeenLastCalledWith(
      expect.objectContaining({ alias: "u2" }),
    );
  });

  it("换账号后旧账号的设置结果才迟到（失败）：不替旧账号重设，也不冲掉新账号排好的校验", () => {
    boot();
    const oldSeq = lastSetSeq();
    startPush("u2");
    aliasListener?.({ code: 0, sequence: lastSetSeq(), alias: "u2" }); // 排了 2 s 后的校验
    aliasListener?.({ code: 6022, sequence: oldSeq }); // u1 那次迟到的失败
    jest.advanceTimersByTime(2_000);
    expect(mockQueryAlias).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(120_000);
    expect(
      mockSetAlias.mock.calls.map((c) => (c[0] as { alias: string }).alias),
    ).toEqual(["u1", "u2"]);
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

  it("上一次登出把解绑重试用光了：再登录、再登出时，解绑照样有完整的一轮重试", () => {
    bootAndSignOut();
    for (let i = 0; i < 5; i++) {
      aliasListener?.({ code: 6002, sequence: lastDeleteSeq() });
      jest.advanceTimersByTime(60_000);
    }
    expect(mockDeleteAlias).toHaveBeenCalledTimes(5);
    startPush("u2");
    stopPush();
    expect(mockDeleteAlias).toHaveBeenCalledTimes(6);
    aliasListener?.({ code: 6002, sequence: lastDeleteSeq() });
    jest.advanceTimersByTime(3_000);
    expect(mockDeleteAlias).toHaveBeenCalledTimes(7);
  });

  it("解绑成功后不去 queryAlias 校验（别名不存在时 iOS 桥接层可能拿到 nil）", () => {
    bootAndSignOut();
    mockQueryAlias.mockClear();
    aliasListener?.({ code: 0, sequence: lastDeleteSeq() });
    jest.advanceTimersByTime(60_000);
    expect(mockQueryAlias).not.toHaveBeenCalled();
  });
});
