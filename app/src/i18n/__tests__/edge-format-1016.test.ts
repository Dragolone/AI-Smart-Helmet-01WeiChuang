// 时间 / 里程格式的边界补测（2026-10-16）。format.test.ts / edge-format.test.ts 已钉相对时间整秒档位、
// 认不出的时间戳、shortTime 的午夜；这里补跨年、闰日、未来时间、时间戳 0、日期标题的今天 / 昨天跨年跨夏令时、
// 月份标题与周首字、完整日期时间的午夜、里程四舍五入的边。
// 时刻一律用本地时间构造：换时区跑（CI 是 UTC，本机是悉尼）断言都成立。
import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { useLocaleStore } from "../index";
import {
  dateMaybeYear,
  dayTitle,
  formatKm,
  fullDateTime,
  monthTitle,
  relativeTime,
  sameLocalDay,
  shortDate,
  timeWithDateIfNotToday,
  weekdayInitials,
} from "../format";

const LOCALES = ["zh-CN", "zh-TW", "en"] as const;
const local = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0) =>
  new Date(y, m, d, h, mi, s, ms);
const iso = (d: Date) => d.toISOString();
const freezeAt = (d: Date) =>
  jest.spyOn(Date, "now").mockReturnValue(d.getTime());

afterEach(() => {
  jest.restoreAllMocks();
});

describe("relativeTime：未来、时间戳 0、跨年", () => {
  it("时间在未来（头盔 / 手机时钟快了）一律写「刚刚」，不出负数——快一年也一样（现状）", () => {
    const now = local(2026, 9, 16, 12);
    freezeAt(now);
    for (const ahead of [1, 60_000, 86_400_000, 365 * 86_400_000]) {
      for (const loc of LOCALES) {
        const out = relativeTime(iso(new Date(now.getTime() + ahead)), loc);
        expect(out).toBe(relativeTime(iso(now), loc));
        expect(out).not.toMatch(/-/);
      }
    }
  });

  it("时间戳 0（未校时的头盔）：不是「从未」，按一个多月以前写日期，带年份", () => {
    freezeAt(local(2026, 9, 16, 12));
    const zero = new Date(0).toISOString();
    for (const loc of LOCALES) {
      const out = relativeTime(zero, loc);
      expect(out).not.toBe(relativeTime(null, loc));
      expect(out).toMatch(/19(69|70)/);
    }
  });

  it("29 天 23 小时 59 分 59 秒还写天数；整 30 天起写日期（三种语言同一条线）", () => {
    const now = local(2026, 9, 16, 12);
    freezeAt(now);
    const justUnder = iso(new Date(now.getTime() - (30 * 86_400_000 - 1_000)));
    const at30 = iso(new Date(now.getTime() - 30 * 86_400_000));
    expect(relativeTime(justUnder, "zh-CN")).toBe("29 天前");
    expect(relativeTime(justUnder, "zh-TW")).toBe("29 天前");
    expect(relativeTime(justUnder, "en")).toBe("29 d ago");
    for (const loc of LOCALES) {
      expect(relativeTime(at30, loc)).toBe(dateMaybeYear(at30, loc));
    }
  });

  it("一月初看去年十二月的（超过 30 天）：带年份，不会被读成今年十二月", () => {
    freezeAt(local(2027, 0, 20, 9));
    const lastDec = iso(local(2026, 11, 10, 9));
    expect(relativeTime(lastDec, "zh-CN")).toBe("2026年12月10日");
    expect(relativeTime(lastDec, "en")).toBe("Dec 10, 2026");
  });

  it("不传语言时跟着 App 当前语言走", () => {
    freezeAt(local(2026, 9, 16, 12));
    const prev = useLocaleStore.getState().locale;
    try {
      useLocaleStore.setState({ locale: "en" });
      expect(relativeTime(iso(local(2026, 9, 16, 10)))).toBe("2 h ago");
      expect(relativeTime(null)).toBe("Never");
      useLocaleStore.setState({ locale: "zh-TW" });
      expect(relativeTime(iso(local(2026, 9, 16, 10)))).toBe("2 小時前");
    } finally {
      useLocaleStore.setState({ locale: prev });
    }
  });

  it("纯空白、只有日期没有时间的写法：前者按从未，后者照常算", () => {
    freezeAt(local(2026, 9, 16, 12));
    expect(relativeTime("   ", "zh-CN")).toBe("从未");
    // 只有日期按 UTC 零点解析，离此刻至多两天，落在天数档或小时档
    expect(relativeTime("2026-10-15", "zh-CN")).toMatch(/^\d+ (天|小时)前$/);
  });
});

