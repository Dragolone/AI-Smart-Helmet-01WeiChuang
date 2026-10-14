// 设备页大图的「样子」：开屏画的替身和页面上真的那一份都照它来，所以规则要守住
import { describe, expect, it, jest } from "@jest/globals";
import type { DevicePublic } from "@helmet/shared";

import { BATTERY_TOP, HELMET_BOX, heroSplashOf } from "../hero-splash";

// 头盔图是图片资源，这里只要认得出「用的是按设备号取的那一张」
jest.mock("@/constants/helmet-images", () => ({ helmetImageFor: () => 7 }));

const device = (over: Partial<DevicePublic> = {}) =>
  ({
    deviceId: "helmet_x",
    name: "通勤头盔",
    battery: 78,
    charging: false,
    online: true,
    ...over,
  }) as DevicePublic;
// 颜色只要互不相同、能认出是哪一个就行（真的那套在 constants/theme，它带着样式表，这里不引）
const theme = {
  text: "#FFFFFF",
  textSecondary: "#9BA1AA",
  background: "#0B0C0E",
  backgroundElement: "#151619",
  backgroundSelected: "#1F2126",
  borderStrong: "rgba(255, 255, 255, 0.24)",
  success: "#4ADE80",
  warning: "#F5B84A",
} as Parameters<typeof heroSplashOf>[0]["theme"];
const of = (
  d: DevicePublic,
  link: Parameters<typeof heroSplashOf>[0]["link"],
) =>
  heroSplashOf({
    device: d,
    link,
    theme,
    dark: true,
    t: (k) => k,
    glowRadius: 200,
  });

describe("设备页大图的样子", () => {
  it("连着、电量够：绿色的环和光晕，白色的数字", () => {
    const h = of(device(), "connected");
    expect(h.linked).toBe(true);
    expect(h.arc).toBe(theme.success);
    expect(h.glow).toEqual({ radius: 200, alpha: 0.32, mid: 0.32 / 3 });
    expect(h.valueColor).toBe(theme.text);
    expect(h.label).toBe("devices.battery");
    expect(h.value).toBe("78");
    expect(h.unit).toBe("%");
  });

  it("服务端在线也算连着", () => {
    expect(of(device(), "online").linked).toBe(true);
  });

  it("电量 20 及以下：环、光晕、数字和小标题都变成提醒色", () => {
    const h = of(device({ battery: 20 }), "connected");
    expect(h.arc).toBe(theme.warning);
    expect(h.valueColor).toBe(theme.warning);
    expect(h.labelColor).toBe(theme.warning);
    expect(h.label).toBe("devices.batteryLow");
    expect(of(device({ battery: 21 }), "connected").arc).toBe(theme.success);
  });

  it("充电中写「充电中」", () => {
    expect(of(device({ charging: true }), "connected").label).toBe(
      "devices.charging",
    );
  });

  it("没连上：灰色的环、不发光，写的是上次电量（哪怕电量很低也不亮提醒色）", () => {
    for (const link of [
      "searching",
      "offline",
      "bluetoothOff",
      "unknown",
    ] as const) {
      const h = of(device({ battery: 12 }), link);
      expect(h.linked).toBe(false);
      expect(h.arc).toBe(theme.textSecondary);
      expect(h.glow).toBeNull();
      expect(h.label).toBe("devices.batteryLast");
      expect(h.valueColor).toBe(theme.textSecondary);
      expect(h.labelColor).toBe(theme.textSecondary);
    }
  });

  it("没有电量数据：只画底环，数字位置是一横", () => {
    const h = of(device({ battery: null }), "connected");
    expect(h.battery).toBeNull();
    expect(h.value).toBe("—");
    expect(h.unit).toBe("");
  });

  it("头盔图和电量那一行的位置，页面和替身用同一组数", () => {
    const h = of(device(), "connected");
    expect(h.imageBox).toBe(HELMET_BOX);
    expect(h.batteryTop).toBe(BATTERY_TOP);
    expect(h.image).toBe(7);
  });
});
