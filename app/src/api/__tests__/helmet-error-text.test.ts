// 头盔回执错误码 → 用户可读文案：正文说人话、原始码另外展示（设备页拼在括号里）
import { describe, expect, it } from "@jest/globals";
import { HELMET_ERROR_CODES } from "@helmet/shared";

import { helmetErrorText } from "../error-messages";

const t = (k: string) => k;

describe("helmetErrorText", () => {
  it("手册 §3.0 的每个错误码都有文案，不会把码直接甩给用户", () => {
    for (const code of HELMET_ERROR_CODES) {
      expect(helmetErrorText(code, t as never)).toMatch(/^device\.err\./);
    }
  });

  it("忽略冒号后的设置键（回执形如 ERR_PARAM_VALUE:volume）", () => {
    expect(helmetErrorText("ERR_PARAM_VALUE:volume", t as never)).toBe(
      "device.err.paramValue",
    );
    expect(helmetErrorText("ERR_BATTERY_LOW", t as never)).toBe(
      "device.err.batteryLow",
    );
  });

  it("App 侧自造的 UNSUPPORTED_SETTING 也有文案", () => {
    expect(helmetErrorText("UNSUPPORTED_SETTING:light", t as never)).toBe(
      "device.err.unsupported",
    );
  });

  it("认不出的码原样返回，不吞掉信息", () => {
    expect(helmetErrorText("SOMETHING_NEW:x", t as never)).toBe(
      "SOMETHING_NEW:x",
    );
  });

  it("码恰好是 Object.prototype 的成员名：按认不出的码原样返回，不把函数或原型对象交给翻译", () => {
    for (const code of ["constructor", "toString:volume", "__proto__", "hasOwnProperty"]) {
      expect(helmetErrorText(code, t as never)).toBe(code);
    }
  });
});
