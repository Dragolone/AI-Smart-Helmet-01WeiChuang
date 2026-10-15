// 坐标工具（决策 #33：wgs84→gcj02 转换在 App 端 Map 组件层做，纯函数、离线、确定性）。
// 后端只存原始坐标 + coordinateSystem，App 展示前按需转换。
import type { LocationPoint } from "@helmet/shared";

export interface LngLat {
  longitude: number;
  latitude: number;
}

const PI = Math.PI;
const A = 6378245.0; // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323; // 偏心率平方

/**
 * 这个定位能不能当成真位置用：数值有限、经纬度在范围内，且不是 (0,0)。
 * (0,0) 是很多 GPS 模组没定位时的占位值——当真画出来，地图停在几内亚湾、「导航到最后位置」也导到那里
 *（2026-10-15 边界测试）。真实骑行不会正好在赤道与本初子午线交点上。
 */
export function isPlausibleFix(p: {
  latitude: number;
  longitude: number;
}): boolean {
  const { latitude: lat, longitude: lng } = p;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return !(Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6);
}

/**
 * 相邻两点隐含速度超过它就当定位漂移（与服务端 locations/ride-stats.ts 的 GLITCH_MPS 同口径：
 * 自行车 / 滑雪不会到 200 km/h）。
 */
export const GLITCH_MPS = 55;

/** 速度（m/s）是否像真的：超过 GLITCH_MPS 的当漂移，显示成「—」而不是「最高 1440 km/h」 */
export function plausibleSpeed(mps: number | null | undefined): number | null {
  return mps != null && Number.isFinite(mps) && mps >= 0 && mps <= GLITCH_MPS
    ? mps
    : null;
}

const EARTH_M = 6_371_000;
function metersBetween(a: LngLat, b: LngLat): number {
  const rad = (d: number) => (d * PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

type TimedFix = LngLat & { timestamp: string };

/** a → b 的隐含速度（m/s）；时间不前进（同一时刻 / 倒序 / 解析不了）时返回 null，不据此判断 */
function impliedMps(a: TimedFix, b: TimedFix): number | null {
  const dt = (Date.parse(b.timestamp) - Date.parse(a.timestamp)) / 1000;
  if (!(dt > 0)) return null;
  return metersBetween(a, b) / dt;
}

/** 一段飞点最多认几个连续点：再长就不像漂移了（可能真的换了地方，比如上了车），原样保留 */
const MAX_SPIKE_RUN = 3;

/**
 * 去掉轨迹里的 GPS 飞点：从上一个保留的点跳过去超过 GLITCH_MPS，而往后 MAX_SPIKE_RUN 个点之内
 * 又有一个点从上一个保留点「正常速度」就能到——中间这几个就是飞出去又飞回来的漂移。
 * 服务端算里程时已经跳过这种段，但轨迹接口把点原样返回，地图上会一根直线拉到 2000 km 外再拉回来
 *（2026-10-16 模拟器 + 本地后端实测）。points 须按 timestamp 升序。
 */
export function dropGpsSpikes<T extends TimedFix>(points: T[]): T[] {
  if (points.length < 3) return points;
  const kept: T[] = [points[0]];
  let i = 1;
  while (i < points.length) {
    const prev = kept[kept.length - 1];
    const v = impliedMps(prev, points[i]);
    if (v === null || v <= GLITCH_MPS) {
      kept.push(points[i]);
      i += 1;
      continue;
    }
    let back = -1;
    for (let j = i + 1; j < points.length && j <= i + MAX_SPIKE_RUN; j++) {
      const w = impliedMps(prev, points[j]);
      if (w !== null && w <= GLITCH_MPS) {
        back = j;
        break;
      }
    }
    if (back === -1) {
      kept.push(points[i]);
      i += 1;
    } else {
      i = back;
    }
  }
  return kept.length === points.length ? points : kept;
}

/** 中国境外不做 GCJ-02 偏移（与高德官方 convertFrom 行为一致） */
function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) *
      2.0) /
    3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) *
      2.0) /
    3.0;
  return ret;
}

/** WGS-84 → GCJ-02（标准偏移算法，精度约 1–2 米，地图展示足够） */
export function wgs84ToGcj02(lng: number, lat: number): LngLat {
  if (outOfChina(lng, lat)) return { longitude: lng, latitude: lat };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { longitude: lng + dLng, latitude: lat + dLat };
}

/** 轨迹点 → 高德可用的 GCJ-02 坐标（gcj02 原样返回；未知坐标系按 wgs84 处理并由调用方留日志） */
export function toGcj02(
  point: Pick<LocationPoint, "longitude" | "latitude" | "coordinateSystem">,
): LngLat {
  if (point.coordinateSystem === "gcj02") {
    return { longitude: point.longitude, latitude: point.latitude };
  }
  return wgs84ToGcj02(point.longitude, point.latitude);
}

/** 两点球面距离（米），Haversine */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * PI) / 180;
  const dLng = ((b.longitude - a.longitude) * PI) / 180;
  const la = (a.latitude * PI) / 180;
  const lb = (b.latitude * PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 轨迹累计里程（米）：cumulative[i] = 起点到第 i 点的累计距离，供回放进度实时取值 */
export function cumulativeMeters(points: LngLat[]): number[] {
  const result: number[] = new Array<number>(points.length);
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) sum += haversineMeters(points[i - 1], points[i]);
    result[i] = sum;
  }
  return result;
}