describe("dateMaybeYear：今年与否以「此刻」所在的年为准", () => {
  it("12 月 31 日 23:59 看当年 1 月 1 日：不带年份；跨过零点到次年再看：带年份", () => {
    const jan1 = iso(local(2026, 0, 1, 8));
    freezeAt(local(2026, 11, 31, 23, 59, 59));
    expect(dateMaybeYear(jan1, "zh-CN")).toBe("1月1日");
    expect(dateMaybeYear(jan1, "en")).toBe("Jan 1");
    jest.restoreAllMocks();
    freezeAt(local(2027, 0, 1, 0, 0, 1));
    expect(dateMaybeYear(jan1, "zh-CN")).toBe("2026年1月1日");
    expect(dateMaybeYear(jan1, "zh-TW")).toBe("2026年1月1日");
    expect(dateMaybeYear(jan1, "en")).toBe("Jan 1, 2026");
  });

  it("认不出的时间给占位符，不抛", () => {
    for (const loc of LOCALES) {
      expect(dateMaybeYear("nope", loc)).toBe("—");
      expect(dateMaybeYear("", loc)).toBe("—");
    }
  });
});

describe("sameLocalDay 的边", () => {
  it("同一天的 00:00:00.000 与 23:59:59.999 算同一天；差 1 毫秒跨过零点就不是", () => {
    expect(
      sameLocalDay(
        iso(local(2026, 9, 16)),
        iso(local(2026, 9, 16, 23, 59, 59, 999)),
      ),
    ).toBe(true);
    expect(
      sameLocalDay(
        iso(local(2026, 9, 16, 23, 59, 59, 999)),
        iso(local(2026, 9, 17)),
      ),
    ).toBe(false);
  });

  it("跨年的 12 月 31 日与 1 月 1 日不是同一天；同月同日不同年也不是", () => {
    expect(
      sameLocalDay(iso(local(2026, 11, 31, 12)), iso(local(2027, 0, 1, 12))),
    ).toBe(false);
    expect(
      sameLocalDay(iso(local(2025, 9, 16, 12)), iso(local(2026, 9, 16, 12))),
    ).toBe(false);
  });

  it("两个都认不出：按同一天（不额外加「次日」）", () => {
    expect(sameLocalDay("x", "y")).toBe(true);
    expect(sameLocalDay(iso(local(2026, 9, 16)), "")).toBe(true);
  });
});

describe("shortDate：闰日与年末", () => {
  it("2024 年 2 月 29 日照常显示；12 月 31 日不回绕", () => {
    const leap = iso(local(2024, 1, 29, 12));
    expect(shortDate(leap, "zh-CN")).toBe("2月29日");
    expect(shortDate(leap, "en")).toBe("Feb 29");
    expect(shortDate(iso(local(2026, 11, 31, 23, 59)), "zh-TW")).toBe(
      "12月31日",
    );
  });
});

describe("fullDateTime：精确写法", () => {
  it("本地零点写 00 点而不是 24 点；三种语言的完整写法", () => {
    const at = iso(local(2026, 9, 3, 0, 5, 7));
    expect(fullDateTime(at, "zh-CN")).toBe("2026年10月3日 00:05:07");
    expect(fullDateTime(at, "zh-TW")).toBe("2026年10月3日 00:05:07");
    expect(fullDateTime(at, "en")).toBe("Oct 3, 2026, 00:05:07");
  });

  it("23:59:59 不进位到第二天", () => {
    expect(fullDateTime(iso(local(2026, 11, 31, 23, 59, 59, 999)), "en")).toBe(
      "Dec 31, 2026, 23:59:59",
    );
  });

  it("空串、时间戳写成数字字符串以外的乱码：占位符", () => {
    for (const loc of LOCALES) {
      expect(fullDateTime("", loc)).toBe("—");
      expect(fullDateTime("2026-02-30T25:00:00Z", loc)).toBe("—");
    }
  });
});

