// 头盔名「名字优先」的边界（2026-10-16）：接口接受只含零宽字符（U+200B×3）和带换行的名字——
// 华为真机上零宽名让「其他头盔」那一行一片空白，换行名单行显示只剩「第一行…」、地图「切换头盔」只剩「第一…」。
// 显示前统一过 cleanHelmetName：去掉看不见的字符，连续空白压成一个空格，整理完为空就回退设备号。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "@jest/globals";

import { cleanHelmetName, helmetNameOf } from "../safety-status";

const ID = "helmet_f8b262";
const nameOf = (name: string | null) => helmetNameOf({ name, deviceId: ID });

describe("helmetNameOf：名字为空时回退设备号", () => {
  it("null / 空串 / 全空白（半角、全角、制表、换行）都回退设备号", () => {
    for (const blank of [null, "", " ", "   ", "　　", "\t", "\n\r\n"]) {
      expect(nameOf(blank)).toBe(ID);
    }
  });

  it("只含零宽字符（华为真机那顶：U+200B×3）回退设备号，不再是一片空白", () => {
    expect(nameOf("​​​")).toBe(ID);
  });

  it("各类看不见的字符单独或混着空白组成的名字，一律回退设备号", () => {
    for (const ch of [
      "​", // 零宽空格
      "‌", // 零宽不连字
      "‍", // 零宽连接符（单独出现时）
      "‎", // 从左到右标记
      "‏", // 从右到左标记
      " ", // 行分隔符
      " ", // 段分隔符
      "‪",
      "‬",
      "‮", // 从右到左覆盖
      "⁠", // 字连接符
      "⁡",
      "⁤",
      "⁦",
      "⁩", // 方向隔离
      "﻿", // BOM
      "­", // 软连字符
      "᠎", // 蒙古文元音分隔符
      "ㅤ", // 韩文填充符（常被拿来起「空白名」）
      "ﾠ",
      "ᅟ",
      "⠀", // 盲文空白
      "\u0000",
      "\u0007",
      "\u001B",
      "\u007F",
      "\u0085",
      "️", // 没跟在字后面的变体选择符
    ]) {
      expect(nameOf(ch)).toBe(ID);
      expect(nameOf(` ${ch}${ch} `)).toBe(ID);
    }
  });

  it("普通名字原样显示（中文、英文、数字、emoji、HTML 字样都不改）", () => {
    for (const name of [
      "我的头盔",
      "Helmet 1",
      "通勤🚲",
      "<b>x</b>&amp;\"'",
      "a",
      "零一智行·二号",
    ]) {
      expect(nameOf(name)).toBe(name);
    }
  });
});

