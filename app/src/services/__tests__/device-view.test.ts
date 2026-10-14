// 设备详情页的显示推导：蓝牙行与在线状态分开、重试入口的条件不变、回执只挂在被改的那一项上。
import { describe, expect, it } from "@jest/globals";

import {
  bleRowOf,
  commandTouches,
  isBatteryLow,
  LOW_BATTERY,
} from "../device-view";

describe("bleRowOf", () => {
  it("手机这边的原因优先：蓝牙关着 / 没权限 / 不支持，各自给对应的入口", () => {
    expect(bleRowOf("off", "disconnected")).toEqual({
      state: "off",
      action: "bluetoothSettings",
    });
    expect(bleRowOf("unauthorized", "idle")).toEqual({
      state: "unauthorized",
      action: "appSettings",
    });
    expect(bleRowOf("unsupported", undefined)).toEqual({
      state: "unsupported",
      action: null,
    });
  });

  it("连着：没有入口，不多说", () => {
    expect(bleRowOf("on", "connected")).toEqual({
      state: "connected",
      action: null,
    });
  });

  it("没连上且蓝牙开着：可以重试（搜索中、连接中、掉线、身份不符都一样）", () => {
    for (const phase of [
      "scanning",
      "connecting",
      "handshaking",
      "disconnected",
      "error",
      "idle",
    ] as const) {
      expect(bleRowOf("on", phase)).toEqual({ state: phase, action: "retry" });
    }
  });

  it("本机对这顶头盔没有链路记录：显示未启用，没有可重试的对象", () => {
    expect(bleRowOf("on", undefined)).toEqual({ state: "idle", action: null });
  });

  it("蓝牙状态还没确定时不给重试（与改版前条件一致：只有确定开着才给）", () => {
    expect(bleRowOf("unknown", "scanning")).toEqual({
      state: "scanning",
      action: null,
    });
  });
});

describe("isBatteryLow", () => {
  it("≤ 20% 算低；没有读数不算低", () => {
    expect(LOW_BATTERY).toBe(20);
    expect(isBatteryLow(20)).toBe(true);
    expect(isBatteryLow(3)).toBe(true);
    expect(isBatteryLow(21)).toBe(false);
    expect(isBatteryLow(null)).toBe(false);
    expect(isBatteryLow(undefined)).toBe(false);
  });
});

describe("commandTouches", () => {
  it("回执只挂在这条命令改过的项上", () => {
    const cmd = { params: { light: 2 } };
    expect(commandTouches(cmd, "light")).toBe(true);
    expect(commandTouches(cmd, "volume")).toBe(false);
  });

  it("一条命令改了多项时，每一项都算", () => {
    const cmd = { params: { radar: true, radarDistance: 20 } };
    expect(commandTouches(cmd, "radar")).toBe(true);
    expect(commandTouches(cmd, "radarDistance")).toBe(true);
  });

  it("没有命令、或 params 不是预期的形状时，都不算", () => {
    expect(commandTouches(null, "light")).toBe(false);
    expect(commandTouches(undefined, "light")).toBe(false);
    expect(commandTouches({ params: undefined as never }, "light")).toBe(false);
    // 原型链上的名字不算设置项
    expect(commandTouches({ params: {} }, "toString")).toBe(false);
  });
});
