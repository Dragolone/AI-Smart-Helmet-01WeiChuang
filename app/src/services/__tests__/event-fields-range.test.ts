import { describe, expect, it } from "@jest/globals";

import { readableEventFields, riskLevelOf } from "../event-fields";

const t = (key: string) => key;
const labels = (p: Record<string, unknown>) =>
  readableEventFields(p, t as never).map((f) => `${f.label}=${f.value}`);

describe("riskLevelOf：未知档位按 high 兜底（EVENTS.md 4.5，10-16）", () => {
  it.each([
    ["high", "high"],
    ["medium", "medium"],
    ["low", "low"],
    ["extreme", "high"],
    ["", "high"],
    ["constructor", "high"],
    ["__proto__", "high"],
  ])("%p → %p", (v, expected) => {
    expect(riskLevelOf({ riskLevel: v })).toBe(expected);
  });

  it("不是字符串 / 缺省：没有档位", () => {
    expect(riskLevelOf({})).toBeNull();
    expect(riskLevelOf({ riskLevel: 3 })).toBeNull();
    expect(riskLevelOf({ riskLevel: null })).toBeNull();
  });
});

describe("readableEventFields：数值越界不显示（10-16 模拟器看到「-5.0 m」「1e+308 m」）", () => {
  it("距离：负数、超过 6553.5、无穷、NaN 都不显示；边界值显示", () => {
    for (const distance of [
      -5,
      6553.6,
      1e308,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ]) {
      expect(labels({ distance })).toEqual([]);
    }
    expect(labels({ distance: 0 })).toEqual(["events.field.distance=0.0 m"]);
    expect(labels({ distance: 6553.5 })).toEqual([
      "events.field.distance=6553.5 m",
    ]);
  });

  it("置信度只认 0–1；倾角只认 0–360；逼近速度只认 0–255", () => {
    expect(labels({ confidence: 1.5 })).toEqual([]);
    expect(labels({ confidence: 0.9 })).toEqual([
      "events.field.confidence=90%",
    ]);
    expect(labels({ tiltDeg: 400 })).toEqual([]);
    expect(labels({ approachSpeedKmh: -3 })).toEqual([]);
    expect(labels({ approachSpeedKmh: 45 })).toEqual([
      "events.field.approachSpeed=45 km/h",
    ]);
  });

  it("TTC 为 0 照常显示（马上就撞，正是要看的）", () => {
    expect(labels({ ttcSeconds: 0 })).toEqual(["events.field.ttc=0.0 s"]);
  });
});
