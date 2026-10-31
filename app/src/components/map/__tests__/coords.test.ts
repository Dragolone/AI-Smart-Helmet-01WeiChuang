// 坐标工具单测(决策 #33:转换在 App 端、纯函数——正适合单测钉住行为)
import { describe, expect, it } from '@jest/globals';

import { toGcj02, wgs84ToGcj02 } from '../coords';

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

describe('wgs84ToGcj02', () => {
  it('境内坐标产生偏移(深圳,偏移量应在数百米内)', () => {
    const r = wgs84ToGcj02(113.94712, 22.52648);
    expect(r.longitude).not.toBe(113.94712);
    expect(r.latitude).not.toBe(22.52648);
    const drift = distanceM(
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
