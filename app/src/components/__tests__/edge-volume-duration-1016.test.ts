// 两处显示口径（2026-10-16 第二轮边界测试）：
// 1. 音量滑杆静止时照实显示头盔上的值——原来过一遍拖动档位（5% 一档、最低 10），1–9 显示成 10、83 显示成 85、
//    82 显示成 80（82 超过推荐线 80 却不标「高音量」）。原因是取整（5% 档位）加最低档夹到 10，不是硬件步进。
// 2. 行程时长整小时写「1 小时」，不写「1 小时 0 分」（三语）。
import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it, jest } from "@jest/globals";
import { DEVICE_SETTINGS } from "@helmet/shared";

import { translate, type Locale, type MessageKey, type Params } from "@/i18n";

import {
  clampVolume,
  restingVolume,
  VOLUME_LOUD_THRESHOLD,
  VOLUME_SETTING_MAX,
  VOLUME_SETTING_MIN,
} from "../volume-slider";
import { durationText } from "../map/ride-list";

// 组件文件引了 reanimated / Skia / global.css：换成各自的 mock（同 edge-component-helpers-1016）
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

describe("restingVolume：静止时显示头盔上的实际音量", () => {
  it("取值范围和设置清单一致（1–100）", () => {
    expect(DEVICE_SETTINGS.volume).toMatchObject({
      min: VOLUME_SETTING_MIN,
      max: VOLUME_SETTING_MAX,
    });
  });

  it("1–9 的小音量照实显示，不再显示成 10", () => {
    for (const v of [1, 3, 7, 9]) expect(restingVolume(v)).toBe(v);
  });

  it("不在 5% 档位上的值照实显示：83 是 83、82 是 82", () => {
    expect(restingVolume(83)).toBe(83);
    expect(restingVolume(82)).toBe(82);
  });

  it("82 超过推荐线：按实际值判高音量（原来显示成 80，不提醒）", () => {
    expect(restingVolume(82) > VOLUME_LOUD_THRESHOLD).toBe(true);
    expect(clampVolume(82) > VOLUME_LOUD_THRESHOLD).toBe(false);
  });

  it("小数取整；越界夹到 1–100：0 → 1、-5 → 1、101 → 100、无穷 → 两头", () => {
    expect(restingVolume(7.4)).toBe(7);
    expect(restingVolume(7.5)).toBe(8);
    expect(restingVolume(0)).toBe(1);
    expect(restingVolume(-5)).toBe(1);
    expect(restingVolume(101)).toBe(100);
    expect(restingVolume(Number.POSITIVE_INFINITY)).toBe(100);
    expect(restingVolume(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it("NaN 原样交回（与改之前 clampVolume 的行为一致）", () => {
    expect(restingVolume(Number.NaN)).toBeNaN();
  });

  it("拖动档位不变：5% 一档、10–100", () => {
    expect(clampVolume(7)).toBe(10);
    expect(clampVolume(83)).toBe(85);
    expect(clampVolume(82)).toBe(80);
  });

  it("接线：标签、滑块位置、拖动起点都用 restingVolume；拖动中才用档位", () => {
    const src = readFileSync(
      join(__dirname, "..", "volume-slider.tsx"),
      "utf8",
    );
    expect(src).toContain(
      "const shown = dragging ? dragShown : restingVolume(value)",
    );
    expect(src).toContain(
      "const syncTarget = dragging ? -1 : restingVolume(value)",
    );
    expect(src).toContain("useSharedValue(restingVolume(value) / MAX)");
    expect(src).toContain("setDragShown(restingVolume(value))");
    expect(src).toContain("const v = clampVolume(raw * MAX)");
  });
});

describe("durationText：整小时不写「0 分」", () => {
  it("整 1 小时、2 小时、23 小时：三种语言", () => {
    expect(durationText(3600, tOf("zh-CN"))).toBe("1 小时");
    expect(durationText(2 * 3600, tOf("zh-TW"))).toBe("2 小時");
    expect(durationText(23 * 3600, tOf("en"))).toBe("23 h");
  });

  it("四舍五入后才是整小时的也算：1 小时 59 分 30 秒 → 2 小时", () => {
    expect(durationText(3600 + 59 * 60 + 30, tOf("zh-CN"))).toBe("2 小时");
    expect(durationText(3600 + 29, tOf("en"))).toBe("1 h");
  });

  it("不是整小时照旧写分：1 小时 1 分、1 h 1 min", () => {
    expect(durationText(3660, tOf("zh-CN"))).toBe("1 小时 1 分");
    expect(durationText(3660, tOf("en"))).toBe("1 h 1 min");
  });

  it("不足一小时照旧写分钟", () => {
    expect(durationText(45 * 60, tOf("zh-TW"))).toBe("45 分鐘");
  });
});
