// 短信验证码重发读秒（三页共用的纯逻辑部分）
import { describe, expect, it } from "@jest/globals";

import {
  isValidPhone,
  normalizePhone,
  PHONE_PATTERN,
  RESEND_SECONDS,
  resendCooldown,
} from "../use-sms-code";

describe("isValidPhone", () => {
  it("大陆手机号：1 开头、第二位 3–9、11 位；首尾空格允许", () => {
    expect(isValidPhone("13900000042")).toBe(true);
    expect(isValidPhone(" 19900001234 ")).toBe(true);
    expect(isValidPhone("12900000042")).toBe(false);
    expect(isValidPhone("1390000004")).toBe(false);
    expect(isValidPhone("139000000421")).toBe(false);
    expect(isValidPhone("+8613900000042")).toBe(false);
    expect(isValidPhone("")).toBe(false);
    expect(PHONE_PATTERN.test("13900000042")).toBe(true);
  });
});

describe("resendCooldown", () => {
  it("按截止时间戳算剩余秒数，向上取整，过期为 0", () => {
    const now = 1_000_000;
    expect(resendCooldown(now + RESEND_SECONDS * 1000, now)).toBe(60);
    expect(resendCooldown(now + 1_200, now)).toBe(2);
    expect(resendCooldown(now + 1, now)).toBe(1);
    expect(resendCooldown(now, now)).toBe(0);
    expect(resendCooldown(now - 5_000, now)).toBe(0);
    expect(resendCooldown(0, now)).toBe(0);
  });
});

// 紧急联系人的号码多半是从通讯录 / 聊天里复制的（2026-10-15 边界测试：带空格的正确号码被后端拒）
describe("normalizePhone", () => {
  it("去掉空格、横线、括号（含全角括号）", () => {
    expect(normalizePhone("139 0000 0042")).toBe("13900000042");
    expect(normalizePhone("139-0000-0042")).toBe("13900000042");
    expect(normalizePhone("(139) 0000 0042")).toBe("13900000042");
    expect(normalizePhone("（139）00000042")).toBe("13900000042");
  });

  it("去掉 +86 / 0086 / 86 前缀，去掉后正好 11 位才去", () => {
    expect(normalizePhone("+86 139 0000 0042")).toBe("13900000042");
    expect(normalizePhone("0086-13900000042")).toBe("13900000042");
    expect(normalizePhone("8613900000042")).toBe("13900000042");
    // 86 开头但去掉后不是 11 位：不当前缀，原样（照样过不了校验）
    expect(normalizePhone("861390000004")).toBe("861390000004");
  });

  it("规整后仍不合法的照样不合法", () => {
    for (const bad of [
      "123",
      "+1 415 555 0100",
      "abc",
      "1290000 0042",
      "+86 139",
    ]) {
      expect(isValidPhone(normalizePhone(bad))).toBe(false);
    }
    expect(isValidPhone(normalizePhone("+86 139-0000-0042"))).toBe(true);
  });
});
