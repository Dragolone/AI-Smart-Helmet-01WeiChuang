// 密码上限按 UTF-8 字节数（与后端 auth.dto 的 72 字节同口径，2026-10-16）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  isPasswordTooLong,
  isPasswordTooShort,
  passwordLength,
  utf8ByteLength,
} from "../password-rules";

describe("utf8ByteLength", () => {
  it("ASCII 1 字节、拉丁扩展 2 字节、中文 3 字节、表情（代理对）4 字节", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc123!@")).toBe(8);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("ß")).toBe(2);
    expect(utf8ByteLength("密")).toBe(3);
    expect(utf8ByteLength("🔒")).toBe(4);
    expect(utf8ByteLength("a密🔒")).toBe(8);
  });

  it("与 Node 的 Buffer.byteLength 一致（各种混合串）", () => {
    for (const s of [
      "Pa55word",
      "密码很长的口令",
      "émoji🔒🔑",
      "\u0000\u007f\u0080߿ࠀ￿",
      "𠮷野家",
    ]) {
      expect(utf8ByteLength(s)).toBe(Buffer.byteLength(s, "utf-8"));
    }
  });

  it("落单的代理项按 3 字节算（和 Buffer 把它换成 U+FFFD 一样）", () => {
    expect(utf8ByteLength("\ud83d")).toBe(Buffer.byteLength("\ud83d", "utf-8"));
  });
});

describe("isPasswordTooLong：72 字节", () => {
  it("72 个英文字符正好不超；73 个超", () => {
    expect(PASSWORD_MAX_BYTES).toBe(72);
    expect(isPasswordTooLong("a".repeat(72))).toBe(false);
    expect(isPasswordTooLong("a".repeat(73))).toBe(true);
  });

  it("24 个汉字（72 字节）不超；25 个（75 字节）超——按字符数只有 25 位，原来改密码页会放过去", () => {
    expect(isPasswordTooLong("密".repeat(24))).toBe(false);
    expect(isPasswordTooLong("密".repeat(25))).toBe(true);
    expect("密".repeat(25).length).toBeLessThan(72);
  });

  it("表情：18 个（72 字节）不超、19 个超；字符串 length 是 38，同样会被按字符数的检查放过", () => {
    expect(isPasswordTooLong("🔒".repeat(18))).toBe(false);
    expect(isPasswordTooLong("🔒".repeat(19))).toBe(true);
  });
});

describe("接线：注册 / 找回密码 / 改密码三页都按字节查上限（源码不变式）", () => {
  const SRC = join(__dirname, "..", "..");
  it.each([
    "app/(auth)/register.tsx",
    "app/(auth)/reset-password.tsx",
    "app/account/change-password.tsx",
  ])("%s", (file) => {
    const src = readFileSync(join(SRC, file), "utf8");
    expect(src).toMatch(/isPasswordTooLong\(password\)/);
    expect(src).not.toMatch(/password\.length > 72/);
  });
});

// 下限按服务端的数法（class-validator MinLength → validator.isLength，2026-10-17）：数码点，
// 紧跟在字符后面的变体选择符（U+FE0E / U+FE0F）不算。原来按 UTF-16 单元数，7 个表情在本地算 14 位
describe("passwordLength / isPasswordTooShort：8 位下限", () => {
  it("ASCII、汉字一字一位；表情、生僻字（代理对）也是一位", () => {
    expect(passwordLength("abcdefgh")).toBe(8);
    expect(passwordLength("密码很长的口令")).toBe(7);
    expect(passwordLength("😀".repeat(7))).toBe(7);
    expect("😀".repeat(7).length).toBe(14);
    expect(passwordLength("𠮷野家")).toBe(3);
  });

  it("「❤️」这类带变体选择符的：选择符不算（和服务端一样）", () => {
    const heart = "\u2764\uFE0F"; // ❤️
    expect(heart.length).toBe(2);
    expect(passwordLength(heart)).toBe(1);
    expect(passwordLength("\u2764\uFE0E")).toBe(1);
    expect(passwordLength("\u{1F3F3}\uFE0F")).toBe(1); // 🏳️：代理对 + 选择符
    expect(passwordLength(heart.repeat(8))).toBe(8);
    // 打头的孤立选择符前面没有字符：照样算一位
    expect(passwordLength("\uFE0Fabc")).toBe(4);
  });

  it("7 位不够、8 位够；7 个表情不够（原来按 length 是 14，本地放过、服务端拒）", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(isPasswordTooShort("abcdefg")).toBe(true);
    expect(isPasswordTooShort("abcdefgh")).toBe(false);
    expect(isPasswordTooShort("😀".repeat(7))).toBe(true);
    expect(isPasswordTooShort("😀".repeat(8))).toBe(false);
    expect(isPasswordTooShort("\u2764\uFE0F".repeat(4))).toBe(true);
    expect(isPasswordTooShort("")).toBe(true);
  });

  it.each([
    "app/(auth)/register.tsx",
    "app/(auth)/reset-password.tsx",
    "app/account/change-password.tsx",
  ])("接线：%s 的新密码按 isPasswordTooShort 查", (file) => {
    const src = readFileSync(join(__dirname, "..", "..", file), "utf8");
    expect(src).toMatch(/isPasswordTooShort\(password\)/);
    expect(src).not.toMatch(/\bpassword\.length < 8/);
  });
});
