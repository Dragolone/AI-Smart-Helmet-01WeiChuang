import { Injectable, Logger } from '@nestjs/common';
import type { DeviceStatusPayload } from '@helmet/shared';
import {
  CLOCK_SKEW_THRESHOLD_MS,
  businessTime,
  isBackfill,
} from '../common/device-time';
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

/** 会改快照状态字段（电量 / 充电 / 信号 / 休眠）的事件 */
const STATUS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'device_status',
  'sleep_entered',
  'sleep_exited',
]);

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
    // 补传的旧事件（App 攒着的离线队列、头盔离线缓存）只读不写：原来按到达顺序覆盖，2 小时前的心跳会把电量 / 固件号写回旧值，
    // 一批迟到的上传还会把已关机的头盔显示成「在线」（10-17 评审，观察项 16）。绑定关系照样要带回（SOS 归属靠它）
    if (isBackfill(e.timestamp, new Date())) {
      return this.prisma.device.findUnique({
        where: { deviceId: e.deviceId },
        select: SNAPSHOT_SELECT,
      });
    }
    const now = new Date();
    const data: Record<string, unknown> = {
      lastSeenAt: now,
      firmwareVersion: e.firmwareVersion,
    };

    if (
      STATUS_EVENT_TYPES.has(e.eventType) &&
      (await this.newerStatusApplied(e, now))
    ) {
      // 乱序到达的旧状态：重连时实时心跳先到、几分钟前的补传心跳后到（5 分钟内不算 isBackfill）。原来按到达顺序覆盖，
      // 电量 / 充电回退成旧值并经 WS 推给 App，要等下一次心跳（默认 60 s）才恢复（10-17 第二轮评审 r3）。只刷新在线时间
      delete data.firmwareVersion;
    } else if (e.eventType === 'device_status') {
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

  /**
   * 这台设备是否已经收到过业务时间更晚的状态类事件（不含本条）。只看最近 10 分钟到达的：
   * 本条不是补传（业务时间在 5 分钟内），比它新的那条业务时间也在 5 分钟内，最多超前收到时间 5 分钟就会被兜底成收到时间。
   * 业务时间同 businessTime（与电量曲线同一个 CASE）。查询失败按「没有」处理，不影响快照刷新。
   */
  private async newerStatusApplied(
    e: ValidEnvelope,
    receivedAt: Date,
  ): Promise<boolean> {
    const at = businessTime(e.timestamp, receivedAt).toISOString();
    const since = new Date(
      receivedAt.getTime() - 2 * CLOCK_SKEW_THRESHOLD_MS,
    ).toISOString();
    try {
      const rows = await this.prisma.$queryRaw<{ one: number }[]>`
        SELECT 1 AS one FROM raw_events
        WHERE device_id = ${e.deviceId}
          AND event_type IN ('device_status', 'sleep_entered', 'sleep_exited')
          AND event_id <> ${e.eventId}
          AND received_at > ${since}::timestamp
          AND CASE
                WHEN "timestamp" > received_at + interval '5 minutes'
                  OR "timestamp" < received_at - interval '72 hours'
                THEN received_at
                ELSE "timestamp"
              END > ${at}::timestamp
        LIMIT 1`;
      return rows.length > 0;
    } catch (err) {
      this.logger.warn(
        `乱序状态检查失败，按最新处理 ${e.deviceId}：${errorMessage(err)}`,
      );
      return false;
    }
  }
}
