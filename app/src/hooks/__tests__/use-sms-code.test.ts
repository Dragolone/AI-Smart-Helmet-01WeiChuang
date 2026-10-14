// 短信验证码重发读秒（三页共用的纯逻辑部分）
import { describe, expect, it } from "@jest/globals";

import {
  isValidPhone,
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
