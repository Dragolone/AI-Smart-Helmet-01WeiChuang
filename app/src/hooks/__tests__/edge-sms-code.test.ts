// 手机号规整 / 校验与重发读秒的边界（2026-10-16）。use-sms-code.test.ts 钉了空格、横线、括号、+86 / 0086 / 86 前缀；
// 这里补全角输入、复制时夹带的看不见字符、各种横线、11 位上下界和前缀的组合。
import { describe, expect, it } from "@jest/globals";

import {
  isValidPhone,
  normalizePhone,
  RESEND_SECONDS,
  resendCooldown,
} from "../use-sms-code";

const OK = "13900000042";

describe("normalizePhone：全角与看不见的字符", () => {
  it("中文输入法全角状态打出的数字、加号、横线、空格、括号都认", () => {
    expect(normalizePhone("１３９００００００４２")).toBe(OK);
    expect(normalizePhone("＋８６　１３９－００００－００４２")).toBe(OK);
    expect(normalizePhone("（１３９）００００　００４２")).toBe(OK);
    expect(normalizePhone("００８６１３９００００００４２")).toBe(OK);
  });

  it("iOS 通讯录复制号码首尾带的方向标记（U+202D … U+202C）、聊天里夹的零宽空格 / BOM 去掉", () => {
    expect(normalizePhone("‭+86 139 0000 0042‬")).toBe(OK);
    expect(normalizePhone("⁦139​0000​0042⁩")).toBe(OK);
    expect(normalizePhone("﻿13900000042")).toBe(OK);
    expect(normalizePhone("‎139-0000-0042‏")).toBe(OK);
  });

  it("连字符 / 破折号 / 减号这些长得像横线的都当分隔符", () => {
    for (const dash of ["‐", "‑", "‒", "–", "—", "―", "−"]) {
      expect(normalizePhone(`139${dash}0000${dash}0042`)).toBe(OK);
    }
  });

  it("不换行空格、制表、换行（从表格里粘过来）都当空白去掉", () => {
    expect(normalizePhone("139 0000 0042")).toBe(OK);
    expect(normalizePhone("\t139 0000 0042\n")).toBe(OK);
    expect(normalizePhone("+86\r\n13900000042")).toBe(OK);
  });

  it("规整后的结果都能过本地校验", () => {
    for (const raw of [
      "１３９００００００４２",
      "‭+86 139 0000 0042‬",
      "＋８６　１３９－００００－００４２",
      "139–0000–0042",
    ]) {
      expect(isValidPhone(normalizePhone(raw))).toBe(true);
    }
  });
});

describe("normalizePhone：11 位边界与前缀组合", () => {
  it("前缀后面是 10 位或 12 位：不当前缀去掉，原样（照样过不了校验）", () => {
    expect(normalizePhone("+861390000004")).toBe("+861390000004");
    expect(normalizePhone("+86139000000421")).toBe("+86139000000421");
    expect(normalizePhone("0086139000000421")).toBe("0086139000000421");
    for (const raw of [
      "+861390000004",
      "+86139000000421",
      "0086139000000421",
    ]) {
      expect(isValidPhone(normalizePhone(raw))).toBe(false);
    }
  });

  it("前缀叠了两层、或只有前缀：不认", () => {
    expect(isValidPhone(normalizePhone("0086 +86 139 0000 0042"))).toBe(false);
    expect(isValidPhone(normalizePhone("+86 +86 13900000042"))).toBe(false);
    expect(normalizePhone("+86")).toBe("+86");
    expect(normalizePhone("0086")).toBe("0086");
    expect(isValidPhone(normalizePhone("+86"))).toBe(false);
  });

  it("「+」后面不是 86 的国际号码不动，照样不合法（只认大陆手机号）", () => {
    expect(normalizePhone("+85291234567")).toBe("+85291234567");
    expect(isValidPhone(normalizePhone("+852 9123 4567"))).toBe(false);
    expect(isValidPhone(normalizePhone("+1 (415) 555-0100"))).toBe(false);
  });

  it("夹了字母、点号、斜杠、星号的不当分隔符，结果仍不合法", () => {
    for (const raw of [
      "139abc00042",
      "139.0000.0042",
      "139/0000/0042",
      "139****0042",
      "1390000004２x",
    ]) {
      expect(isValidPhone(normalizePhone(raw))).toBe(false);
    }
  });

  it("空串和全空白规整成空串", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("   ")).toBe("");
    expect(normalizePhone("　‭‬")).toBe("");
  });

  it("首位多了一个 0（座机习惯）不当前缀去掉", () => {
    expect(normalizePhone("013900000042")).toBe("013900000042");
    expect(isValidPhone(normalizePhone("013900000042"))).toBe(false);
  });

  it("规整是幂等的：规整过的号码再规整一遍不变", () => {
    for (const raw of [
      "+86 139 0000 0042",
      "１３９００００００４２",
      "861390000004",
      "abc",
    ]) {
      const once = normalizePhone(raw);
      expect(normalizePhone(once)).toBe(once);
    }
  });
});

describe("isValidPhone：号段与长度边界", () => {
  it("第二位 3 和 9 是上下界，0 / 1 / 2 不是手机号段", () => {
    expect(isValidPhone("13000000000")).toBe(true);
    expect(isValidPhone("19999999999")).toBe(true);
    expect(isValidPhone("10000000000")).toBe(false);
    expect(isValidPhone("11000000000")).toBe(false);
    expect(isValidPhone("12999999999")).toBe(false);
  });

  it("不是 1 开头的 11 位不算", () => {
    expect(isValidPhone("23900000042")).toBe(false);
    expect(isValidPhone("03900000042")).toBe(false);
  });

  it("中间带空格 / 全角数字 / 阿拉伯数字在校验这一步不认（要先 normalizePhone）", () => {
    expect(isValidPhone("139 0000 0042")).toBe(false);
    expect(isValidPhone("１３９００００００４２")).toBe(false);
    expect(isValidPhone("١٣٩٠٠٠٠٠٠٤٢")).toBe(false);
  });

  it("首尾的换行、制表、全角空格也算空白，可以有", () => {
    expect(isValidPhone("\n13900000042\t")).toBe(true);
    expect(isValidPhone("　13900000042　")).toBe(true);
  });
});

describe("resendCooldown 边界", () => {
  it("差 1 毫秒到 60 秒也算 60 秒；还剩 0.001 秒算 1 秒（向上取整）", () => {
    const now = 5_000_000;
    expect(resendCooldown(now + RESEND_SECONDS * 1000 - 1, now)).toBe(60);
    expect(resendCooldown(now + 1, now)).toBe(1);
  });

  // 以前拨回一小时会显示「3660 秒后重发」、按钮灰一个小时
  it("发完之后手机时间被往回拨（剩余比一整轮还长）：读秒作废，可以再点（服务端 429 兜底）", () => {
    const sentAt = 5_000_000;
    const until = sentAt + RESEND_SECONDS * 1000;
    expect(resendCooldown(until, sentAt - 3_600_000)).toBe(0);
    expect(resendCooldown(until, sentAt - 1)).toBe(0);
    // 拨回得少、仍在一轮之内：照常读秒
    expect(resendCooldown(until, sentAt + 30_000 - 20_000)).toBe(50);
  });

  it("往前拨了：立刻可发", () => {
    const sentAt = 5_000_000;
    expect(
      resendCooldown(sentAt + RESEND_SECONDS * 1000, sentAt + 3_600_000),
    ).toBe(0);
  });
});
