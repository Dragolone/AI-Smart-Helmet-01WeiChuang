// 链接里的设备编号任意长（2026-10-16 华为真机：app://device/<600 个 x>）：数据回来前标题用路由参数渲染、
// 铺满整屏，改名铅笔已能点；404 空态正文把整串编号原样塞进去。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import { translate } from "@/i18n";
import { DEVICE_ID_MAX_SHOWN, shortDeviceId } from "../device-view";

describe("shortDeviceId：正文里引用的设备编号", () => {
  it("32 个字以内原样；33 个起只留前 32 个加「…」", () => {
    expect(DEVICE_ID_MAX_SHOWN).toBe(32);
    const at32 = "x".repeat(32);
    expect(shortDeviceId(at32)).toBe(at32);
    expect(shortDeviceId("x".repeat(33))).toBe(`${at32}…`);
    expect(shortDeviceId("x".repeat(600))).toBe(`${at32}…`);
  });

  it("量产编号（helmet_ + 6 位）和协议上限 64 位以内的短编号都不受影响", () => {
    expect(shortDeviceId("helmet_f8b262")).toBe("helmet_f8b262");
    expect(shortDeviceId("")).toBe("");
    expect(shortDeviceId("abcd")).toBe("abcd");
  });

  it("按码点数：表情、中文不会被切成半个，也按一个字算", () => {
    const emoji = "🏍".repeat(40);
    const out = shortDeviceId(emoji);
    expect(Array.from(out)).toHaveLength(33);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(shortDeviceId("头".repeat(32))).toBe("头".repeat(32));
  });

  it("可以指定别的上限", () => {
    expect(shortDeviceId("abcdefgh", 4)).toBe("abcd…");
    expect(shortDeviceId("abcd", 4)).toBe("abcd");
  });

  it("放进三种语言的「找不到这顶头盔」正文里，长度有上限", () => {
    for (const loc of ["zh-CN", "zh-TW", "en"] as const) {
      const body = translate(
        "device.goneBody",
        { id: shortDeviceId("x".repeat(600)) },
        loc,
      );
      expect(body).toContain(`${"x".repeat(32)}…`);
      expect(body).not.toContain("x".repeat(33));
      expect(body.length).toBeLessThan(100);
    }
  });
});

describe("接线：设备详情页（源码不变式）", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "app", "device", "[deviceId].tsx"),
    "utf8",
  );

  it("标题最多两行", () => {
    expect(src).toMatch(
      /<ThemedText type="title" style=\{styles\.title\} numberOfLines=\{2\}>\s*\{helmetNameOf\(/,
    );
  });

  it("详情回来之前不显示改名按钮（否则预填空串，一点保存就清掉原名）", () => {
    expect(src).toMatch(
      /\{detail\.data !== undefined && \(\s*<Tappable[\s\S]*?onPress=\{openRename\}/,
    );
  });

  it("404 空态正文里的编号截断", () => {
    expect(src).toMatch(
      /t\("device\.goneBody", \{ id: shortDeviceId\(deviceId\) \}\)/,
    );
    expect(src).not.toMatch(/t\("device\.goneBody", \{ id: deviceId \}\)/);
  });
});
