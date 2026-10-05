// 低电量提醒：20/10 两档各提醒一次，充电或回升重置；前台 Toast、后台本地通知。
// 不整模块 mock react-native（见 map/__tests__/audit-nav-links.test.ts 顶部注释：
// 残缺的 react-native mock 会让 jest 在收尾时非零退出）——Platform.OS / AppState.currentState
// 按属性覆盖并在用例后还原。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { Mock } from "jest-mock";
import { AppState, Platform } from "react-native";

import { checkBatteryAlert, resetBatteryAlerts } from "../battery-alert";

const mockToast = jest.fn();
const mockSchedule = jest.fn(async (_req: unknown) => "notif-id");
const mockChannel = jest.fn(async (_id: unknown, _opts: unknown) => undefined);

jest.mock("@/components/toast", () => ({
  showToast: (m: string) => mockToast(m),
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("@/i18n", () => ({
  translate: (k: string, p?: Record<string, unknown>) =>
    `${k}:${p?.battery ?? ""}`,
}));
jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: (req: unknown) => mockSchedule(req),
  setNotificationChannelAsync: (id: unknown, opts: unknown) =>
    mockChannel(id, opts),
  AndroidImportance: { DEFAULT: 3 },
}));

const originalOS = Platform.OS;
const originalState = AppState.currentState;
const override = (obj: object, key: string, value: unknown): void => {
  Object.defineProperty(obj, key, {
    value,
    configurable: true,
    writable: true,
  });
};

const st = (battery: number | null, charging = false) => ({
  battery,
  charging,
});
/** 冲掉 checkBatteryAlert 内部 fire-and-forget 的通知链 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("checkBatteryAlert", () => {
  beforeEach(() => {
    resetBatteryAlerts();
    mockToast.mockClear();
    mockSchedule.mockClear();
    mockChannel.mockClear();
    override(Platform, "OS", "ios");
    override(AppState, "currentState", "active");
  });
  afterEach(() => {
    override(Platform, "OS", originalOS);
    override(AppState, "currentState", originalState);
  });

  it("fires once at 20 and once at 10, not on every heartbeat", () => {
    checkBatteryAlert("h1", "头盔", st(35));
    checkBatteryAlert("h1", "头盔", st(20));
    checkBatteryAlert("h1", "头盔", st(18));
    checkBatteryAlert("h1", "头盔", st(10));
    checkBatteryAlert("h1", "头盔", st(3));
    expect(mockToast.mock.calls.map((c) => c[0])).toEqual([
      "battery.lowBody:20",
      "battery.lowBody:10",
    ]);
  });

  it("re-arms after charging or recovering above 25", () => {
    checkBatteryAlert("h1", "头盔", st(15));
    checkBatteryAlert("h1", "头盔", st(15, true)); // 充电 → 重置
    checkBatteryAlert("h1", "头盔", st(15)); // 再提醒一次
    checkBatteryAlert("h1", "头盔", st(40)); // 回升 → 重置
    checkBatteryAlert("h1", "头盔", st(19));
    expect(mockToast).toHaveBeenCalledTimes(3);
  });

  it("21–25% 是回滞区间：既不提醒也不重置", () => {
    checkBatteryAlert("h1", "头盔", st(12)); // 先提醒过 10 档
    checkBatteryAlert("h1", "头盔", st(23)); // 回滞区：不提醒
    expect(mockToast).toHaveBeenCalledTimes(1);
    checkBatteryAlert("h1", "头盔", st(12)); // 也没被重置 → 不重复提醒
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it("tracks devices independently", () => {
    checkBatteryAlert("h1", "A", st(12));
    checkBatteryAlert("h2", "B", st(12));
    expect(mockToast).toHaveBeenCalledTimes(2);
    checkBatteryAlert("h1", "A", st(11));
    expect(mockToast).toHaveBeenCalledTimes(2);
  });

  it("uses a local notification when the app is not active", async () => {
    override(AppState, "currentState", "background");
    checkBatteryAlert("h1", "头盔", st(12));
    await flush();
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const req = mockSchedule.mock.calls[0][0] as {
      content: Record<string, unknown>;
    };
    expect(req.content.title).toBe("battery.lowTitle:");
    expect(req.content.body).toBe("battery.lowBody:12");
    // iOS 不带 channelId，也不建通道
    expect(req.content.channelId).toBeUndefined();
    expect((req as { trigger?: unknown }).trigger).toBeNull();
    expect(mockChannel).not.toHaveBeenCalled();
  });

  it("creates the Android channel once and tags the notification with it", async () => {
    override(Platform, "OS", "android");
    override(AppState, "currentState", "background");
    checkBatteryAlert("h1", "头盔", st(18));
    await flush();
    checkBatteryAlert("h2", "第二顶", st(9));
    await flush();
    expect(mockChannel).toHaveBeenCalledTimes(1);
    expect(mockChannel.mock.calls[0][0]).toBe("device");
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    const req = mockSchedule.mock.calls[0][0] as {
      content: Record<string, unknown>;
      trigger: unknown;
    };
    // 通道写在 trigger 里：Android 原生侧不读 content.channelId，trigger 为 null 会落到兜底通道
    expect(req.trigger).toEqual({ channelId: "device" });
    expect(req.content.channelId).toBeUndefined();
  });

  it("still notifies when the Android channel cannot be created", async () => {
    override(Platform, "OS", "android");
    override(AppState, "currentState", "background");
    (mockChannel as unknown as Mock<() => Promise<void>>).mockRejectedValueOnce(
      new Error("channel blocked"),
    );
    checkBatteryAlert("h1", "头盔", st(8));
    await flush();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it("swallows notification failures", async () => {
    override(AppState, "currentState", "background");
    (
      mockSchedule as unknown as Mock<() => Promise<string>>
    ).mockRejectedValueOnce(new Error("no permission"));
    expect(() => checkBatteryAlert("h1", "头盔", st(5))).not.toThrow();
    await flush();
  });

  it("ignores unknown battery", () => {
    checkBatteryAlert("h1", "头盔", st(null));
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});
