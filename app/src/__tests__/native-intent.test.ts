// 外部链接：倒计时页在屏上时不跳走，求救页自己的链接照常；平时原样放行
import { afterEach, describe, expect, it } from "@jest/globals";

import { redirectSystemPath } from "@/app/+native-intent";
import { sosScreen } from "@/services/sos-queue";

afterEach(() => {
  sosScreen.counting = false;
  sosScreen.mounted = false;
});

describe("+native-intent redirectSystemPath", () => {
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
