// 时间格式化口径（各页共用）：相对时间的四个档位边界 + 短日期/短时间按语言切换。
// 用固定时刻控制"现在"，避免跨秒抖动。
import { afterEach, describe, expect, it, jest } from "@jest/globals";

import {
  formatKm,
  fullDateTime,
  relativeTime,
  shortDate,
  shortTime,
  timeWithDateIfNotToday,
} from "../format";

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);
const agoIso = (seconds: number) =>
  new Date(NOW - seconds * 1000).toISOString();
const freeze = () => jest.spyOn(Date, "now").mockReturnValue(NOW);

afterEach(() => {
  jest.restoreAllMocks();
});

describe("relativeTime", () => {
  it("没有时间戳时给「从未」而不是空白", () => {
    expect(relativeTime(null, "zh-CN")).toBe("从未");
  });

  it("45 秒内算「刚刚」，45 秒起进分钟档", () => {
    freeze();
    expect(relativeTime(agoIso(0), "zh-CN")).toBe("刚刚");
    expect(relativeTime(agoIso(44), "zh-CN")).toBe("刚刚");
    // 45–59 秒仍不足 1 分钟，按 1 分钟显示（不出现「0 分钟前」）
    expect(relativeTime(agoIso(45), "zh-CN")).toBe("1 分钟前");
    expect(relativeTime(agoIso(59), "zh-CN")).toBe("1 分钟前");
  });

  it("分钟 / 小时 / 天三档的边界", () => {
    freeze();
    expect(relativeTime(agoIso(60), "zh-CN")).toBe("1 分钟前");
    expect(relativeTime(agoIso(3599), "zh-CN")).toBe("59 分钟前");
    expect(relativeTime(agoIso(3600), "zh-CN")).toBe("1 小时前");
    expect(relativeTime(agoIso(86399), "zh-CN")).toBe("23 小时前");
    expect(relativeTime(agoIso(86400), "zh-CN")).toBe("1 天前");
    expect(relativeTime(agoIso(86400 * 9), "zh-CN")).toBe("9 天前");
  });

  it("设备时钟快于服务器时不显示负数", () => {
    freeze();
    expect(relativeTime(new Date(NOW + 60_000).toISOString(), "zh-CN")).toBe(
      "刚刚",
    );
  });

  it("跟随语言", () => {
    freeze();
    expect(relativeTime(agoIso(7200), "en")).toBe("2 h ago");
    expect(relativeTime(agoIso(7200), "zh-TW")).toBe("2 小時前");
  });
});

describe("shortDate / shortTime", () => {
  const iso = "2026-09-17T08:31:00Z";
  it("短日期按语言切换", () => {
    expect(shortDate(iso, "en")).toMatch(/Sep\s*17/);
    expect(shortDate(iso, "zh-CN")).toMatch(/9.*17/);
  });

  it("短时间一律 24 小时制、补零", () => {
    for (const loc of ["zh-CN", "zh-TW", "en"] as const) {
      expect(shortTime(iso, loc)).toMatch(/^\d{2}:\d{2}$/);
    }
    // 只校验格式：分钟数随时区偏移（印度等半小时时区）会变，不做字面断言
    expect(shortTime("2026-09-17T00:05:00Z", "zh-CN")).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("fullDateTime", () => {
  const iso = "2026-09-17T08:31:05Z";
  it("带年份和秒：一年前的记录不会和今年的同一天混淆", () => {
    for (const loc of ["zh-CN", "zh-TW", "en"] as const) {
      const out = fullDateTime(iso, loc);
      expect(out).toContain("2026");
      expect(out).toMatch(/\d{2}:\d{2}:05/);
    }
  });

  it("认不出的时间戳给占位符，不把页面带崩", () => {
    expect(fullDateTime("not-a-date", "zh-CN")).toBe("—");
  });
});

describe("timeWithDateIfNotToday", () => {
  it("当天的只给时间", () => {
    freeze();
    expect(timeWithDateIfNotToday(agoIso(60), "zh-CN")).toMatch(
      /^\d{2}:\d{2}$/,
    );
  });

  it("不是当天的带上日期：几周前的「已生效」不会被读成今天", () => {
    freeze();
    const old = timeWithDateIfNotToday(agoIso(86400 * 20), "zh-CN");
    expect(old).toMatch(/\d{2}:\d{2}$/);
    expect(old).toMatch(/8.*28/);
  });

  it("认不出的时间给占位符", () => {
    expect(timeWithDateIfNotToday("nope", "en")).toBe("—");
  });
});

describe("formatKm（里程数字，单位另显示）", () => {
  it("1000 km 以下一位小数；以上取整，免得统计卡把「6547.4」截成「65…」（10-07 华为 3.1）", () => {
    expect(formatKm(0)).toBe("0.0");
    expect(formatKm(129_740)).toBe("129.7");
    expect(formatKm(999_949)).toBe("999.9");
    // 999.95–999.99 km：toFixed(1) 会进位成六个字符的「1000.0」，同样被截断
    expect(formatKm(999_950)).toBe("1000");
    expect(formatKm(999_999)).toBe("1000");
    expect(formatKm(6_547_400)).toBe("6547");
    expect(formatKm(Number.NaN)).toBe("0.0");
  });
});