describe("cleanHelmetName：整理成一行", () => {
  it("换行名压成一行：「第一行 第二行 第三行」，单行显示不再只剩第一行", () => {
    expect(cleanHelmetName("第一行\n第二行\n第三行")).toBe(
      "第一行 第二行 第三行",
    );
    expect(cleanHelmetName("第一行\r\n第二行")).toBe("第一行 第二行");
    expect(cleanHelmetName("第一行 第二行")).toBe("第一行 第二行");
  });

  it("首尾空白去掉，中间连续的空白（含制表、全角空格、不换行空格）压成一个空格", () => {
    expect(cleanHelmetName("  我的  头盔  ")).toBe("我的 头盔");
    expect(cleanHelmetName("我的\t\t头盔")).toBe("我的 头盔");
    expect(cleanHelmetName("我的　头盔")).toBe("我的 头盔");
    expect(cleanHelmetName("我的  头盔")).toBe("我的 头盔");
  });

  it("字中间夹着的零宽字符 / 方向控制符去掉，字照留", () => {
    expect(cleanHelmetName("我​的‎头‮盔﻿")).toBe("我的头盔");
    expect(cleanHelmetName("​​ 头盔 ​")).toBe("头盔");
    // 零宽字符把两段空白隔开：去掉后仍只留一个空格
    expect(cleanHelmetName("A ​ B")).toBe("A B");
  });

  it("表情组合要用的零宽连接符和变体选择符保留，不把 👨‍💻 拆成两个、不把 ❤️ 变成黑白", () => {
    expect(cleanHelmetName("👨‍💻的头盔")).toBe("👨‍💻的头盔");
    expect(cleanHelmetName("❤️")).toBe("❤️");
    expect(cleanHelmetName("🏍️ 头盔")).toBe("🏍️ 头盔");
  });

  it("零宽连接符落在开头、结尾或空格旁边没有作用，去掉", () => {
    expect(cleanHelmetName("‍头盔‍")).toBe("头盔");
    expect(cleanHelmetName("头盔 ‍‍ 二号")).toBe("头盔 二号");
    expect(cleanHelmetName("️头盔")).toBe("头盔");
  });

  it("null / undefined / 空串都是空串", () => {
    expect(cleanHelmetName(null)).toBe("");
    expect(cleanHelmetName(undefined)).toBe("");
    expect(cleanHelmetName("")).toBe("");
  });

  it("整理是幂等的：整理过的再整理一遍不变", () => {
    for (const raw of ["第一行\n第二行", " ​我的 ⁠ 头盔\t", "👨‍💻", "​​​"]) {
      const once = cleanHelmetName(raw);
      expect(cleanHelmetName(once)).toBe(once);
    }
  });

  it("结果里不再有换行、制表或任何看不见的字符", () => {
    const out = cleanHelmetName("\u0001A\u0002\n​ B­⁠⁦C⁩﻿ㅤ");
    expect(out).toBe("A BC");
    expect(out).not.toMatch(/[\n\r\t​⁠⁦⁩﻿ㅤ]/);
  });
});

// 页面层没有渲染测试：用源码不变式钉住「显示头盔名都过 helmetNameOf / cleanHelmetName」，免得以后新加的地方又直接读 name
const SRC = join(__dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" ? [] : sources(full);
    }
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("接线：显示头盔名的地方不直接读 device.name", () => {
  it("没有「name ?? deviceId」这种直接回退的写法", () => {
    const offenders = sources(SRC)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return /\bname \?\? (\w+\.)?deviceId\b/.test(src);
      })
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("设备详情：标题、解绑确认、改名预填和提交都过名字整理", () => {
    const src = readFileSync(join(SRC, "app/device/[deviceId].tsx"), "utf8");
    expect(src).toMatch(
      /const shownName = cleanHelmetName\(detail\.data\?\.name\);/,
    );
    expect(src).toMatch(
      /\{helmetNameOf\(\{ name: detail\.data\?\.name \?\? null, deviceId \}\)\}/,
    );
    expect(src).toMatch(/id: shownName \|\| deviceId/);
    expect(src).toMatch(/setNameDraft\(shownName\)/);
    expect(src).toMatch(
      /\.rename\(deviceId, \{ name: cleanHelmetName\(nameDraft\) \}\)/,
    );
    // 名字为空串时不能把 "" 直接放进 JSX（RN 会报「文字必须放在 Text 里」）
    expect(src).not.toMatch(/\{detail\.data\?\.name && \(/);
  });

  it("设备页大图 / 其他头盔行、设置分类页、事故详情、低电量提醒都用整理过的名字", () => {
    const home = readFileSync(join(SRC, "app/(tabs)/index.tsx"), "utf8");
    expect(home).not.toMatch(/device\.name \?\?/);
    expect(home.match(/const name = helmetNameOf\(device\);/g)).toHaveLength(2);
    expect(
      readFileSync(join(SRC, "components/device-settings-page.tsx"), "utf8"),
    ).toMatch(
      /helmetNameOf\(\{ name: detail\.data\?\.name \?\? null, deviceId \}\)/,
    );
    expect(
      readFileSync(join(SRC, "app/accident/[accidentId].tsx"), "utf8"),
    ).toMatch(/const helmetName = cleanHelmetName\(/);
    expect(readFileSync(join(SRC, "hooks/use-realtime.ts"), "utf8")).toMatch(
      /checkBatteryAlert\(\s*deviceId,\s*dev \? helmetNameOf\(dev\) : deviceId,/,
    );
  });
});
