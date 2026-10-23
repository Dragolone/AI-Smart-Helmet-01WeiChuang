// 2026-10-24：安卓 Hermes 的 Intl.DateTimeFormat 不认传入的 locale、按系统语言输出（App 固定简体中文，系统 en-US 时
// 安全记录写「今天 · Oct 24」、fr-FR 写「24 oct.」）。日期 / 时间 / 星期 / 月份改为查表拼写，这里把
// Intl.DateTimeFormat 整个换成一个只会吐系统写法的假货，断言输出仍按 App 的语言来——谁把 Intl 加回去就会在这里挂。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import {
  dateMaybeYear,
  dayTitle,
  fullDateTime,
  monthTitle,
  shortDate,
  shortTime,
  timeWithDateIfNotToday,
  weekdayInitials,
} from "../format";

const local = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, m, d, h, mi, s).toISOString();

const realIntl = globalThis.Intl;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(2026, 9, 24, 9, 0, 0));
  // 假 Intl：无论传什么 locale 都按英文系统写法输出（模拟安卓 Hermes 的行为）
  const fake = function () {
    return {
      format: () => "Oct 24",
      resolvedOptions: () => ({ locale: "en-US", timeZone: "UTC" }),
    };
  } as unknown as typeof Intl.DateTimeFormat;
  (globalThis as { Intl: typeof Intl }).Intl = {
    ...realIntl,
    DateTimeFormat: fake,
  } as typeof Intl;
});
afterEach(() => {
  (globalThis as { Intl: typeof Intl }).Intl = realIntl;
  jest.useRealTimers();
});

describe("日期格式不依赖 Intl 的 locale（安卓 Hermes 按系统语言输出的坑）", () => {
  it("简体 / 繁体 / 英文各自的写法，不受假 Intl 影响", () => {
    const at = local(2026, 9, 24, 0, 15, 8);
    expect(shortDate(at, "zh-CN")).toBe("10月24日");
    expect(shortDate(at, "zh-TW")).toBe("10月24日");
    expect(shortDate(at, "en")).toBe("Oct 24");
    expect(shortTime(at, "zh-CN")).toBe("00:15");
    expect(shortTime(at, "en")).toBe("00:15");
    expect(fullDateTime(at, "zh-CN")).toBe("2026年10月24日 00:15:08");
    expect(fullDateTime(at, "zh-TW")).toBe("2026年10月24日 00:15:08");
    expect(fullDateTime(at, "en")).toBe("Oct 24, 2026, 00:15:08");
  });

  it("带年份的日期与星期：去年 / 跨年", () => {
    const lastYear = local(2025, 11, 30, 20);
    expect(dateMaybeYear(lastYear, "zh-CN")).toBe("2025年12月30日");
    expect(dateMaybeYear(lastYear, "en")).toBe("Dec 30, 2025");
    expect(dayTitle(lastYear, "zh-CN")).toBe("2025年12月30日 周二");
    expect(dayTitle(lastYear, "zh-TW")).toBe("2025年12月30日 週二");
    expect(dayTitle(lastYear, "en")).toBe("Tue, Dec 30, 2025");
    expect(dayTitle(local(2026, 9, 17, 9), "zh-CN")).toBe("10月17日 周六");
    expect(dayTitle(local(2026, 9, 24, 1), "en")).toBe("Today");
    expect(dayTitle(local(2026, 9, 23, 23), "zh-CN")).toBe("昨天");
  });

  it("月历标题与周一起的首字", () => {
    expect(monthTitle(2026, 9, "zh-CN")).toBe("2026年10月");
    expect(monthTitle(2026, 9, "zh-TW")).toBe("2026年10月");
    expect(monthTitle(2026, 9, "en")).toBe("October 2026");
    expect(monthTitle(2026, 12, "en")).toBe("January 2027");
    expect(weekdayInitials("zh-CN")).toEqual([
      "一",
      "二",
      "三",
      "四",
      "五",
      "六",
      "日",
    ]);
    expect(weekdayInitials("en")).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
  });

  it("不是今天的带日期：9月17日 08:31 / Sep 17 08:31", () => {
    const at = local(2026, 8, 17, 8, 31);
    expect(timeWithDateIfNotToday(at, "zh-CN")).toBe("9月17日 08:31");
    expect(timeWithDateIfNotToday(at, "en")).toBe("Sep 17 08:31");
    expect(timeWithDateIfNotToday(local(2026, 9, 24, 8, 31), "en")).toBe(
      "08:31",
    );
  });
});
