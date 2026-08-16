// 坐标工具（决策 #33：wgs84→gcj02 转换在 App 端 Map 组件层做，纯函数、离线、确定性）。
// 后端只存原始坐标 + coordinateSystem，App 展示前按需转换。
import type { LocationPoint } from '@helmet/shared';

export interface LngLat {
  longitude: number;
  latitude: number;
}

const PI = Math.PI;
const A = 6378245.0; // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323; // 偏心率平方

/** 中国境外不做 GCJ-02 偏移（与高德官方 convertFrom 行为一致） */
function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret =
    300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
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
export function toGcj02(point: Pick<LocationPoint, 'longitude' | 'latitude' | 'coordinateSystem'>): LngLat {
  if (point.coordinateSystem === 'gcj02') {
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
    Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
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
