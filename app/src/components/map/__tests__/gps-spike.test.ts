import { describe, expect, it } from "@jest/globals";

import { dropGpsSpikes, GLITCH_MPS, plausibleSpeed } from "../coords";
import { dropImplausibleFixes } from "@/hooks/use-rides";

// 深圳一条往北的路：每 5 s 前进约 25 m（5 m/s）
const t0 = Date.parse("2026-10-16T02:00:00.000Z");
const fix = (i: number, lat = 22.54 + i * 0.000225, lng = 113.94) => ({
  latitude: lat,
  longitude: lng,
  timestamp: new Date(t0 + i * 5000).toISOString(),
  id: i,
});
const ride = (n: number) => Array.from({ length: n }, (_, i) => fix(i));
const BEIJING = { lat: 39.9042, lng: 116.4074 };

describe("dropGpsSpikes：去掉飞出去又飞回来的定位点（10-16 N15）", () => {
  it("没有飞点：原数组原样返回（引用不变）", () => {
    const pts = ride(20);
    expect(dropGpsSpikes(pts)).toBe(pts);
  });

  it("中间一个点跳到北京：去掉它，其余不动", () => {
    const pts = ride(20);
    pts[10] = fix(10, BEIJING.lat, BEIJING.lng);
    const out = dropGpsSpikes(pts);
    expect(out.map((p) => p.id)).toEqual(
      ride(20)
        .map((p) => p.id)
        .filter((id) => id !== 10),
    );
  });

  it("连续 3 个飞点：一起去掉", () => {
    const pts = ride(20);
    for (const i of [7, 8, 9])
      pts[i] = fix(i, BEIJING.lat, BEIJING.lng + i * 0.001);
    expect(dropGpsSpikes(pts).map((p) => p.id)).not.toEqual(
      expect.arrayContaining([7, 8, 9]),
    );
    expect(dropGpsSpikes(pts)).toHaveLength(17);
  });

  it("连续 4 个以上：不当漂移（可能真换了地方），原样保留", () => {
    const pts = ride(20);
    for (const i of [5, 6, 7, 8]) pts[i] = fix(i, BEIJING.lat, BEIJING.lng);
    expect(dropGpsSpikes(pts)).toHaveLength(20);
  });

  it("最后一个点飞出去：后面没有点能证明它是漂移，保留", () => {
    const pts = ride(10);
    pts[9] = fix(9, BEIJING.lat, BEIJING.lng);
    expect(dropGpsSpikes(pts)).toHaveLength(10);
  });

  it("时间相同或倒序的点不据速度判断，保留", () => {
    const pts = ride(5);
    pts[2] = {
      ...fix(2, BEIJING.lat, BEIJING.lng),
      timestamp: pts[1].timestamp,
    };
    expect(dropGpsSpikes(pts)).toHaveLength(5);
  });

  it("不到 3 个点：原样返回", () => {
    const two = [fix(0), fix(1, BEIJING.lat, BEIJING.lng)];
    expect(dropGpsSpikes(two)).toBe(two);
  });

  it("正好 GLITCH_MPS 的速度算正常（边界不剔）", () => {
    const pts = ride(3);
    // 第 1 点相对第 0 点 5 s 走 GLITCH_MPS*5 米：纬度 1° ≈ 111.195 km
    pts[1] = fix(1, 22.54 + (GLITCH_MPS * 5) / 111_195 - 1e-7);
    pts[2] = fix(2, pts[1].latitude + 0.000225);
    expect(dropGpsSpikes(pts)).toHaveLength(3);
  });
});

describe("dropImplausibleFixes：(0,0) 和飞点一起去", () => {
  it("两种都有：都去掉；都没有：原对象原样返回", () => {
    const pts = ride(12);
    pts[3] = fix(3, 0, 0);
    pts[8] = fix(8, BEIJING.lat, BEIJING.lng);
    const out = dropImplausibleFixes({ points: pts, total: 12 });
    expect(out.points.map((p) => p.id)).toEqual([
      0, 1, 2, 4, 5, 6, 7, 9, 10, 11,
    ]);
    const clean = { points: ride(5), total: 5 };
    expect(dropImplausibleFixes(clean)).toBe(clean);
  });
});

describe("plausibleSpeed：最高速度不像真的就不显示", () => {
  it.each([
    [0, 0],
    [12.5, 12.5],
    [GLITCH_MPS, GLITCH_MPS],
    [GLITCH_MPS + 0.1, null],
    [400, null],
    [-1, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    [undefined, null],
  ])("%p → %p", (input, expected) => {
    expect(plausibleSpeed(input as number | null | undefined)).toBe(expected);
  });
});
