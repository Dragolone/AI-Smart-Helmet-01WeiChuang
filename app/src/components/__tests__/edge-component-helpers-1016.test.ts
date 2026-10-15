// 组件里导出的几个纯函数的边界（2026-10-16）：音量滑杆取整、表单错误落到哪个字段、档位型设置的文案。
import { describe, expect, it, jest } from "@jest/globals";
import { DEVICE_SETTINGS, type DeviceSettingKey } from "@helmet/shared";

import { translate } from "@/i18n";
import { levelLabelKey } from "../device-settings";
import { errorField } from "../form";
import {
  VOLUME_LOUD_THRESHOLD,
  VOLUME_RECOMMENDED,
  clampVolume,
} from "../volume-slider";

// theme.ts 顶部 import 了 global.css（web 用），jest 不转 css；画勾动画用 Skia（ESM，jest 不转），换成空组件
jest.mock("@/global.css", () => ({}));
jest.mock("@/components/check-draw", () => ({
  CHECK_DRAW_MS: 800,
  CheckDraw: () => null,
}));
// 动画库在 jest 里起不来（要原生的 worklets 模块）：换成两个库各自带的 mock
jest.mock("react-native-reanimated", () =>
  jest.requireActual("react-native-reanimated/mock"),
);
jest.mock("react-native-worklets", () =>
  jest.requireActual("react-native-worklets/src/mock"),
);

describe("clampVolume：音量滑杆按 5% 一档、10–100", () => {
  it("四舍五入到 5 的倍数：2.5 进到 5（再抬到下限 10）、12.5 进到 15、12.4 落到 10", () => {
    expect(clampVolume(12.5)).toBe(15);
    expect(clampVolume(12.4)).toBe(10);
    expect(clampVolume(2.5)).toBe(10);
    expect(clampVolume(97.5)).toBe(100);
    expect(clampVolume(97.4)).toBe(95);
  });

  it("下限 10、上限 100：负数、0、超过 100、无穷都夹到两头", () => {
    expect(clampVolume(-50)).toBe(10);
    expect(clampVolume(0)).toBe(10);
    expect(clampVolume(103)).toBe(100);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampVolume(Number.NEGATIVE_INFINITY)).toBe(10);
  });

  it("拖动档位最低一档是 10：1–9 拖动时落到 10（10-16 第二轮改：静止显示不再走这里，改走 restingVolume 照实显示 1–9）", () => {
    expect(DEVICE_SETTINGS.volume).toMatchObject({ min: 1, max: 100 });
    for (const v of [1, 3, 7, 9]) expect(clampVolume(v)).toBe(10);
  });

  it("NaN 原样是 NaN（现状；拖动时宽度至少按 1 算，不会除出 NaN）", () => {
    expect(clampVolume(Number.NaN)).toBeNaN();
  });

  it("每一档都是 5 的倍数且在 10–100 之内；推荐线和高音量提醒是同一条线", () => {
    for (let v = -10; v <= 110; v += 0.5) {
      const c = clampVolume(v);
      expect(c % 5).toBe(0);
      expect(c).toBeGreaterThanOrEqual(10);
      expect(c).toBeLessThanOrEqual(100);
    }
    expect(VOLUME_LOUD_THRESHOLD).toBe(VOLUME_RECOMMENDED);
  });
});

describe("errorField：服务端错误码落到哪个输入框", () => {
  it.each([
    ["SMS_CODE_INVALID", "code"],
    ["SMS_CODE_TOO_FREQUENT", "code"],
    ["SMS_CODE_DAILY_LIMIT", "code"],
    ["SMS_CODE_MAX_ATTEMPTS", "code"],
    ["PASSWORD_INCORRECT", "password"],
    ["PHONE_ALREADY_REGISTERED", "phone"],
    ["PHONE_NOT_REGISTERED", "phone"],
    ["USER_NOT_FOUND", "phone"],
    ["NICKNAME_TOO_LONG", "nickname"],
  ])("%s → %s", (code, field) => {
    expect(errorField({ code })).toBe(field);
  });

  it.each([
    "UNAUTHORIZED",
    "VALIDATION_FAILED",
    "RATE_LIMITED",
    "SMS_SEND_FAILED",
    "INTERNAL_ERROR",
    "NOT_FOUND",
  ])("%s：说不清是哪个字段，交给页面级提示", (code) => {
    expect(errorField({ code })).toBeNull();
  });

  it("小写的码也认；码里同时有 PASSWORD 和 PHONE 时算密码（先判密码）", () => {
    expect(errorField({ code: "sms_code_invalid" })).toBe("code");
    expect(errorField({ code: "PHONE_OR_PASSWORD_INCORRECT" })).toBe(
      "password",
    );
  });

  it("不是对象、没有 code、code 不是字符串：都是 null，不抛", () => {
    for (const e of [
      null,
      undefined,
      "boom",
      42,
      new Error("x"),
      {},
      { code: "" },
      { code: null },
    ]) {
      expect(errorField(e)).toBeNull();
    }
    expect(errorField({ code: 401 })).toBeNull();
  });
});

describe("levelLabelKey：档位型设置的文案", () => {
  const levelKeys = ["light", "vibration", "fallSensitivity"] as const;

  it("档位型设置在清单范围内每一档都有文案（三种语言都译了），越过上下限就没有", () => {
    for (const key of levelKeys) {
      const spec = DEVICE_SETTINGS[key] as { min: number; max: number };
      for (let v = spec.min; v <= spec.max; v += 1) {
        const k = levelLabelKey(key, v);
        expect({ key, v, ok: k !== null }).toEqual({ key, v, ok: true });
        for (const loc of ["zh-CN", "zh-TW", "en"] as const)
          expect(translate(k!, undefined, loc)).not.toBe("");
      }
      expect(levelLabelKey(key, spec.min - 1)).toBeNull();
      expect(levelLabelKey(key, spec.max + 1)).toBeNull();
    }
  });

  it("小数、字符串、布尔、null：没有文案", () => {
    expect(levelLabelKey("vibration", 1.5)).toBeNull();
    expect(levelLabelKey("vibration", "1")).toBeNull();
    expect(levelLabelKey("vibration", true)).toBeNull();
    expect(levelLabelKey("vibration", null)).toBeNull();
    expect(levelLabelKey("vibration", Number.NaN)).toBeNull();
  });

  it("不是档位型的设置（开关、音量、周期）：没有文案", () => {
    for (const key of [
      "buzzer",
      "volume",
      "heartbeatPeriod",
      "radarDistance",
    ] as DeviceSettingKey[]) {
      expect(levelLabelKey(key, 1)).toBeNull();
    }
  });
});
