// 「最新定位」缓存只进不退：REST 轮询回来的点比 WS 先推来的旧，不能把缓存盖回去（2026-10-17 地图页复审）
import { describe, expect, it } from "@jest/globals";

import { newerFix } from "../coords";

const fix = (timestamp: string, tag = "") => ({ timestamp, tag });

describe("newerFix", () => {
  it("留时间更新的那个：next 更新取 next，prev 更新取 prev", () => {
    const a = fix("2026-10-17T03:00:00.000Z", "a");
    const b = fix("2026-10-17T03:00:05.000Z", "b");
    expect(newerFix(a, b)).toBe(b);
    expect(newerFix(b, a)).toBe(b);
  });

  it("一样新：取 next（同一个点重复推来时换成最新的一份）", () => {
    const a = fix("2026-10-17T03:00:00.000Z", "a");
    const b = fix("2026-10-17T03:00:00Z", "b");
    expect(newerFix(a, b)).toBe(b);
  });

  it("prev 没有 / 时间认不出：取 next", () => {
    const b = fix("2026-10-17T03:00:00.000Z");
    expect(newerFix(undefined, b)).toBe(b);
    expect(newerFix(null, b)).toBe(b);
    expect(newerFix(fix("not-a-date"), b)).toBe(b);
    expect(newerFix(fix(""), b)).toBe(b);
  });

  it("next 没有（接口说还没有位置）或时间认不出：留着 prev；两个都没有是 null", () => {
    const a = fix("2026-10-17T03:00:00.000Z");
    expect(newerFix(a, null)).toBe(a);
    expect(newerFix(a, undefined)).toBe(a);
    expect(newerFix(a, fix("garbage"))).toBe(a);
    expect(newerFix(null, null)).toBeNull();
    expect(newerFix(undefined, undefined)).toBeNull();
  });

  it("不同时区写法按真实时刻比", () => {
    const utc = fix("2026-10-17T03:00:00.000Z", "utc");
    const cst = fix("2026-10-17T11:00:01+08:00", "cst");
    expect(newerFix(utc, cst)).toBe(cst);
    expect(newerFix(cst, utc)).toBe(cst);
  });
});
