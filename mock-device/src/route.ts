/**
 * 内置剧本路线（WGS84）。相邻航点间距几十米，模拟器每个 tick 前进一个航点、
 * 到终点后循环。riding：深圳湾沿海绿道环路；ski：崇礼风格雪道（滑降 + 缆车回升）。
 */
export interface RoutePoint {
  latitude: number;
  longitude: number;
  /** 海拔（米）：滑雪剧本必带；骑行剧本省略（近海平面） */
  altitude?: number;
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
 * 开放路径细分：对每对相邻航点插值（含海拔），不含每段终点——多段拼接时不产生重复点。
 * 步长决定速度：step / 上报间隔 = 米每秒（如 30m/5s = 6m/s 骑行，80m/5s = 16m/s 滑降）。
 */
export function expandPath(points: RoutePoint[], stepMeters: number): RoutePoint[] {
  const expanded: RoutePoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segments = Math.max(1, Math.round(distanceMeters(a, b) / stepMeters));
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      const point: RoutePoint = {
        latitude: a.latitude + (b.latitude - a.latitude) * t,
        longitude: a.longitude + (b.longitude - a.longitude) * t,
      };
      if (a.altitude !== undefined && b.altitude !== undefined) {
        point.altitude = a.altitude + (b.altitude - a.altitude) * t;
      }
      expanded.push(point);
    }
  }
  return expanded;
}

/**
 * 环路细分：首尾自动闭合（骑行环路用）。原始航点间距上百米，直接按 5s 一点上报
 * 会得到 ~25m/s 的“摩托车速度”；细分到 ~30m 一步才是真实骑行（~6m/s）。
 */
export function expandRoute(points: RoutePoint[], stepMeters: number): RoutePoint[] {
  return expandPath([...points, points[0]], stepMeters);
}

/**
 * 滑雪剧本（崇礼风格，海拔 2110m → 1790m）：
 * S 弯滑降段（步长 80m ≈ 16m/s）+ 缆车回升段（步长 25m ≈ 5m/s），拼成完整循环。
 * 滑降终点与缆车起点、缆车终点与滑降起点相接。
 */
export const SKI_DOWNHILL: RoutePoint[] = [
  { latitude: 40.9490, longitude: 115.4180, altitude: 2110 },
  { latitude: 40.9502, longitude: 115.4196, altitude: 2072 },
  { latitude: 40.9509, longitude: 115.4183, altitude: 2041 },
  { latitude: 40.9521, longitude: 115.4199, altitude: 2003 },
  { latitude: 40.9530, longitude: 115.4218, altitude: 1968 },
  { latitude: 40.9538, longitude: 115.4204, altitude: 1935 },
  { latitude: 40.9550, longitude: 115.4221, altitude: 1897 },
  { latitude: 40.9560, longitude: 115.4240, altitude: 1861 },
  { latitude: 40.9569, longitude: 115.4226, altitude: 1830 },
  { latitude: 40.9580, longitude: 115.4243, altitude: 1802 },
  { latitude: 40.9585, longitude: 115.4255, altitude: 1790 },
];

export const SKI_LIFT: RoutePoint[] = [
  { latitude: 40.9585, longitude: 115.4255, altitude: 1790 },
  { latitude: 40.9553, longitude: 115.4230, altitude: 1896 },
  { latitude: 40.9521, longitude: 115.4205, altitude: 2003 },
  { latitude: 40.9490, longitude: 115.4180, altitude: 2110 },
];

/** 滑雪完整循环：滑降（快）→ 缆车（慢）→ 回到出发点 */
export function buildSkiLoop(): RoutePoint[] {
  return [...expandPath(SKI_DOWNHILL, 80), ...expandPath(SKI_LIFT, 25)];
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
