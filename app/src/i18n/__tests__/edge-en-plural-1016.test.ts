// 英文文案里「数字 + 复数名词」在数字是 1 时不通（2026-10-16 第二轮边界测试）：
// 字典没有单复数，「{n} devices」在只绑一顶头盔时写成「1 devices」，「{n} contacts」写成「1 contacts」，
// 刚建的频道只有自己一个人时写「1 members」——这些恰好是最常见的情形。
// 改成「Devices: {n}」这种标签写法（中文本来就是「联系人 {n} 位」这样排），或沿用字典里已有的「(s)」写法。
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import { translate, type MessageKey } from "../index";

const en = (key: MessageKey, params: Record<string, number>) =>
  translate(key, params, "en");

describe("数字是 1 时英文读得通", () => {
  it("只绑一顶头盔、一个联系人、频道里只有自己：不出现 1 devices / 1 contacts / 1 members", () => {
    const shown = [
      en("profile.devicesCount", { n: 1 }),
      en("safety.check.contacts", { n: 1 }),
      en("intercom.memberTotal", { n: 1 }),
      en("intercom.more.lead", { n: 1 }),
      en("map.ride.moreEvents", { n: 1 }),
    ];
    for (const s of shown) expect(s).not.toMatch(/\b1 [a-z]+s\b/);
    expect(shown).toEqual([
      "Devices: 1",
      "Contacts: 1",
      "Members: 1",
      "Members: 1 · Up to 20",
      "1 more event(s) not shown",
    ]);
  });

  it("多个时同样通顺", () => {
    expect(en("profile.devicesCount", { n: 3 })).toBe("Devices: 3");
    expect(en("intercom.memberTotal", { n: 12 })).toBe("Members: 12");
  });

  it("行程分组的趟数同样用标签写法：「Rides: 1 · …」，不写成「Rides 1」（10-15 / 10-17 华为英文界面）", () => {
    expect(en("map.rides.daySum", { n: 1, km: 238.6 })).toBe(
      "Rides: 1 · 238.6 km",
    );
    expect(translate("map.rides.daySum", { n: 1, km: 238.6 }, "zh-CN")).toBe(
      "1 趟 · 238.6 km",
    );
  });

  it("地图四格里的「上次电量」和设备页同一写法：「Last battery level」在格子里放不下（10-17 模拟器截成「Last battery le…」）", () => {
    expect(translate("map.batteryLast", {}, "en")).toBe("Last battery");
    expect(translate("map.batteryLast", {}, "en")).toBe(
      translate("devices.batteryLast", {}, "en"),
    );
  });

  it("求救记录的「通知已启动」英文写短：原来的「Notifications started」在 360dp 宽的列表里把标题挤成「Manu…」、头盔名只剩「…」（10-17 模拟器）", () => {
    expect(translate("safety.status.notified", {}, "en")).toBe(
      "Alerts started",
    );
  });

  it("月历底部的月份小结同样是「Rides: n」，且不再写「This month ·」：月份就在上面的标题里，原来在 360dp 宽里把里程挤成「2326…」（10-17 华为）", () => {
    expect(translate("map.rides.monthSum", { n: 9, km: 2326.4 }, "en")).toBe(
      "Rides: 9 · 2326.4 km",
    );
  });

  it("摔倒求救的英文标题和「Manual SOS」一样不带「· SOS」：在求救记录列表里放不下，原来截成「Possible fall ·…」（10-17 华为）", () => {
    expect(translate("records.sos.fall", {}, "en")).toBe("Possible fall");
  });

  it("中文写法不变", () => {
    expect(translate("profile.devicesCount", { n: 1 }, "zh-CN")).toBe(
      "1 台设备",
    );
    expect(translate("safety.check.contacts", { n: 1 }, "zh-CN")).toBe(
      "联系人 1 位",
    );
  });
});

describe("守护：英文字典里「{占位} 复数名词」只留数字不会是 1 的几处", () => {
  // 这几处的数字由代码保证不会是 1：
  // - sos.lateEvent*：sos-age 只在 5 分钟以上按分钟、90 分钟起按小时（≥ 2）才写；
  // - sosAlert.bodyCountdown：锁屏提醒只在剩 30 / 10 秒时刷新（sos-alert REFRESH_AT）。
  const ALLOWED = new Set([
    "sos.lateEventMinutes",
    "sos.lateEventHours",
    "sosAlert.bodyCountdown",
  ]);
  const DIR = join(__dirname, "..", "messages");
  const entries = readdirSync(DIR)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => {
      const dict = Object.values(require(join(DIR, f)))[0] as {
        en: Record<string, string>;
      };
      return Object.entries(dict.en);
    });

  it("新加的英文文案别再写「{n} things」——要么标签写法，要么 (s)", () => {
    // 只看数量类占位（{name} is … 这类不是数量）
    const plural =
      /\{(?:n|count|seconds|minutes|hours|m|h|total|max)\} (?:[a-z]+ )*[a-z]+s\b(?!\))/;
    const hits = entries
      .filter(([key, text]) => plural.test(text) && !ALLOWED.has(key))
      .map(([key, text]) => `${key}: ${text}`);
    expect(hits).toEqual([]);
  });
});
