import { Injectable, Logger } from '@nestjs/common';
import type { DeviceStatusPayload } from '@helmet/shared';
import { errorMessage } from '../common/error-text';
import { isRecordNotFound } from '../common/prisma-errors';
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
 * 快照更新后带回的绑定关系与状态快照：Ingest 据此决定 SOS 归属与推送对象；
 * WS device_status 推的是这份快照（API.md §11：§4 status 对象），不是单条心跳——
 * 心跳缺字段或带越界值（battery=255）时，快照保留上一次的有效值，推单条心跳会把 App 上的电量刷成「--」
 */
export interface DeviceSnapshot {
  bindUserId: string | null;
  lastSeenAt: Date | null;
  battery: number | null;
  charging: boolean | null;
  signalLevel: number | null;
  sleeping: boolean;
  firmwareVersion: string | null;
}

const SNAPSHOT_SELECT = {
  bindUserId: true,
  lastSeenAt: true,
  battery: true,
  charging: true,
  signalLevel: true,
  sleeping: true,
  firmwareVersion: true,
} as const;

/**
 * 设备状态快照：Ingest 每收到一条已注册设备的合法事件就更新 Device 表，
 * App 的"在线/电量/固件"从这里读。未注册设备不建影子设备——原始事件仍在 raw_events 留档。
 */
@Injectable()
export class DeviceSnapshotService {
  private readonly logger = new Logger(DeviceSnapshotService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 刷新快照并带回当前绑定用户；未注册设备返回 null。
   * 一条 `UPDATE … RETURNING` 同时回答「注册了吗、绑给谁、快照已刷新、刷新后是什么」——原先是先查设备、
   * 再 updateMany（Prisma 给它包一层事务，BEGIN/UPDATE/COMMIT），每条事件四次往返，现在一次。
   * 快照写入失败不影响事件主流程，但绑定关系不能跟着丢（SOS 触发靠它），退回只读查询。
   */
  async applyEvent(e: ValidEnvelope): Promise<DeviceSnapshot | null> {
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
      return await this.prisma.device.update({
        where: { deviceId: e.deviceId },
        data,
        select: SNAPSHOT_SELECT,
      });
    } catch (err) {
      if (isRecordNotFound(err)) return null;
      this.logger.warn(`设备快照更新失败 ${e.deviceId}：${errorMessage(err)}`);
      return this.prisma.device.findUnique({
        where: { deviceId: e.deviceId },
        select: SNAPSHOT_SELECT,
      });
    }
  }
}
