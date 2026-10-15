// 几份常量表的不变式（2026-10-16）：颜色小工具只认 #RRGGBB，主题里交给它们的颜色必须是这种写法；
// 设置页列出的设置项与共享清单一致。
import { describe, expect, it, jest } from "@jest/globals";
import { DEVICE_SETTING_KEYS } from "@helmet/shared";

import { Colors } from "@/constants/theme";
import { mixHex, withAlpha } from "@/services/color";
import { EXPOSED_SETTINGS, levelLabelKey } from "../device-settings";

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

const HEX = /^#[0-9A-Fa-f]{6}$/;
// 源码里交给 withAlpha / mixHex 的主题色（grep 出来的），加上大图光晕 / 头盔柔光底用到的
const PASSED_TO_COLOR_HELPERS = [
  "background",
  "backgroundElement",
  "backgroundSelected",
  "brand",
  "success",
  "warning",
  "danger",
  "text",
  "textSecondary",
] as const;

describe("主题色", () => {
  it.each(["light", "dark"] as const)(
    "%s：交给颜色小工具的主题色都是 #RRGGBB（rgba 写法会被算成乱码）",
    (scheme) => {
      for (const key of PASSED_TO_COLOR_HELPERS) {
        expect({
          key,
          value: Colors[scheme][key],
          ok: HEX.test(Colors[scheme][key]),
        }).toEqual({
          key,
          value: Colors[scheme][key],
          ok: true,
        });
        expect(withAlpha(Colors[scheme][key], 0.5)).toMatch(
          /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.5\)$/,
        );
        expect(
          mixHex(Colors[scheme].background, Colors[scheme][key], 0.3),
        ).toMatch(/^#[0-9a-f]{6}$/);
      }
    },
  );

  it("深浅两套主题的键一模一样（切换外观时不会缺色）", () => {
    expect(Object.keys(Colors.light).sort()).toEqual(
      Object.keys(Colors.dark).sort(),
    );
  });
});

describe("设置页列出的设置项", () => {
  it("都在共享清单里、没有重复", () => {
    for (const key of EXPOSED_SETTINGS)
      expect(DEVICE_SETTING_KEYS).toContain(key);
    expect(new Set(EXPOSED_SETTINGS).size).toBe(EXPOSED_SETTINGS.length);
  });

  it("档位型设置都在列出的设置项里（否则档位文案白写）", () => {
    for (const key of ["light", "vibration", "fallSensitivity"] as const) {
      expect(EXPOSED_SETTINGS).toContain(key);
      expect(levelLabelKey(key, 1)).not.toBeNull();
    }
  });
});
