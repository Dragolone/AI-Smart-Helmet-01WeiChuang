import { describe, expect, it } from "@jest/globals";

import { parseBindQr } from "../bind-qr";

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
