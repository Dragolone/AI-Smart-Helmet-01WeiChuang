/**
 * 内置骑行路线：深圳湾公园沿海绿道的一段环路（WGS84）。
 * 相邻航点间距几十米，模拟器每个 tick 前进一个航点、到终点后原路循环。
 */
export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export const RIDING_LOOP: RoutePoint[] = [
  { latitude: 22.5219, longitude: 113.9401 },
  { latitude: 22.5223, longitude: 113.9412 },
  { latitude: 22.5228, longitude: 113.9424 },
  { latitude: 22.5234, longitude: 113.9436 },
  { latitude: 22.5241, longitude: 113.9447 },
  { latitude: 22.5249, longitude: 113.9457 },
  { latitude: 22.5258, longitude: 113.9466 },
  { latitude: 22.5267, longitude: 113.9473 },
  { latitude: 22.5277, longitude: 113.9478 },
  { latitude: 22.5287, longitude: 113.9481 },
  { latitude: 22.5297, longitude: 113.9480 },
  { latitude: 22.5306, longitude: 113.9475 },
  { latitude: 22.5313, longitude: 113.9466 },
  { latitude: 22.5317, longitude: 113.9455 },
  { latitude: 22.5316, longitude: 113.9443 },
  { latitude: 22.5311, longitude: 113.9432 },
  { latitude: 22.5303, longitude: 113.9423 },
  { latitude: 22.5293, longitude: 113.9417 },
  { latitude: 22.5282, longitude: 113.9413 },
  { latitude: 22.5271, longitude: 113.9410 },
  { latitude: 22.5260, longitude: 113.9407 },
  { latitude: 22.5249, longitude: 113.9405 },
  { latitude: 22.5238, longitude: 113.9403 },
  { latitude: 22.5228, longitude: 113.9402 },
];

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** 两点间大圆距离（米）。 */
export function distanceMeters(a: RoutePoint, b: RoutePoint): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * 把稀疏航点细分为固定步长的密集轨迹点：原始航点间距上百米，直接按 5s 一点上报
 * 会得到 ~25m/s 的“摩托车速度”；细分到 ~30m 一步才是真实骑行（~6m/s）。
 */
export function expandRoute(points: RoutePoint[], stepMeters: number): RoutePoint[] {
  const expanded: RoutePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const segments = Math.max(1, Math.round(distanceMeters(a, b) / stepMeters));
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      expanded.push({
        latitude: a.latitude + (b.latitude - a.latitude) * t,
        longitude: a.longitude + (b.longitude - a.longitude) * t,
      });
    }
  }
  return expanded;
}

/** a→b 的航向角（度，正北为 0 顺时针 0–360，对齐 EVENTS.md location_update.heading）。 */
export function headingDegrees(a: RoutePoint, b: RoutePoint): number {
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}
