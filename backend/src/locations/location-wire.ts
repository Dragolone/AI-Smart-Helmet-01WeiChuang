import type {
  CoordinateSystem,
  LocationPoint as WireLocationPoint,
} from '@helmet/shared';
import type { LocationPoint as DbLocationPoint } from '../generated/prisma/client';

/**
 * DB 行 → 线上格式（API.md §5 location 对象）：Date 显式转 ISO 字符串。
 * 只要求线上格式用到的列——轨迹查询据此只取这些列，id / eventId / deviceId 不进响应也就不必取。
 */
export function toWireLocation(
  p: Pick<DbLocationPoint, keyof WireLocationPoint>,
): WireLocationPoint {
  return {
    latitude: p.latitude,
    longitude: p.longitude,
    coordinateSystem: p.coordinateSystem as CoordinateSystem,
    accuracy: p.accuracy,
    speed: p.speed,
    heading: p.heading,
    altitude: p.altitude,
    timestamp: p.timestamp.toISOString(),
    receivedAt: p.receivedAt.toISOString(),
  };
}
