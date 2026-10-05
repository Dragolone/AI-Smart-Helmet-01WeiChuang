// 边界补测（2026-10-03）：锁屏 SOS 提醒的刷新档临界值与「取消」重试的收尾。
// sos-alert.test.ts 覆盖了 60 s / 12 s / 已过期三种剩余时间与 2 s、5 s 两次重试；
// 这里补刚好卡在 3 秒门槛上的剩余时间、重试用尽、以及重试期间用户再点一次。
// mock 口径同 sos-alert.test.ts（不整模块 mock react-native，按属性覆盖并还原）。
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { AppState, Platform } from "react-native";

type SosAlert = typeof import("../sos-alert");

const mockCancel = jest.fn(async (_id: string) => ({}) as never);
const mockSchedule = jest.fn(async (_req: unknown) => "id");
const mockCancelScheduled = jest.fn(async (_id: string) => undefined);
const mockDismiss = jest.fn(async (_id: string) => undefined);

jest.mock("@/api/sos", () => ({
  sosApi: { cancel: (id: string) => mockCancel(id) },
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/i18n", () => ({
  translate: (k: string, p?: Record<string, unknown>) =>
    p ? `${k}:${JSON.stringify(p)}` : k,
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: (req: unknown) => mockSchedule(req),
  cancelScheduledNotificationAsync: (id: string) => mockCancelScheduled(id),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
  AndroidNotificationPriority: { MAX: "max" },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
}));

const originalOS = Platform.OS;
const originalState = AppState.currentState;
const originalAddListener = AppState.addEventListener;
const override = (obj: object, key: string, value: unknown): void => {
  Object.defineProperty(obj, key, { value, configurable: true, writable: true });
};

const NOW = Date.UTC(2026, 9, 3, 10, 0, 0);
const deadlineIn = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

const load = (): SosAlert => {
  let mod!: SosAlert;
  jest.isolateModules(() => {
    mod = require("../sos-alert") as SosAlert;
  });
  return mod;
};

type Req = { identifier: string; content: { body: string }; trigger: { seconds: number } | null };
/** [identifier, 触发延迟秒（立即 = null）] */
const scheduled = (): [string, number | null][] =>
  mockSchedule.mock.calls.map((c) => {
    const r = c[0] as Req;
    return [r.identifier, r.trigger?.seconds ?? null];
  });

/** AppState 监听的假件：记录当前挂着几个监听，可手动触发 */
function fakeAppStateListeners(): { fire: (s: string) => void; active: () => number } {
  const listeners = new Set<(s: string) => void>();
  override(AppState, "addEventListener", (_: string, cb: (s: string) => void) => {
    listeners.add(cb);
    return { remove: () => listeners.delete(cb) };
  });
  return {
    fire: (s) => [...listeners].forEach((cb) => cb(s)),
    active: () => listeners.size,
  };
}

beforeEach(() => {
  mockCancel.mockReset();
  mockSchedule.mockClear();
  mockCancelScheduled.mockClear();
  mockDismiss.mockClear();
  override(Platform, "OS", "ios");
  override(AppState, "currentState", "background");
});
afterEach(() => {
  override(Platform, "OS", originalOS);
  override(AppState, "currentState", originalState);
  override(AppState, "addEventListener", originalAddListener);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("刷新档的 3 秒门槛（剩余时间由服务端 deadline 与本机时钟相减）", () => {
  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });

  it.each([
    [33, [["sos-s1", null], ["sos-s1", 3], ["sos-s1-10", 23]]],
    [32, [["sos-s1", null], ["sos-s1-10", 22]]],
    [13, [["sos-s1", null], ["sos-s1-10", 3]]],
    [12, [["sos-s1", null]]],
  ] as [number, [string, number | null][]][])(
    "剩余 %i 秒 → 排出的通知恰好是 %j",
    async (remaining, expected) => {
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", deadlineIn(remaining));
      expect(scheduled()).toEqual(expected);
    },
  );

  it("30 秒档被跳过时，结束后仍要撤掉单独编号的 10 秒档（不留一条迟到的「还剩 10 秒」）", async () => {
    const m = load();
    await m.showSosAlertIfBackground("s1", "d1", deadlineIn(32));
    await m.clearSosAlert("s1");
    expect(mockCancelScheduled.mock.calls.map((c) => c[0])).toEqual(["sos-s1", "sos-s1-10"]);
  });

  it("剩余时间带小数：首条正文四舍五入到整秒（59.4 → 59，59.5 → 60）", async () => {
    const body = async (ms: number) => {
      mockSchedule.mockClear();
      const m = load();
      await m.showSosAlertIfBackground("s1", "d1", new Date(NOW + ms).toISOString());
      return (mockSchedule.mock.calls[0][0] as Req).content.body;
    };
    expect(await body(59_400)).toBe('sosAlert.bodyCountdown:{"seconds":59}');
    expect(await body(59_500)).toBe('sosAlert.bodyCountdown:{"seconds":60}');
  });
});

describe("通知按钮「取消」的重试收尾", () => {
  it("一直失败：首次 + 2 s / 5 s / 10 s 三次重试共 4 次后放弃，不再留定时器和前台监听", async () => {
    jest.useFakeTimers();
    const appState = fakeAppStateListeners();
    mockCancel.mockRejectedValue(new Error("offline"));
    const m = load();
    expect(await m.cancelFromNotification("s1")).toBe(false);
    await jest.advanceTimersByTimeAsync(2_000);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockCancel).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(mockCancel).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockCancel).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(0);
    expect(appState.active()).toBe(0);
    // 放弃之后回前台也不会再偷偷重试
    appState.fire("active");
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockCancel).toHaveBeenCalledTimes(4);
  });

  it("重试等待期间用户又点了一次「取消」：旧的重试链被顶掉，不会两条链各自重试", async () => {
    jest.useFakeTimers();
    const appState = fakeAppStateListeners();
    mockCancel.mockRejectedValue(new Error("offline"));
    const m = load();
    await m.cancelFromNotification("s1");
    await jest.advanceTimersByTimeAsync(1_000);
    await m.cancelFromNotification("s1"); // 第二次点击，从头计
    expect(mockCancel).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1);
    expect(appState.active()).toBe(1);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(mockCancel).toHaveBeenCalledTimes(2); // 第一条链原定的 2 s 点已作废
    await jest.advanceTimersByTimeAsync(1);
    expect(mockCancel).toHaveBeenCalledTimes(3);
  });

  it("回前台触发的重试与定时器不会各打一次：前台先到则定时器作废", async () => {
    jest.useFakeTimers();
    const appState = fakeAppStateListeners();
    mockCancel
      .mockRejectedValueOnce(new Error("suspended"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValue({} as never);
    const m = load();
    await m.cancelFromNotification("s1");
    appState.fire("inactive"); // 非 active 的状态变化不触发
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    appState.fire("active");
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCancel).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2_000); // 原 2 s 定时器已被清，此刻不应再打
    expect(mockCancel).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(3_000); // 第二次失败后排的是 5 s
    expect(mockCancel).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
    expect(appState.active()).toBe(0);
  });
});
