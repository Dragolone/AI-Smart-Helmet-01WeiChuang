import { Injectable, Logger } from '@nestjs/common';
import type { DeviceStatusPayload } from '@helmet/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { ValidEnvelope } from '../ingest/envelope';

const isIntInRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * device_status payload 逐字段收敛（EVENTS.md 4.1 值域：battery 0–100，signalLevel 0–4）。
 * 越界/类型错的字段按缺失处理——绝不能因为固件发飞一个字段就让整条快照更新失败（那会让设备"离线"）。
 */
export function normalizeDeviceStatus(payload: Record<string, unknown>): {
  battery?: number;
  charging?: boolean;
  signalLevel?: number;
  sleeping?: boolean;
} {
  const p = payload as Partial<DeviceStatusPayload>;
  const out: ReturnType<typeof normalizeDeviceStatus> = {};
  if (isIntInRange(p.battery, 0, 100)) out.battery = p.battery;
  if (typeof p.charging === 'boolean') out.charging = p.charging;
  if (isIntInRange(p.signalLevel, 0, 4)) out.signalLevel = p.signalLevel;
  if (typeof p.sleeping === 'boolean') out.sleeping = p.sleeping;
  return out;
}

/**
 * 设备状态快照：Ingest 每收到一条已注册设备的合法事件就更新 Device 表，
 * App 的"在线/电量/固件"从这里读。未注册设备（updateMany 命中 0 行）静默跳过——
 * 原始事件仍在 raw_events 留档，业务侧不为它建影子设备。
 */
@Injectable()
export class DeviceSnapshotService {
  private readonly logger = new Logger(DeviceSnapshotService.name);

  constructor(private readonly prisma: PrismaService) {}

  async applyEvent(e: ValidEnvelope): Promise<void> {
    const data: Record<string, unknown> = {
      lastSeenAt: new Date(),
      firmwareVersion: e.firmwareVersion,
    };

    if (e.eventType === 'device_status') {
      Object.assign(data, normalizeDeviceStatus(e.payload));
    } else if (e.eventType === 'sleep_entered') {
      data.sleeping = true;
    } else if (e.eventType === 'sleep_exited') {
      data.sleeping = false;
    }

    try {
      await this.prisma.device.updateMany({
        where: { deviceId: e.deviceId },
        data,
      });
    } catch (err) {
      // 快照失败不影响事件落库主流程
      this.logger.warn(
        `设备快照更新失败 ${e.deviceId}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
