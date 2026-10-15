// 电量三档的口径：≤10% 红、≤20% 黄、其余正常；边界值落在哪一档要钉死（首页大图、其他设备行、提醒都按它）
import { describe, expect, it } from "@jest/globals";

import {
  CRITICAL_BATTERY,
  LOW_BATTERY,
  batteryTierOf,
  isBatteryLow,
} from "../device-view";

describe("batteryTierOf", () => {
  it("两条线：20 以下（含）是 low，10 以下（含）是 critical", () => {
    expect(LOW_BATTERY).toBe(20);
    expect(CRITICAL_BATTERY).toBe(10);
    expect(batteryTierOf(100)).toBe("ok");
    expect(batteryTierOf(21)).toBe("ok");
    expect(batteryTierOf(20)).toBe("low");
    expect(batteryTierOf(11)).toBe("low");
    expect(batteryTierOf(10)).toBe("critical");
    expect(batteryTierOf(0)).toBe("critical");
  });

  it("没有电量数据是 none，不当成低电量", () => {
    expect(batteryTierOf(null)).toBe("none");
    expect(batteryTierOf(undefined)).toBe("none");
    expect(batteryTierOf(Number.NaN)).toBe("none");
  });

  it("critical 也算 low：原来按 isBatteryLow 走的提醒口径不变", () => {
    for (const v of [0, 5, 10, 15, 20]) {
      expect(isBatteryLow(v)).toBe(true);
      expect(batteryTierOf(v) === "low" || batteryTierOf(v) === "critical").toBe(
        true,
      );
    }
    expect(isBatteryLow(21)).toBe(false);
  });
});
