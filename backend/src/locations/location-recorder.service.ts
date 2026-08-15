import { Injectable, Logger } from '@nestjs/common';
import type {
  LocationUpdatePayload,
  LocationPoint as WireLocationPoint,
} from '@helmet/shared';
import { Prisma } from '../generated/prisma/client';
import type { ValidEnvelope } from '../ingest/envelope';
import { PrismaService } from '../prisma/prisma.service';
import { toWireLocation } from './location-wire';

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * 从事件 payload 提取合法位置（EVENTS.md 4.2 值域）；设备输入不可信，逐字段校验。
 * 不合法返回 null——原始事件已在 raw_events 留档，位置表只收干净数据。
 */
function extractLocation(
  payload: Record<string, unknown>,
):
  | (Omit<LocationUpdatePayload, 'altitude'> & { altitude: number | null })
  | null {
  const p = payload as Partial<LocationUpdatePayload>;
  if (!isFiniteNumber(p.latitude) || p.latitude < -90 || p.latitude > 90) {
    return null;
  }
  if (!isFiniteNumber(p.longitude) || p.longitude < -180 || p.longitude > 180) {
    return null;
  }
  if (p.coordinateSystem !== 'wgs84' && p.coordinateSystem !== 'gcj02') {
    return null;
  }
  if (!isFiniteNumber(p.accuracy) || p.accuracy < 0) return null;
  if (!isFiniteNumber(p.speed) || p.speed < 0) return null;
  if (!isFiniteNumber(p.heading) || p.heading < 0 || p.heading > 360) {
    return null;
  }
  return {
    latitude: p.latitude,
    longitude: p.longitude,
    coordinateSystem: p.coordinateSystem,
    accuracy: p.accuracy,
    speed: p.speed,
    heading: p.heading,
    altitude: isFiniteNumber(p.altitude) ? p.altitude : null,
  };
}

@Injectable()
export class LocationRecorderService {
  private readonly logger = new Logger(LocationRecorderService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * location_update 入位置表；返回入库的线上格式位置点（供 WS 推送），
   * payload 不合法或 eventId 重复时返回 null。
   * 失败只告警不抛出：与设备快照同哲学——副表失败不影响事件主流程，raw 留档可回填。
   */
  async record(e: ValidEnvelope): Promise<WireLocationPoint | null> {
    const loc = extractLocation(e.payload);
    if (!loc) {
      this.logger.warn(
        `location_update payload 不合法，不入位置表（raw 已留档）：${e.eventId}`,
      );
      return null;
    }
    try {
      const point = await this.prisma.locationPoint.create({
        data: {
          eventId: e.eventId,
          deviceId: e.deviceId,
          timestamp: e.timestamp,
          ...loc,
        },
      });
      return toWireLocation(point);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // eventId 已入过位置表（并发/重放），幂等跳过
        return null;
      }
      this.logger.warn(
        `位置点入库失败（raw 已留档）${e.eventId}：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
