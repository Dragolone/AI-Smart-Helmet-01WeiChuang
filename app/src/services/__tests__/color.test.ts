import { describe, expect, it } from "@jest/globals";

import { mixHex, withAlpha } from "../color";

describe("颜色小工具", () => {
  it("withAlpha：主题色加透明度", () => {
    expect(withAlpha("#4ADE80", 0.24)).toBe("rgba(74, 222, 128, 0.24)");
    expect(withAlpha("#0B0C0E", 0)).toBe("rgba(11, 12, 14, 0)");
  });

  it("mixHex：按比例盖色，结果是实色", () => {
    expect(mixHex("#000000", "#FFFFFF", 0)).toBe("#000000");
    expect(mixHex("#000000", "#FFFFFF", 1)).toBe("#ffffff");
    // 近黑底上盖 10% 的白：电量环底环的颜色
    expect(mixHex("#0B0C0E", "#FFFFFF", 0.1)).toBe("#232426");
  });
});
