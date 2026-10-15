// 绑定二维码解析与扫码分流的边界补测（2026-10-16）。edge-bind-qr-push.test.ts 已钉长度、绑定码、空白 / BOM、
// 编码、子域名、裸码注入；这里补出码脚本可配的地址写法（结尾斜杠）、片段 / 多余参数、像而不是的地址、分流的边。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import { bindLinkInManualInput, classifyScan, parseBindQr } from "../bind-qr";

const OK = { deviceId: "helmet_94173f", bindCode: "94041564" };

describe("parseBindQr：地址写法", () => {
  // backend provision-batch 的 --qr-base 可配；写成 https://01weichuang.com/bind/ 时码是 …/bind/?d=…
  it("bind 后面多一个斜杠也认（https 与 helmet:// 两种）", () => {
    expect(
      parseBindQr("https://01weichuang.com/bind/?d=helmet_94173f&c=94041564"),
    ).toEqual(OK);
    expect(parseBindQr("helmet://bind/?d=helmet_94173f&c=94041564")).toEqual(
      OK,
    );
  });

  it("出码脚本默认地址生成的码（provision-batch qrContent）照常认", () => {
    expect(
      parseBindQr("https://01weichuang.com/bind?d=helmet_94173f&c=94041564"),
    ).toEqual(OK);
    expect(
      parseBindQr("http://www.01weichuang.com/bind?d=helmet_94173f&c=94041564"),
    ).toEqual(OK);
  });

  it("参数顺序颠倒、夹着别的参数（推广追踪参数）都不影响", () => {
    expect(
      parseBindQr(
        "https://01weichuang.com/bind?utm_source=box&c=94041564&from=card&d=helmet_94173f",
      ),
    ).toEqual(OK);
  });

  it("参数放在 # 后面（片段）不认设备号——它不是查询参数", () => {
    expect(
      parseBindQr("https://01weichuang.com/bind#d=helmet_94173f&c=94041564"),
    ).toBeNull();
  });

  it("参数被 HTML 转义成 &amp;：设备号还在，绑定码丢掉改手输", () => {
    expect(
      parseBindQr(
        "https://01weichuang.com/bind?d=helmet_94173f&amp;c=94041564",
      ),
    ).toEqual({
      deviceId: "helmet_94173f",
      bindCode: null,
    });
  });

  it("路径不是 bind（bindings、binder、bind/x）：不当绑定码", () => {
    for (const raw of [
      "https://01weichuang.com/bindings?d=helmet_94173f",
      "https://01weichuang.com/binder?d=helmet_94173f",
      "https://01weichuang.com/bind/x?d=helmet_94173f",
      "https://01weichuang.com/other/bind?d=helmet_94173f",
    ]) {
      expect(parseBindQr(raw)).toBeNull();
    }
  });

  it("别的网站的 /bind 地址：整串不是合法设备号，拒绝", () => {
    expect(
      parseBindQr("https://example.com/bind?d=helmet_94173f&c=94041564"),
    ).toBeNull();
    expect(
      parseBindQr("https://01weichuang.com.evil.com/bind?d=helmet_94173f"),
    ).toBeNull();
  });

  it("设备号带空格（+ 解码成空格）、或参数为空：拒绝", () => {
    expect(parseBindQr("helmet://bind?d=helmet+001&c=94041564")).toBeNull();
    expect(parseBindQr("helmet://bind?d=&c=94041564")).toBeNull();
    expect(parseBindQr("helmet://bind?c=94041564")).toBeNull();
    expect(parseBindQr("helmet://bind")).toBeNull();
    expect(parseBindQr("helmet://bind/")).toBeNull();
  });

  it("参数值两头的空格（编码成 %20）去掉再认", () => {
    expect(
      parseBindQr("helmet://bind?d=%20helmet_94173f%20&c=%2094041564"),
    ).toEqual(OK);
  });

  it("同名参数出现两次取第一个", () => {
    expect(
      parseBindQr(
        "helmet://bind?d=helmet_first&d=helmet_second&c=11111111&c=22222222",
      ),
    ).toEqual({ deviceId: "helmet_first", bindCode: "11111111" });
  });

  it("绑定码是全零 / 前导零：8 位数字就认，不当成数字吃掉前导零", () => {
    expect(parseBindQr("helmet://bind?d=helmet_1&c=00000000")?.bindCode).toBe(
      "00000000",
    );
    expect(parseBindQr("helmet://bind?d=helmet_1&c=00012345")?.bindCode).toBe(
      "00012345",
    );
  });

  it("裸码：下划线、连字符、大小写混写都认，原样保留大小写", () => {
    expect(parseBindQr("Helmet-ABC_def")).toEqual({
      deviceId: "Helmet-ABC_def",
      bindCode: null,
    });
  });

  it("超长的码（扫到一大段文字）不抛、不卡，直接拒绝", () => {
    expect(parseBindQr("x".repeat(100_000))).toBeNull();
    expect(parseBindQr(`helmet://bind?d=${"a".repeat(100_000)}`)).toBeNull();
  });
});

