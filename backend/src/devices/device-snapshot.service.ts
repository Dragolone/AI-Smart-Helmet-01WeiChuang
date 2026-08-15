import { Injectable, Logger } from '@nestjs/common';
import type { DeviceStatusPayload } from '@helmet/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { ValidEnvelope } from '../ingest/envelope';

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
      // 类型来自 Contract（EVENTS.md 4.1）；设备侧输入不可信，运行时 typeof 校验保留
      const p = e.payload as Partial<DeviceStatusPayload>;
      if (typeof p.battery === 'number') data.battery = p.battery;
      if (typeof p.charging === 'boolean') data.charging = p.charging;
      if (typeof p.signalLevel === 'number') data.signalLevel = p.signalLevel;
      if (typeof p.sleeping === 'boolean') data.sleeping = p.sleeping;
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
