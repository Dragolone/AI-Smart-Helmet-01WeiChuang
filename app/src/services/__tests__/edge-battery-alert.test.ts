// 边界补测（2026-10-03）：低电量提醒的阈值临界点与异常读数。
// battery-alert.test.ts 测了 20 / 18 / 10 / 3 与 23、40；这里补恰好在线上的 21 / 25 / 26、
// 一步跌穿两档、读数缺失，以及登出重置。mock 口径与 battery-alert.test.ts 相同。
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { AppState } from "react-native";

import { checkBatteryAlert, resetBatteryAlerts } from "../battery-alert";

const mockToast = jest.fn();
jest.mock("@/components/toast", () => ({
  showToast: (m: string) => mockToast(m),
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("@/i18n", () => ({
  translate: (k: string, p?: Record<string, unknown>) => `${k}:${p?.battery ?? ""}`,
}));
jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: jest.fn(async () => "id"),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  AndroidImportance: { DEFAULT: 3 },
}));

const originalState = AppState.currentState;
const setAppState = (value: string): void => {
  Object.defineProperty(AppState, "currentState", { value, configurable: true, writable: true });
};
const st = (battery: number | null | undefined, charging = false) =>
  ({ battery, charging }) as { battery: number | null; charging: boolean };
const toasts = () => mockToast.mock.calls.map((c) => c[0]);

beforeEach(() => {
  resetBatteryAlerts();
  mockToast.mockClear();
  setAppState("active");
});
afterEach(() => {
  setAppState(originalState);
});

describe("checkBatteryAlert 阈值临界", () => {
  it("21% 不提醒，20% 才提醒；11% 不触发第二档，10% 才触发", () => {
    checkBatteryAlert("h1", "头盔", st(21));
    expect(toasts()).toEqual([]);
    checkBatteryAlert("h1", "头盔", st(20));
    checkBatteryAlert("h1", "头盔", st(11));
    expect(toasts()).toEqual(["battery.lowBody:20"]);
    checkBatteryAlert("h1", "头盔", st(10));
    expect(toasts()).toEqual(["battery.lowBody:20", "battery.lowBody:10"]);
  });

  it("回升到恰好 25% 还在回滞区（不重置）；26% 才重置，之后再跌破会重新提醒", () => {
    checkBatteryAlert("h1", "头盔", st(15));
    checkBatteryAlert("h1", "头盔", st(25));
    checkBatteryAlert("h1", "头盔", st(15));
    expect(mockToast).toHaveBeenCalledTimes(1);
    checkBatteryAlert("h1", "头盔", st(26));
    checkBatteryAlert("h1", "头盔", st(15));
    expect(mockToast).toHaveBeenCalledTimes(2);
  });

  it("一步从 35% 掉到 5%（长时间离线后首个心跳）：只提醒一次且是 10% 档；之后在 20% 以内波动不补提醒", () => {
    checkBatteryAlert("h1", "头盔", st(35));
    checkBatteryAlert("h1", "头盔", st(5));
    checkBatteryAlert("h1", "头盔", st(15));
    checkBatteryAlert("h1", "头盔", st(20));
    checkBatteryAlert("h1", "头盔", st(0));
    expect(toasts()).toEqual(["battery.lowBody:5"]);
  });

  it("电量 0% 也照常提醒（不被当成「没有读数」）", () => {
    checkBatteryAlert("h1", "头盔", st(0));
    expect(toasts()).toEqual(["battery.lowBody:0"]);
  });

  it("读数缺失（undefined）或 NaN：不提醒、不抛，也不清掉已有的提醒记录", () => {
    checkBatteryAlert("h1", "头盔", st(15));
    expect(() => checkBatteryAlert("h1", "头盔", st(undefined))).not.toThrow();
    expect(() => checkBatteryAlert("h1", "头盔", st(NaN))).not.toThrow();
    checkBatteryAlert("h1", "头盔", st(14));
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it("充电中即使电量很低也不提醒；拔掉充电器仍低于阈值才提醒", () => {
    checkBatteryAlert("h1", "头盔", st(3, true));
    expect(mockToast).not.toHaveBeenCalled();
    checkBatteryAlert("h1", "头盔", st(3, false));
    expect(toasts()).toEqual(["battery.lowBody:3"]);
  });

  it("登出重置后，同一台设备同样的电量要重新提醒（新账号没看到过上一条）", () => {
    checkBatteryAlert("h1", "头盔", st(8));
    checkBatteryAlert("h1", "头盔", st(8));
    expect(mockToast).toHaveBeenCalledTimes(1);
    resetBatteryAlerts();
    checkBatteryAlert("h1", "头盔", st(8));
    expect(mockToast).toHaveBeenCalledTimes(2);
  });
});
