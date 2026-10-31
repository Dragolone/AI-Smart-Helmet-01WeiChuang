// 外部链接：倒计时页在屏上时不跳走，求救页自己的链接照常；平时原样放行
import { afterEach, describe, expect, it } from "@jest/globals";

import { redirectSystemPath } from "@/app/+native-intent";
import { sosScreen } from "@/services/sos-queue";

afterEach(() => {
  sosScreen.counting = false;
  sosScreen.mounted = false;
});

describe("+native-intent redirectSystemPath", () => {
  it("工程模式不接外部链接：一打开就会停掉蓝牙中转（站内导航不走这里）", () => {
    for (const path of [
      "lingyizhixing://ble-bench",
      "/ble-bench?deviceId=helmet_1",
    ]) {
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
      expect(redirectSystemPath({ path, initial: true })).toBeNull();
    }
  });

  it("真单倒数中的演练链接不跳：演练页会盖在真单上、写着不会通知任何人（11-01）", () => {
    sosScreen.counting = true;
    for (const path of [
      "lingyizhixing://sos-active?drill=1",
      "/sos-active?a=1&drill=1",
      "/sos-active?drill=1&b=2",
    ])
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
    // 不在倒数时演练入口照常
    sosScreen.counting = false;
    expect(
      redirectSystemPath({ path: "/sos-active?drill=1", initial: false }),
    ).toBe("/sos-active?drill=1");
  });

  it("没有在倒数（没有倒计时页，或已到结果页）：任何链接原样放行（含冷启动）", () => {
    sosScreen.mounted = true; // 结果页还在屏上，但已不在倒数
    for (const path of [
      "lingyizhixing://device/helmet_1",
      "/map",
      "lingyizhixing://video-preview?ssid=x",
    ]) {
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
      expect(redirectSystemPath({ path, initial: true })).toBe(path);
    }
  });

  it("倒计时页上还在倒数：别的链接不跳（留在倒计时页）；求救页自己的链接照常", () => {
    sosScreen.counting = true;
    for (const path of [
      "lingyizhixing://device/helmet_1",
      "lingyizhixing://map",
      "/contacts",
      "lingyizhixing://safety-records?only=sos-active-x",
    ]) {
      expect(redirectSystemPath({ path, initial: false })).toBeNull();
    }
    for (const path of [
      "lingyizhixing://sos-active?sosId=s2",
      "/sos-active",
      "lingyizhixing://sos-active",
    ]) {
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
    }
  });
});
