// 边界补测（2026-10-03）：文案插值与时间格式的边角。format.test.ts 钉了相对时间四档的整秒边界；
// 这里补插值的缺参 / 特殊字符、带时区偏移的时间戳、不足一秒的零头，以及手机号脱敏。
import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { maskPhone } from "@/api/auth";
import { translate } from "../index";
import { relativeTime, shortDate, shortTime } from "../format";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const freeze = () => jest.spyOn(Date, "now").mockReturnValue(NOW);

afterEach(() => {
  jest.restoreAllMocks();
});

describe("translate 插值", () => {
  it("参数值为 0 照常显示（不被当成缺参）；缺参时保留占位符原样，不显示 undefined", () => {
    expect(translate("common.minutesAgo", { n: 0 }, "zh-CN")).toBe("0 分钟前");
    expect(translate("common.minutesAgo", {}, "zh-CN")).toBe("{n} 分钟前");
    expect(translate("common.minutesAgo", { other: 1 }, "zh-CN")).toBe("{n} 分钟前");
  });

  it("参数值里的 $& / $1 / {n} 都按字面量输出，不被当成替换模式或二次插值", () => {
    expect(translate("error.unknown", { code: "$&" }, "zh-CN")).toContain("$&");
    expect(translate("error.unknown", { code: "$1" }, "zh-CN")).toContain("$1");
    expect(translate("error.unknown", { code: "{code}" }, "zh-CN")).toContain("{code}");
  });

  it("不带参数调用带占位符的文案：返回模板本身，不抛", () => {
    expect(translate("common.minutesAgo", undefined, "en")).toContain("{n}");
  });

  it("三种语言对同一 key 都返回非空字符串且互不相同（没有静默回落到简体）", () => {
    const all = (["zh-CN", "zh-TW", "en"] as const).map((l) => translate("common.justNow", undefined, l));
    expect(new Set(all).size).toBe(3);
    for (const s of all) expect(s.length).toBeGreaterThan(0);
  });
});

describe("relativeTime 的输入形态", () => {
  it("带时区偏移的写法与 Z 写法指向同一时刻时结果相同", () => {
    freeze();
    // NOW 之前 2 小时：10:00Z = 18:00+08:00 = 05:00-05:00
    for (const iso of ["2026-10-03T10:00:00Z", "2026-10-03T18:00:00+08:00", "2026-10-03T05:00:00.000-05:00"]) {
      expect(relativeTime(iso, "zh-CN")).toBe("2 小时前");
    }
  });

  it("不足一秒的零头向下取整：44.999 秒仍是「刚刚」，59 分 59.9 秒仍是「59 分钟前」", () => {
    freeze();
    expect(relativeTime(new Date(NOW - 44_999).toISOString(), "zh-CN")).toBe("刚刚");
    expect(relativeTime(new Date(NOW - 3_599_900).toISOString(), "zh-CN")).toBe("59 分钟前");
  });

  it("很久以前（两年）只按天数累加，不换成月 / 年", () => {
    freeze();
    expect(relativeTime(new Date(NOW - 730 * 86_400_000).toISOString(), "zh-CN")).toBe("730 天前");
  });

  it("空串与 null 同样按「从未」处理", () => {
    expect(relativeTime("", "zh-CN")).toBe(relativeTime(null, "zh-CN"));
  });

  it("认不出的时间戳按「从未」处理，不显示「NaN 天前」", () => {
    freeze();
    for (const bad of ["garbage", "2026-13-45T99:99:99Z", "Invalid Date"]) {
      for (const loc of ["zh-CN", "zh-TW", "en"] as const) {
        const text = relativeTime(bad, loc);
        expect(text).toBe(relativeTime(null, loc));
        expect(text).not.toContain("NaN");
      }
    }
  });
});

describe("shortDate / shortTime 遇到认不出的时间戳", () => {
  it("给占位符而不是抛 RangeError（Intl 对 Invalid Date 会直接抛，整页跟着崩）", () => {
    for (const bad of ["garbage", "", "2026-13-45T99:99:99Z"]) {
      for (const loc of ["zh-CN", "zh-TW", "en"] as const) {
        expect(shortDate(bad, loc)).toBe("—");
        expect(shortTime(bad, loc)).toBe("—");
      }
    }
  });

  it("合法时间戳不受影响：日期里有日、时间是 HH:mm", () => {
    const iso = new Date(2026, 9, 3, 8, 31, 0).toISOString();
    expect(shortDate(iso, "zh-CN")).toContain("3");
    expect(shortTime(iso, "zh-CN")).toBe("08:31");
  });
});

describe("shortTime", () => {
  it("本地午夜显示 00:xx 而不是 24:xx（en 语言下 hour12:false 的常见坑）", () => {
    const localMidnight = new Date(2026, 9, 3, 0, 5, 0).toISOString();
    for (const loc of ["zh-CN", "zh-TW", "en"] as const) {
      expect(shortTime(localMidnight, loc)).toBe("00:05");
    }
  });

  it("本地 23:59 与正午：小时不回绕、不带上下午标记", () => {
    expect(shortTime(new Date(2026, 9, 3, 23, 59, 0).toISOString(), "en")).toBe("23:59");
    expect(shortTime(new Date(2026, 9, 3, 12, 0, 0).toISOString(), "en")).toBe("12:00");
  });
});

describe("maskPhone", () => {
  it("11 位手机号只露前 3 后 4；空值显示占位符；不是 11 位的原样返回", () => {
    expect(maskPhone("13812345678")).toBe("138****5678");
    expect(maskPhone(null)).toBe("—");
    expect(maskPhone(undefined)).toBe("—");
    expect(maskPhone("")).toBe("—");
    expect(maskPhone("12345")).toBe("12345");
    expect(maskPhone("+8613812345678")).toBe("+8613812345678");
  });
});
