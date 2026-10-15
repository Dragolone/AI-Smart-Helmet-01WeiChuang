// 绑定页手输设备号 / 绑定码的规整（2026-10-16 第二轮边界测试）。
// 扫码有 parseBindQr 把关；手输原来只 trim()：全角、分组空格、复制夹带的零宽字符都会被服务端拒，
// 绑定码输入框还卡 8 位，粘贴「1234 5678」被截成「1234 567」——提交后是「绑定码不正确」，还白占一次限频。
import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "@jest/globals";

import {
  BIND_CODE_INPUT_MAX,
  normalizeManualBindCode,
  normalizeManualDeviceId,
  parseBindQr,
} from "../bind-qr";

// 服务端 BindDeviceDto 的设备号规则（backend devices.controller）
const SERVER_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

describe("normalizeManualDeviceId", () => {
  it("全角字母 / 数字 / 下划线 / 横线换成半角，过得了服务端的规则", () => {
    const out = normalizeManualDeviceId("ｈｅｌｍｅｔ＿００１－Ａ");
    expect(out).toBe("helmet_001-A");
    expect(SERVER_DEVICE_ID.test(out)).toBe(true);
  });

  it("复制夹带的零宽空格、方向标记、BOM 去掉", () => {
    expect(normalizeManualDeviceId("‭helmet_001‬")).toBe("helmet_001");
    expect(normalizeManualDeviceId("﻿helmet​_001")).toBe("helmet_001");
  });

  it("首尾空白（含全角空格）去掉；中间的空格不动（设备号里本来没有空格，交给服务端判）", () => {
    expect(normalizeManualDeviceId("　 helmet_001 \n")).toBe("helmet_001");
    expect(normalizeManualDeviceId("helmet 001")).toBe("helmet 001");
  });

  it("大小写不动（设备号区分大小写）", () => {
    expect(normalizeManualDeviceId("Helmet_ABC")).toBe("Helmet_ABC");
  });

  it("已经干净的设备号原样（扫码来的再过一遍不变）", () => {
    expect(normalizeManualDeviceId("helmet_night-01")).toBe("helmet_night-01");
  });
});

describe("normalizeManualBindCode", () => {
  it("说明卡上分组印的「1234 5678」「1234-5678」「12 34 56 78」都规整成 8 位", () => {
    for (const raw of ["1234 5678", "1234-5678", "12 34 56 78", "1234–5678"])
      expect(normalizeManualBindCode(raw)).toBe("12345678");
  });

  it("全角数字换成半角", () => {
    expect(normalizeManualBindCode("１２３４５６７８")).toBe("12345678");
  });

  it("零宽字符、首尾换行去掉", () => {
    expect(normalizeManualBindCode("​12345678\n")).toBe("12345678");
  });

  it("前导零保留（绑定码是字符串，不当数字）", () => {
    expect(normalizeManualBindCode("0012 3456")).toBe("00123456");
  });

  it("字母不动（Mock 设备的绑定码格式可以不同，交给服务端判）", () => {
    expect(normalizeManualBindCode("ab12 cd34")).toBe("ab12cd34");
  });

  it("输入框上限留得下分组写法；原来的 8 位上限会把「1234 5678」截成「1234 567」", () => {
    for (const raw of ["1234 5678", "12 34 56 78", "1234 - 5678"])
      expect(raw.length).toBeLessThanOrEqual(BIND_CODE_INPUT_MAX);
    expect(normalizeManualBindCode("1234 5678".slice(0, 8))).toBe("1234567");
  });

  it("和扫码解析同口径：规整后的码 parseBindQr 认得", () => {
    const code = normalizeManualBindCode("1234 5678");
    expect(parseBindQr(`helmet://bind?d=helmet_001&c=${code}`)).toEqual({
      deviceId: "helmet_001",
      bindCode: "12345678",
    });
  });
});

describe("绑定页接线", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "app", "bind-device.tsx"),
    "utf8",
  );

  it("提交前两项都过规整函数，不再只是 trim()", () => {
    expect(src).toContain("deviceId: normalizeManualDeviceId(deviceId)");
    expect(src).toContain("bindCode: normalizeManualBindCode(bindCode)");
    expect(src).not.toContain("bindCode.trim()");
  });

  it("绑定码输入框上限用 BIND_CODE_INPUT_MAX，不再是 8", () => {
    expect(src).toContain("maxLength={BIND_CODE_INPUT_MAX}");
    expect(src).not.toContain("maxLength={8}");
  });
});
