// 锁屏 SOS 提醒的边界补测（2026-10-16）。保命链路：只断言现状，不改行为。
// 「第一条通知没排上之后同一单再也不排」记在 EDGE_FINDINGS_1016.md A9；取消请求遇到 404 也照样重试三次记在 A10。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Alert, AppState, Platform } from "react-native";

type SosAlert = typeof import("../sos-alert");

const mockCancel = jest.fn(async (_id: string) => ({}) as never);
const mockSchedule = jest.fn(async (_req: unknown) => "id");
const mockCancelScheduled = jest.fn(async (_id: string) => undefined);
const mockDismiss = jest.fn(async (_id: string) => undefined);
const mockNavigate = jest.fn((_href: string) => undefined);
const mockPermissions = jest.fn(async (): Promise<unknown> => ({
  granted: true,
}));

jest.mock("@/api/sos", () => ({
  sosApi: { cancel: (id: string) => mockCancel(id) },
}));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), navigate: (h: string) => mockNavigate(h) },
}));
jest.mock("@/i18n", () => ({
  translate: (k: string, p?: Record<string, unknown>) =>
    p ? `${k}:${JSON.stringify(p)}` : k,
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: (req: unknown) => mockSchedule(req),
  cancelScheduledNotificationAsync: (id: string) => mockCancelScheduled(id),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
  getPresentedNotificationsAsync: async () => [],
  getPermissionsAsync: () => mockPermissions(),
  AndroidNotificationPriority: { MAX: "max" },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
}));

const originalOS = Platform.OS;
const originalState = AppState.currentState;
const originalAddListener = AppState.addEventListener;
const override = (obj: object, key: string, value: unknown): void => {
  Object.defineProperty(obj, key, {
    value,
    configurable: true,
    writable: true,
  });
};
const NOW = Date.UTC(2026, 9, 16, 10, 0, 0);
const deadlineIn = (seconds: number) =>
  new Date(NOW + seconds * 1000).toISOString();
const load = (): SosAlert => {
  let mod!: SosAlert;
  jest.isolateModules(() => {
    mod = jest.requireActual<SosAlert>("../sos-alert");
  });
  return mod;
};
type Req = {
  identifier: string;
  content: { title: string; body: string; data: unknown };
  trigger: unknown;
};
const reqs = () => mockSchedule.mock.calls.map((c) => c[0] as Req);

beforeEach(() => {
  mockCancel.mockReset();
  mockNavigate.mockClear();
  mockSchedule.mockReset();
  mockSchedule.mockResolvedValue("id");
  mockCancelScheduled.mockClear();
  mockDismiss.mockClear();
  override(Platform, "OS", "ios");
  override(AppState, "currentState", "background");
  override(AppState, "addEventListener", () => ({ remove: () => undefined }));
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  override(Platform, "OS", originalOS);
  override(AppState, "currentState", originalState);
  override(AppState, "addEventListener", originalAddListener);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("锁屏提醒的内容", () => {
  it("deadline 已经过了（迟到的推送）：仍立即弹一条，读秒写 0，不再排刷新", async () => {
    const m = load();
    await m.showSosAlertIfBackground("s1", "d1", deadlineIn(-5));
    expect(reqs()).toHaveLength(1);
    expect(reqs()[0].content.body).toBe('sosAlert.bodyCountdown:{"seconds":0}');
    await m.clearSosAlert("s1");
  });

  it("deadline 认不出：照弹，不写读秒、不排刷新", async () => {
    const m = load();
    await m.showSosAlertIfBackground("s1", "d1", "garbage");
    expect(reqs()).toHaveLength(1);
    expect(reqs()[0].content.body).toBe("sosAlert.body");
    await m.clearSosAlert("s1");
  });

  it("头盔名为空串：标题不带名字（当成不知道名字）", async () => {
    const m = load();
    await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60), undefined, "");
    expect(reqs()[0].content.title).toBe("sosAlert.title");
    await m.clearSosAlert("s1");
  });

  it("头盔名里有换行 / 零宽字符：原样带进标题（调用方已用 helmetNameOf 整理过）", async () => {
    const m = load();
    await m.showSosAlertIfBackground(
      "s1",
      "d1",
      deadlineIn(60),
      undefined,
      "我的 头盔",
    );
    expect(reqs()[0].content.title).toBe(
      'sosAlert.titleWithHelmet:{"name":"我的 头盔"}',
    );
    await m.clearSosAlert("s1");
  });

  it("在前台、或 inactive 以外的任何非 active 状态：只有 active 不弹", async () => {
    for (const state of ["inactive", "background", "unknown", "extension"]) {
      mockSchedule.mockClear();
      override(AppState, "currentState", state);
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
      expect({ state, n: reqs().length > 0 }).toEqual({ state, n: true });
      await m.clearSosAlert("s1");
    }
    mockSchedule.mockClear();
    override(AppState, "currentState", "active");
    const m = load();
    await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
    expect(reqs()).toHaveLength(0);
  });

  it("剩余时间是很大的数（服务端时钟和手机差很多）：两档刷新照排，不会排出负的延迟", async () => {
    const m = load();
    await m.showSosAlertIfBackground("s1", "d1", deadlineIn(3_600));
    const delays = reqs()
      .map((r) => (r.trigger as { seconds?: number } | null)?.seconds)
      .filter((x): x is number => typeof x === "number");
    expect(delays).toEqual([3_570, 3_590]);
    await m.clearSosAlert("s1");
  });
});

