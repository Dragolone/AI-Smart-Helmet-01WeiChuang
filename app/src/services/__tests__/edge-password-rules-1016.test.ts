// 密码上限按 UTF-8 字节数（与后端 auth.dto 的 72 字节同口径，2026-10-16）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import {
  PASSWORD_MAX_BYTES,
  isPasswordTooLong,
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
