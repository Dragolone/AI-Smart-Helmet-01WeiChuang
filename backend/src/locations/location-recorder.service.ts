import { Injectable, Logger } from '@nestjs/common';
import type {
  LocationUpdatePayload,
  LocationPoint as WireLocationPoint,
} from '@helmet/shared';
import { businessTime } from '../common/device-time';
import { errorMessage } from '../common/error-text';
import { dbRejectionCode, isUniqueViolation } from '../common/prisma-errors';
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
   * 数据库拒收这一条只告警不抛出（raw 已留档）；**瞬时故障（断连、关停、死锁）重抛**，让入口回 5xx、App / MQTT 重传，
   * 重传按重复走 recordIfMissing 把这个点补上。原来一律吞掉：入口回「已接受」，重传又回「重复」，
   * 这个点永远进不了轨迹（10-17 第二轮评审 r3）。
   */
  async record(e: ValidEnvelope): Promise<WireLocationPoint | null> {
    const loc = extractLocation(e.payload);
    if (!loc) {
      this.logger.warn(
        `location_update payload 不合法，不入位置表（raw 已留档）：${e.eventId}`,
      );
      return null;
    }
    // 头盔时钟错乱（RTC 归零报 1970、跑到 2099）时按收到时间入轨迹表，否则这些点在所有按时间段的查询里都看不到
    const receivedAt = new Date();
    try {
      const point = await this.prisma.locationPoint.create({
        data: {
          eventId: e.eventId,
          deviceId: e.deviceId,
          timestamp: businessTime(e.timestamp, receivedAt),
          receivedAt,
          ...loc,
        },
      });
      return toWireLocation(point);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // eventId 已入过位置表（并发/重放），幂等跳过
        return null;
      }
      if (dbRejectionCode(err) === null) throw err;
      this.logger.warn(
        `位置点入库失败（raw 已留档）${e.eventId}：${errorMessage(err)}`,
      );
      return null;
    }
  }

  /**
   * 重复上报的 location_update：raw 已在，但上一次可能在写位置表时遇到瞬时故障（见 record）。
   * 位置表里没有这一条、且设备已注册（与正常分发同条件）就补写一次；不推实时（已经是迟到的点）。
   */
  async recordIfMissing(e: ValidEnvelope): Promise<void> {
    const existing = await this.prisma.locationPoint.findUnique({
      where: { deviceId_eventId: { deviceId: e.deviceId, eventId: e.eventId } },
      select: { id: true },
    });
    if (existing) return;
    const device = await this.prisma.device.findUnique({
      where: { deviceId: e.deviceId },
      select: { deviceId: true },
    });
    if (!device) return;
    if (await this.record(e)) {
      this.logger.warn(`位置点补写（上次入库中断）：${e.eventId}`);
    }
  }
}
