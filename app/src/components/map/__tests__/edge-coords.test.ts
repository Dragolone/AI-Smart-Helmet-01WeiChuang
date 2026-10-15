// 边界补测（2026-10-03）：坐标工具。coords.test.ts 只验了「深圳有偏移、悉尼不偏移」；
// 这里用外部公开向量钉住偏移算法本身，再补国界框四条边、跨 180° 经线、未知坐标系。
import { describe, expect, it } from "@jest/globals";

import {
  cumulativeMeters,
  haversineMeters,
  isPlausibleFix,
  toGcj02,
  wgs84ToGcj02,
} from "../coords";

describe("wgs84ToGcj02", () => {
  it("与开源 coordtransform 的公开样例一致（同一套克拉索夫斯基参数）", () => {
    const r = wgs84ToGcj02(116.404, 39.915);
    expect(r.longitude).toBeCloseTo(116.41024449916938, 9);
    expect(r.latitude).toBeCloseTo(39.91640428150164, 9);
  });

  it("全国各地的偏移量都在几十到几百米（乌鲁木齐 / 哈尔滨 / 三亚 / 拉萨 / 台北）", () => {
    for (const [lng, lat] of [
      [87.6168, 43.8256],
      [126.6424, 45.7567],
      [109.5119, 18.2528],
      [91.1322, 29.6604],
      [121.5654, 25.033],
    ]) {
      const drift = haversineMeters(
        { longitude: lng, latitude: lat },
        wgs84ToGcj02(lng, lat),
      );
      expect(drift).toBeGreaterThan(50);
      expect(drift).toBeLessThan(1000);
    }
  });

  it("国界框四条边：边上的点算境内（做偏移），刚出框的点原样返回", () => {
    const moved = (lng: number, lat: number) => {
      const r = wgs84ToGcj02(lng, lat);
      return r.longitude !== lng || r.latitude !== lat;
    };
    expect(moved(72.004, 30)).toBe(true);
    expect(moved(72.0039, 30)).toBe(false);
    expect(moved(137.8347, 30)).toBe(true);
    expect(moved(137.8348, 30)).toBe(false);
    expect(moved(105, 0.8293)).toBe(true);
    expect(moved(105, 0.8292)).toBe(false);
    expect(moved(105, 55.8271)).toBe(true);
    expect(moved(105, 55.8272)).toBe(false);
  });

  it("(0,0) 与南半球 / 西半球坐标原样返回，不产生 NaN", () => {
    for (const [lng, lat] of [
      [0, 0],
      [-122.4194, 37.7749],
      [151.2093, -33.8688],
      [-180, -90],
      [180, 90],
    ]) {
      expect(wgs84ToGcj02(lng, lat)).toEqual({ longitude: lng, latitude: lat });
    }
  });
});

describe("toGcj02：坐标系字段不是 gcj02 时", () => {
  it.each(["bd09", "GCJ02", "", undefined])(
    "coordinateSystem=%j 按 wgs84 处理（只有精确的小写 gcj02 才跳过偏移）",
    (cs) => {
      const p = {
        longitude: 113.95,
        latitude: 22.53,
        coordinateSystem: cs as "wgs84",
      };
      expect(toGcj02(p)).toEqual(wgs84ToGcj02(113.95, 22.53));
    },
  );
});

describe("haversineMeters", () => {
  it("跨 180° 经线走短弧：179.9°E → 179.9°W 约 22 km，而不是绕地球一圈", () => {
    const d = haversineMeters(
      { longitude: 179.9, latitude: 0 },
      { longitude: -179.9, latitude: 0 },
    );
    expect(d).toBeGreaterThan(22_000);
    expect(d).toBeLessThan(22_500);
  });

  it("对称：d(a,b) = d(b,a)；对跖点 = 半个地球周长且不是 NaN", () => {
    const a = { longitude: 113.94, latitude: 22.52 };
    const b = { longitude: 116.4, latitude: 39.9 };
    expect(haversineMeters(a, b)).toBe(haversineMeters(b, a));
    const half = haversineMeters(
      { longitude: 0, latitude: 45 },
      { longitude: 180, latitude: -45 },
    );
    expect(half).toBeCloseTo(Math.PI * 6371000, 3);
  });

  it("极点处不同经度是同一个点：距离约为 0", () => {
    expect(
      haversineMeters(
        { longitude: 0, latitude: 90 },
        { longitude: 123, latitude: 90 },
      ),
    ).toBeLessThan(0.001);
  });
});

describe("cumulativeMeters", () => {
  it("原地不动（连续重复点）里程不增长；不修改传入的数组", () => {
    const p = { longitude: 113.94, latitude: 22.52 };
    const q = { longitude: 113.95, latitude: 22.52 };
    const path = [p, p, p, q, q];
    const snapshot = JSON.stringify(path);
    const c = cumulativeMeters(path);
    expect(c.slice(0, 3)).toEqual([0, 0, 0]);
    expect(c[3]).toBeGreaterThan(1000);
    expect(c[4]).toBe(c[3]);
    expect(JSON.stringify(path)).toBe(snapshot);
  });

  it("往返一趟的里程是单程的两倍（累计的是路程不是位移）", () => {
    const a = { longitude: 113.94, latitude: 22.52 };
    const b = { longitude: 113.96, latitude: 22.54 };
    const c = cumulativeMeters([a, b, a]);
    expect(c[2]).toBeCloseTo(2 * haversineMeters(a, b), 6);
  });

  it("两千个点（24 h 轨迹量级）逐点单调不减", () => {
    const path = Array.from({ length: 2000 }, (_, i) => ({
      longitude: 113.9 + i * 1e-4,
      latitude: 22.5 + Math.sin(i / 50) * 1e-3,
    }));
    const c = cumulativeMeters(path);
    expect(c).toHaveLength(2000);
    for (let i = 1; i < c.length; i += 1)
      expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    expect(Number.isFinite(c[1999])).toBe(true);
  });
});

// 2026-10-15 边界测试：(0,0) 是 GPS 没定位时常见的占位值，不能当真位置画 / 导航
describe("isPlausibleFix", () => {
  it("正常位置、极点附近、南半球都算", () => {
    expect(isPlausibleFix({ latitude: 22.53, longitude: 113.94 })).toBe(true);
    expect(isPlausibleFix({ latitude: 89.9, longitude: 179.9 })).toBe(true);
    expect(isPlausibleFix({ latitude: -33.87, longitude: 151.21 })).toBe(true);
    expect(isPlausibleFix({ latitude: 0, longitude: 113.94 })).toBe(true);
  });
  it("(0,0)、越界、NaN / Infinity 不算", () => {
    expect(isPlausibleFix({ latitude: 0, longitude: 0 })).toBe(false);
    expect(isPlausibleFix({ latitude: 0.0000001, longitude: -0.0000001 })).toBe(
      false,
    );
    expect(isPlausibleFix({ latitude: 91, longitude: 10 })).toBe(false);
    expect(isPlausibleFix({ latitude: 10, longitude: -181 })).toBe(false);
    expect(isPlausibleFix({ latitude: Number.NaN, longitude: 10 })).toBe(false);
    expect(isPlausibleFix({ latitude: 10, longitude: Infinity })).toBe(false);
  });
});
