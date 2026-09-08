// 坐标工具单测(决策 #33:转换在 App 端、纯函数——正适合单测钉住行为)
import { describe, expect, it } from '@jest/globals';

import { cumulativeMeters, haversineMeters, toGcj02, wgs84ToGcj02 } from '../coords';

describe('wgs84ToGcj02', () => {
  it('境内坐标产生偏移(深圳,偏移量应在数百米内)', () => {
    const r = wgs84ToGcj02(113.94712, 22.52648);
    expect(r.longitude).not.toBe(113.94712);
    expect(r.latitude).not.toBe(22.52648);
    const drift = haversineMeters(
      { longitude: 113.94712, latitude: 22.52648 },
      r,
    );
    expect(drift).toBeGreaterThan(100);
    expect(drift).toBeLessThan(1500);
  });

  it('境外坐标原样返回(悉尼——高德官方 convertFrom 同行为)', () => {
    const r = wgs84ToGcj02(151.2093, -33.8688);
    expect(r).toEqual({ longitude: 151.2093, latitude: -33.8688 });
  });
});

describe('toGcj02', () => {
  it('gcj02 坐标不做二次偏移', () => {
    const p = { longitude: 113.95, latitude: 22.53, coordinateSystem: 'gcj02' as const };
    expect(toGcj02(p)).toEqual({ longitude: 113.95, latitude: 22.53 });
  });

  it('wgs84 坐标做转换', () => {
    const p = { longitude: 113.95, latitude: 22.53, coordinateSystem: 'wgs84' as const };
    expect(toGcj02(p)).toEqual(wgs84ToGcj02(113.95, 22.53));
  });
});

describe('haversineMeters', () => {
  it('同点距离为 0', () => {
    const p = { longitude: 113.95, latitude: 22.53 };
    expect(haversineMeters(p, p)).toBe(0);
  });

  it('赤道上经度差 1° ≈ 111.19 公里', () => {
    const d = haversineMeters(
      { longitude: 0, latitude: 0 },
      { longitude: 1, latitude: 0 },
    );
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });
});

describe('cumulativeMeters', () => {
  it('空/单点轨迹累计为 0', () => {
    expect(cumulativeMeters([])).toEqual([]);
    expect(cumulativeMeters([{ longitude: 0, latitude: 0 }])).toEqual([0]);
  });

  it('逐点单调不减,末项为全程', () => {
    const path = [
      { longitude: 113.94, latitude: 22.52 },
      { longitude: 113.95, latitude: 22.52 },
      { longitude: 113.95, latitude: 22.53 },
    ];
    const c = cumulativeMeters(path);
    expect(c).toHaveLength(3);
    expect(c[0]).toBe(0);
    expect(c[1]).toBeGreaterThan(0);
    expect(c[2]).toBeGreaterThan(c[1]);
    const total =
      haversineMeters(path[0], path[1]) + haversineMeters(path[1], path[2]);
    expect(c[2]).toBeCloseTo(total, 6);
  });
});
