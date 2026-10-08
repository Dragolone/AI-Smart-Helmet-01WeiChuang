import { describe, expect, it } from "@jest/globals";

import { classifyScan, parseBindQr } from "../bind-qr";

describe("parseBindQr", () => {
  it("parses the https form", () => {
    expect(
      parseBindQr("https://01weichuang.com/bind?d=helmet_94173f&c=12345678"),
    ).toEqual({ deviceId: "helmet_94173f", bindCode: "12345678" });
  });
  it("parses the helmet:// form and long param names", () => {
    expect(
      parseBindQr("helmet://bind?deviceId=helmet_1&code=00000001"),
    ).toEqual({
      deviceId: "helmet_1",
      bindCode: "00000001",
    });
  });
  it("accepts a bare deviceId and drops a malformed code", () => {
    expect(parseBindQr("  helmet_mock_001 ")).toEqual({
      deviceId: "helmet_mock_001",
      bindCode: null,
    });
    expect(parseBindQr("https://01weichuang.com/bind?d=helmet_1&c=12")).toEqual(
      {
        deviceId: "helmet_1",
        bindCode: null,
      },
    );
  });
  it("rejects a bind URL with no device id at all", () => {
    expect(parseBindQr("https://01weichuang.com/bind")).toBeNull();
    expect(parseBindQr("helmet://bind?c=12345678")).toBeNull();
  });
  it("rejects junk", () => {
    expect(parseBindQr("")).toBeNull();
    expect(
      parseBindQr("https://evil.com/bind?d=helmet_1&c=12345678"),
    ).toBeNull();
    expect(parseBindQr("hello world")).toBeNull();
    expect(parseBindQr("https://01weichuang.com/bind?d=<script>")).toBeNull();
  });
});

describe("classifyScan", () => {
  const none = new Set<string>();
  it("binds straight away when the code carries both parts", () => {
    expect(
      classifyScan("https://01weichuang.com/bind?d=helmet_1&c=12345678", none),
    ).toEqual({ kind: "bind", deviceId: "helmet_1", bindCode: "12345678" });
  });
  it("asks for the bind code when the code only carries the device id", () => {
    expect(classifyScan("helmet_mock_001", none)).toEqual({
      kind: "needCode",
      deviceId: "helmet_mock_001",
    });
    // 绑定码格式不对等同于没有：不拿半截的码去试
    expect(
      classifyScan("https://01weichuang.com/bind?d=helmet_1&c=12", none),
    ).toEqual({ kind: "needCode", deviceId: "helmet_1" });
  });
  it("does not bind again a helmet bound during this visit", () => {
    expect(
      classifyScan(
        "helmet://bind?d=helmet_1&c=12345678",
        new Set(["helmet_1"]),
      ),
    ).toEqual({ kind: "alreadyBound", deviceId: "helmet_1" });
    // 别的头盔不受影响
    expect(
      classifyScan(
        "helmet://bind?d=helmet_2&c=12345678",
        new Set(["helmet_1"]),
      ),
    ).toEqual({ kind: "bind", deviceId: "helmet_2", bindCode: "12345678" });
  });
  it("flags anything else as not a bind code", () => {
    expect(classifyScan("https://example.com/whatever", none)).toEqual({
      kind: "notBindCode",
    });
    expect(classifyScan("", none)).toEqual({ kind: "notBindCode" });
  });
});
