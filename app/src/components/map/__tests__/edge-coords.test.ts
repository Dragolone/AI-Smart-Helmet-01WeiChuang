// 边界补测（2026-10-03）：坐标工具。coords.test.ts 只验了「深圳有偏移、悉尼不偏移」；
// 这里用外部公开向量钉住偏移算法本身，再补国界框四条边、跨 180° 经线、未知坐标系。
import { describe, expect, it } from "@jest/globals";

import { isPlausibleFix, toGcj02, wgs84ToGcj02 } from "../coords";

// 偏移量用球面距离量（生产代码里不再留公开的距离函数）
const distanceM = (
  a: { longitude: number; latitude: number },
  b: { longitude: number; latitude: number },
) => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

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
      const drift = distanceM(
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
