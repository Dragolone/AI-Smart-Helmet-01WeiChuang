// 安卓 12 以下搜索蓝牙靠位置信息权限：没权限时各处提示要说「位置信息」，不然用户在系统设置里找不到要开的那一项
// （10-19 华为 P30 Pro 实测：拒绝定位后设备详情写「未授权蓝牙权限」）。安卓 12+ / iOS 仍说蓝牙。
import { afterEach, describe, expect, it } from "@jest/globals";
import { Platform } from "react-native";

import { bleNeedsLocationPermission } from "../ble-platform";
import { safetyTileOf } from "../device-home";
import { guideCards, type GuideFacts } from "../device-guide";
import { linkLabelKey } from "../safety-status";

const FACTS: GuideFacts = {
  link: null,
  notify: "undetermined",
  contacts: 0,
  slow: false,
};
const original = { OS: Platform.OS, Version: Platform.Version };
const asPlatform = (OS: string, Version: number | string) => {
  Object.defineProperty(Platform, "OS", { value: OS, configurable: true });
  Object.defineProperty(Platform, "Version", {
    value: Version,
    configurable: true,
  });
};
afterEach(() => asPlatform(original.OS, original.Version));

describe("bleNeedsLocationPermission", () => {
  it("安卓 API 29 / 30：要位置信息；API 31 起不要；iOS 不要；安卓上版本号不是数字时按不要处理", () => {
    asPlatform("android", 29);
    expect(bleNeedsLocationPermission()).toBe(true);
    asPlatform("android", 30);
    expect(bleNeedsLocationPermission()).toBe(true);
    asPlatform("android", 31);
    expect(bleNeedsLocationPermission()).toBe(false);
    asPlatform("android", 34);
    expect(bleNeedsLocationPermission()).toBe(false);
    asPlatform("ios", "18.0");
    expect(bleNeedsLocationPermission()).toBe(false);
    asPlatform("android", "29");
    expect(bleNeedsLocationPermission()).toBe(false);
  });
});

describe("没给权限时的文案跟着平台走", () => {
  it("安全页状态卡标题 / 设备页安全格：安卓 12 以下说位置信息", () => {
    asPlatform("android", 29);
    expect(linkLabelKey("bluetoothDenied")).toBe("safety.link.locationDenied");
    expect(safetyTileOf("linkDown", "bluetoothDenied").text).toBe(
      "safety.link.locationDenied",
    );
    // 别的连接结论不受影响
    expect(linkLabelKey("bluetoothOff")).toBe("safety.link.bluetoothOff");
  });

  it("安全页状态卡标题 / 设备页安全格：安卓 12+、iOS 仍说蓝牙", () => {
    asPlatform("android", 33);
    expect(linkLabelKey("bluetoothDenied")).toBe("safety.link.bluetoothDenied");
    expect(safetyTileOf("linkDown", "bluetoothDenied").text).toBe(
      "safety.link.bluetoothDenied",
    );
    asPlatform("ios", "18.0");
    expect(linkLabelKey("bluetoothDenied")).toBe("safety.link.bluetoothDenied");
  });

  it("三步指引第一张卡（绑定后没给权限）：安卓 12 以下标题、正文说位置信息，按钮仍是去 App 设置", () => {
    const facts = (over: Partial<GuideFacts>): GuideFacts => ({
      ...FACTS,
      ...over,
    });
    asPlatform("android", 29);
    const [loc] = guideCards(facts({ link: "bluetoothDenied" }));
    expect(loc.title).toBe("guide.helmet.locDeniedTitle");
    expect(loc.body).toEqual({ key: "guide.helmet.locDeniedBody" });
    expect(loc.primary?.action).toBe("openAppSettings");
    asPlatform("android", 31);
    const [bt] = guideCards(facts({ link: "bluetoothDenied" }));
    expect(bt.title).toBe("guide.helmet.btDeniedTitle");
    expect(bt.body).toEqual({ key: "guide.helmet.btDeniedBody" });
  });
});