describe("排通知失败", () => {
  it("改后（10-16 A9）：第一条通知没排上（scheduleNotificationAsync 抛错）就把这一单从去重表里放掉——用户打开通知权限后 App 再离开前台会补弹", async () => {
    const m = load();
    mockSchedule.mockRejectedValueOnce(
      new Error("Notifications not permitted"),
    );
    await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    // 用户随后在系统设置里打开了通知、或刚才只是偶发失败；App 再次离开前台时补弹
    await m.showSosAlertIfBackground("s1", "d1", deadlineIn(50));
    expect(mockSchedule.mock.calls.length).toBeGreaterThan(1);
    await m.clearSosAlert("s1");
  });

  it("第一条排上了、后面的静默刷新没排上：这一单仍在去重表里（已经有通知在，不重复弹）", async () => {
    const m = load();
    mockSchedule
      .mockResolvedValueOnce("id-1")
      .mockRejectedValueOnce(new Error("quota"));
    await m.showSosAlertIfBackground("s1", "d1", deadlineIn(60));
    const n = mockSchedule.mock.calls.length;
    await m.showSosAlertIfBackground("s1", "d1", deadlineIn(50));
    expect(mockSchedule).toHaveBeenCalledTimes(n);
    await m.clearSosAlert("s1");
  });
});

describe("通知按钮「取消」遇到不可重试的错误", () => {
  it("改后（10-16 A10）：这单不存在 / 不是自己的（404）：不重试，撤掉通知、弹一句说明、不跳倒计时页", async () => {
    jest.useFakeTimers({ now: NOW });
    const alert = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);
    mockCancel.mockRejectedValue(
      Object.assign(new Error("404"), { code: "NOT_FOUND", status: 404 }),
    );
    const m = load();
    expect(await m.cancelFromNotification("s404", 0, "d1")).toBe(false);
    for (const ms of [2_000, 5_000, 10_000]) {
      await jest.advanceTimersByTimeAsync(ms);
    }
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe("sosAlert.cancelGoneTitle");
    expect(mockNavigate).not.toHaveBeenCalled();
    await m.resetSosAlerts();
  });

  it("403 同样不重试；500 仍按 2 / 5 / 10 秒重试三次", async () => {
    jest.useFakeTimers({ now: NOW });
    jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    mockCancel.mockRejectedValue(
      Object.assign(new Error("403"), { status: 403 }),
    );
    const m = load();
    await m.cancelFromNotification("s403", 0, "d1");
    for (const ms of [2_000, 5_000, 10_000])
      await jest.advanceTimersByTimeAsync(ms);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    mockCancel.mockRejectedValue(
      Object.assign(new Error("500"), { status: 500 }),
    );
    await m.cancelFromNotification("s500", 0, "d1");
    for (const ms of [2_000, 5_000, 10_000])
      await jest.advanceTimersByTimeAsync(ms);
    expect(mockCancel).toHaveBeenCalledTimes(1 + 4);
    await m.resetSosAlerts();
  });

  it("没有 deviceId 时重试用尽：只弹说明，不跳页（不知道是哪顶头盔）", async () => {
    jest.useFakeTimers({ now: NOW });
    jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    mockCancel.mockRejectedValue(new Error("offline"));
    const m = load();
    await m.cancelFromNotification("s1");
    for (const ms of [2_000, 5_000, 10_000])
      await jest.advanceTimersByTimeAsync(ms);
    expect(mockNavigate).not.toHaveBeenCalled();
    await m.resetSosAlerts();
  });
});

describe("通知权限查询", () => {
  it("granted / denied / undetermined / 查询抛错：只有明确拒绝才算被拒", async () => {
    const m = load();
    for (const [perm, denied] of [
      [{ granted: true, status: "granted" }, false],
      [{ granted: false, status: "denied" }, true],
      [{ granted: false, status: "undetermined" }, false],
      [{ granted: false }, true],
    ] as const) {
      mockPermissions.mockResolvedValueOnce(perm);
      expect(await m.isSosAlertPermissionDenied()).toBe(denied);
    }
    mockPermissions.mockRejectedValueOnce(new Error("boom"));
    expect(await m.isSosAlertPermissionDenied()).toBe(false);
  });
});
