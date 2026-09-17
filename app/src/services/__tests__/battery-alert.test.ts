// 低电量提醒阈值：20/10 各一次，充电或回升重置；前台走 Toast、后台走本地通知
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { checkBatteryAlert, resetBatteryAlerts } from "../battery-alert";

const mockToast = jest.fn();
const mockSchedule = jest.fn(async (_req: unknown) => "id");
const mockState = { current: "active" };
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
  setNotificationChannelAsync: jest.fn(async () => undefined),
  AndroidImportance: { DEFAULT: 3 },
}));
jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    get currentState() {
      return mockState.current;
    },
  },
}));

const st = (battery: number | null, charging = false) => ({
  battery,
  charging,
});

describe("checkBatteryAlert", () => {
  beforeEach(() => {
    resetBatteryAlerts();
    mockToast.mockClear();
    mockSchedule.mockClear();
    mockState.current = "active";
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
    checkBatteryAlert("h1", "头盔", st(15, true));
    checkBatteryAlert("h1", "头盔", st(15));
    checkBatteryAlert("h1", "头盔", st(40));
    checkBatteryAlert("h1", "头盔", st(19));
    expect(mockToast).toHaveBeenCalledTimes(3);
  });

  it("uses a local notification when the app is not active", async () => {
    mockState.current = "background";
    checkBatteryAlert("h1", "头盔", st(12));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown battery", () => {
    checkBatteryAlert("h1", "头盔", st(null));
    expect(mockToast).not.toHaveBeenCalled();
  });
});