describe("classifyScan 的边", () => {
  it("这次刚绑的那顶又扫到：不管码里带不带绑定码都是「已绑上」", () => {
    const bound = new Set(["helmet_94173f"]);
    expect(
      classifyScan("helmet://bind?d=helmet_94173f&c=94041564", bound),
    ).toEqual({
      kind: "alreadyBound",
      deviceId: "helmet_94173f",
    });
    expect(classifyScan("helmet_94173f", bound)).toEqual({
      kind: "alreadyBound",
      deviceId: "helmet_94173f",
    });
  });

  it("大小写不同不算同一顶（设备号区分大小写，以服务器为准）", () => {
    expect(classifyScan("HELMET_94173F", new Set(["helmet_94173f"])).kind).toBe(
      "needCode",
    );
  });

  it("空串、纯空白：不是绑定码", () => {
    expect(classifyScan("", new Set())).toEqual({ kind: "notBindCode" });
    expect(classifyScan("   ", new Set())).toEqual({ kind: "notBindCode" });
  });

  it("结尾带斜杠的码照常直接绑", () => {
    expect(
      classifyScan(
        "https://01weichuang.com/bind/?d=helmet_94173f&c=94041564",
        new Set(),
      ),
    ).toEqual({
      kind: "bind",
      ...OK,
    });
  });
});

describe("bindLinkInManualInput：手动输入框里粘进绑定链接", () => {
  it("https / helmet:// 链接：拆出设备号和绑定码", () => {
    expect(
      bindLinkInManualInput(
        "https://01weichuang.com/bind?d=helmet_94173f&c=94041564",
      ),
    ).toEqual(OK);
    expect(
      bindLinkInManualInput("  helmet://bind?d=helmet_94173f&c=94041564\n"),
    ).toEqual(OK);
  });

  it("链接里只有设备号：拆出设备号，绑定码为空（输入框里已填的绑定码不动）", () => {
    expect(
      bindLinkInManualInput("https://01weichuang.com/bind?d=helmet_94173f"),
    ).toEqual({
      deviceId: "helmet_94173f",
      bindCode: null,
    });
  });

  it("就是设备号本身、半截输入、别的文字：返回 null，输入框照原样显示", () => {
    for (const raw of [
      "helmet_94173f",
      "helm",
      "",
      "设备编号：helmet_94173f",
      "http",
    ]) {
      expect(bindLinkInManualInput(raw)).toBeNull();
    }
  });

  it("别的网站的链接：认不出（null），不会把整条链接拆成设备号", () => {
    expect(
      bindLinkInManualInput(
        "https://example.com/bind?d=helmet_94173f&c=94041564",
      ),
    ).toBeNull();
  });
});

describe("接线：绑定页手动输入（源码不变式）", () => {
  it("设备号输入框粘进链接时拆开填", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "app", "bind-device.tsx"),
      "utf8",
    );
    expect(src).toMatch(/const link = bindLinkInManualInput\(v\);/);
    expect(src).toMatch(/setIdVal\(link\.deviceId\);/);
    expect(src).toMatch(/if \(link\.bindCode\) setCodeVal\(link\.bindCode\);/);
  });
});