describe("dayTitle：今天 / 昨天按本地日历日", () => {
  it("今天零点的行程，在今天 23:59 看仍是「今天」；昨天 23:59 的，在今天 00:01 看是「昨天」", () => {
    freezeAt(local(2026, 9, 16, 23, 59));
    expect(dayTitle(iso(local(2026, 9, 16, 0, 0)), "zh-CN")).toBe("今天");
    jest.restoreAllMocks();
    freezeAt(local(2026, 9, 16, 0, 1));
    expect(dayTitle(iso(local(2026, 9, 15, 23, 59)), "zh-CN")).toBe("昨天");
    expect(dayTitle(iso(local(2026, 9, 15, 23, 59)), "en")).toBe("Yesterday");
    expect(dayTitle(iso(local(2026, 9, 15, 23, 59)), "zh-TW")).toBe("昨天");
  });

  it("跨年：1 月 1 日看 12 月 31 日是「昨天」；看 12 月 30 日写日期 + 星期并带上年份", () => {
    freezeAt(local(2027, 0, 1, 9));
    expect(dayTitle(iso(local(2026, 11, 31, 20)), "zh-CN")).toBe("昨天");
    expect(dayTitle(iso(local(2026, 11, 30, 20)), "zh-CN")).toBe(
      "2026年12月30日 周三",
    );
    expect(dayTitle(iso(local(2026, 11, 30, 20)), "en")).toBe(
      "Wed, Dec 30, 2026",
    );
  });

  it("夏令时切换后的第一天（悉尼 2026-10-04）：前一天仍是「昨天」，再往前是日期", () => {
    freezeAt(local(2026, 9, 5, 0, 30));
    expect(dayTitle(iso(local(2026, 9, 4, 12)), "zh-CN")).toBe("昨天");
    expect(dayTitle(iso(local(2026, 9, 3, 12)), "zh-CN")).toBe("10月3日 周六");
  });

  it("未来的日子（头盔时钟快了一天）：不写「今天」「昨天」，写日期", () => {
    freezeAt(local(2026, 9, 16, 9));
    expect(dayTitle(iso(local(2026, 9, 17, 9)), "zh-CN")).toBe("10月17日 周六");
  });

  it("认不出的时间：占位符", () => {
    for (const loc of LOCALES) expect(dayTitle("nope", loc)).toBe("—");
  });
});

describe("monthTitle / weekdayInitials", () => {
  it("1 月与 12 月；三种语言的写法", () => {
    expect(monthTitle(2026, 0, "zh-CN")).toBe("2026年1月");
    expect(monthTitle(2026, 11, "zh-TW")).toBe("2026年12月");
    expect(monthTitle(2026, 11, "en")).toBe("December 2026");
  });

  it("月份越界由 Date 进位（12 → 次年 1 月，-1 → 上一年 12 月）：调用方只传 0–11（现状）", () => {
    expect(monthTitle(2026, 12, "zh-CN")).toBe("2027年1月");
    expect(monthTitle(2026, -1, "en")).toBe("December 2025");
  });

  it("周一起的七个首字", () => {
    expect(weekdayInitials("zh-CN")).toEqual([
      "一",
      "二",
      "三",
      "四",
      "五",
      "六",
      "日",
    ]);
    expect(weekdayInitials("zh-TW")).toEqual([
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
});

describe("timeWithDateIfNotToday 的边", () => {
  it("今天 00:00 只写时间；昨天 23:59 带日期；明天的也带日期", () => {
    freezeAt(local(2026, 9, 16, 12));
    expect(timeWithDateIfNotToday(iso(local(2026, 9, 16, 0, 0)), "zh-CN")).toBe(
      "00:00",
    );
    expect(
      timeWithDateIfNotToday(iso(local(2026, 9, 15, 23, 59)), "zh-CN"),
    ).toBe("10月15日 23:59");
    expect(timeWithDateIfNotToday(iso(local(2026, 9, 17, 8, 0)), "en")).toBe(
      "Oct 17 08:00",
    );
  });

  it("去年的今天：月日相同也带日期（年份不同不算今天）", () => {
    freezeAt(local(2026, 9, 16, 12));
    expect(timeWithDateIfNotToday(iso(local(2025, 9, 16, 8, 0)), "zh-CN")).toBe(
      "10月16日 08:00",
    );
  });
});

describe("formatKm：四舍五入与非正常值", () => {
  it("50 米起显示 0.1；49 米是 0.0；950 米进到 1.0", () => {
    expect(formatKm(49)).toBe("0.0");
    expect(formatKm(50)).toBe("0.1");
    expect(formatKm(949)).toBe("0.9");
    expect(formatKm(950)).toBe("1.0");
  });

  it("负数、负零、正负无穷都按 0.0，不出「-0.0」「Infinity」", () => {
    for (const bad of [
      -1,
      -40,
      -0,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(formatKm(bad)).toBe("0.0");
    }
  });

  it("恰好 1000 km 是整数「1000」；很大的里程也是不带小数、不带科学计数法的整数", () => {
    expect(formatKm(1_000_000)).toBe("1000");
    expect(formatKm(1_000_000_000)).toBe("1000000");
    expect(formatKm(123_456_789)).toBe("123457");
  });

  it("不到一米的零头不影响：0.4 米是 0.0", () => {
    expect(formatKm(0.4)).toBe("0.0");
  });
});
