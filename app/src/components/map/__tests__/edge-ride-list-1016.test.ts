// 行程列表一行里的「时间段」「时长」写法的边界（2026-10-16）：跨零点写「次日」、进行中写「现在」、
// 时长分钟 / 小时的进位，三种语言。时刻用本地时间构造，换时区跑结果不变。
import { describe, expect, it, jest } from "@jest/globals";
import type { RideSummary } from "@helmet/shared";

import { translate, type Locale, type MessageKey, type Params } from "@/i18n";
import { durationText, endTimeLabel, rideTimeRange } from "../ride-list";

// 组件文件引了 reanimated / Skia / global.css：换成各自的 mock（同 components/__tests__/edge-component-helpers-1016）
jest.mock("@/global.css", () => ({}));
jest.mock("@/components/check-draw", () => ({
  CHECK_DRAW_MS: 800,
  CheckDraw: () => null,
}));
jest.mock("react-native-reanimated", () =>
  jest.requireActual("react-native-reanimated/mock"),
);
jest.mock("react-native-worklets", () =>
  jest.requireActual("react-native-worklets/src/mock"),
);

const tOf = (loc: Locale) => (key: MessageKey, params?: Params) =>
  translate(key, params, loc);
const local = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(y, m, d, h, mi).toISOString();
const ride = (
  startAt: string,
  endAt: string,
  ongoing = false,
): RideSummary => ({
  startAt,
  endAt,
  distanceMeters: 1000,
  movingSeconds: 600,
  maxSpeed: 5,
  ongoing,
});

describe("durationText", () => {
  it("不足一小时写分钟；整一小时写「1 小时 0 分」；23:59", () => {
    const t = tOf("zh-CN");
    expect(durationText(0, t)).toBe("1 分钟");
    expect(durationText(36 * 60, t)).toBe("36 分钟");
    expect(durationText(59 * 60 + 29, t)).toBe("59 分钟");
    expect(durationText(59 * 60 + 30, t)).toBe("1 小时 0 分");
    expect(durationText(106 * 60, t)).toBe("1 小时 46 分");
    expect(durationText(86_340, t)).toBe("23 小时 59 分");
  });

  it("三种语言", () => {
    expect(durationText(106 * 60, tOf("zh-TW"))).toBe("1 小時 46 分");
    expect(durationText(106 * 60, tOf("en"))).toBe("1 h 46 min");
    expect(durationText(5 * 60, tOf("en"))).toBe("5 min");
  });

  it("负数 / NaN：写 1 分钟（现状，不出 NaN）", () => {
    expect(durationText(-60, tOf("zh-CN"))).toBe("1 分钟");
    expect(durationText(Number.NaN, tOf("en"))).toBe("1 min");
  });
});

describe("endTimeLabel / rideTimeRange", () => {
  it("同一天：只写钟点；跨过零点：写「次日」", () => {
    const t = tOf("zh-CN");
    expect(
      endTimeLabel(
        local(2026, 9, 16, 18, 5),
        local(2026, 9, 16, 18, 41),
        "zh-CN",
        t,
      ),
    ).toBe("18:41");
    expect(
      endTimeLabel(
        local(2026, 9, 16, 23, 30),
        local(2026, 9, 17, 0, 10),
        "zh-CN",
        t,
      ),
    ).toBe("次日 00:10");
    expect(
      endTimeLabel(
        local(2026, 9, 16, 23, 30),
        local(2026, 9, 17, 0, 10),
        "en",
        tOf("en"),
      ),
    ).toBe("00:10 next day");
  });

  it("24 小时整的一趟（15:00 – 次日 15:00）不再像零时长", () => {
    const r = ride(local(2026, 9, 16, 15), local(2026, 9, 17, 15));
    expect(rideTimeRange(r, "zh-CN", tOf("zh-CN"))).toBe("15:00 – 次日 15:00");
  });

  it("跨年的那一趟：12 月 31 日 23:50 到 1 月 1 日 00:20 也是「次日」", () => {
    const r = ride(local(2026, 11, 31, 23, 50), local(2027, 0, 1, 0, 20));
    expect(rideTimeRange(r, "zh-TW", tOf("zh-TW"))).toBe("23:50 – 次日 00:20");
  });

  it("进行中：结束写「现在」，不管结束时间是哪天", () => {
    const r = ride(local(2026, 9, 15, 23, 0), local(2026, 9, 16, 1, 0), true);
    expect(rideTimeRange(r, "zh-CN", tOf("zh-CN"))).toBe("23:00 – 现在");
    expect(rideTimeRange(r, "en", tOf("en"))).toBe("23:00 – now");
  });

  it("结束早于开始（坏数据）：现状写成「次日」+ 结束钟点", () => {
    const r = ride(local(2026, 9, 16, 10, 0), local(2026, 9, 15, 9, 0));
    expect(rideTimeRange(r, "zh-CN", tOf("zh-CN"))).toBe("10:00 – 次日 09:00");
  });

  it("时间认不出：两头都写占位符，不抛、不加「次日」", () => {
    const r = ride("garbage", "also-garbage");
    expect(rideTimeRange(r, "zh-CN", tOf("zh-CN"))).toBe("— – —");
  });
});
