import { Injectable, Logger } from '@nestjs/common';
import { DeviceSnapshotService } from '../devices/device-snapshot.service';
import { LocationRecorderService } from '../locations/location-recorder.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePushService } from '../realtime/realtime-push.service';
import { SosTriggerService } from '../sos/sos-trigger.service';
import { Prisma } from '../generated/prisma/client';
import {
  buildInvalidRecord,
  validateEnvelope,
  type ValidEnvelope,
} from './envelope';

export type IngestOutcome = 'stored' | 'duplicate' | 'stored_invalid';
export type IngestSource = 'mqtt' | 'webhook';

/** 设备时钟偏移阈值（DEVICE_PROTOCOL §8，默认 5 分钟）。
 *  注：补传事件本应豁免此标记，但补传语义待设备离线缓存实装后才能识别（§6 ⚠️），当前一律按偏差判定。 */
const CLOCK_SKEW_THRESHOLD_MS = 5 * 60_000;

/** §11 WS 分流：risk_event（详情级）与 device_event（列表项级）各自的事件类型集合 */
const RISK_EVENT_TYPES = new Set([
  'collision_risk',
  'obstacle_risk',
  'risk_cleared',
]);
const DEVICE_EVENT_TYPES = new Set([
  'sleep_entered',
  'sleep_exited',
  'bluetooth_lost',
  'video_ready',
]);

/** EVENTS.md 4.5 objectType 已知集合（⚠️ 待算法确认；未知值原样留档并告警） */
const KNOWN_OBJECT_TYPES = new Set([
  'vehicle',
  'pedestrian',
  'obstacle',
  'unknown',
]);

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: DeviceSnapshotService,
    private readonly locationRecorder: LocationRecorderService,
    private readonly push: RealtimePushService,
    private readonly sosTrigger: SosTriggerService,
  ) {}

  /** 所有入口（MQTT / 未来的 Webhook / Mock）都汇聚到这里；返回值仅用于日志与测试。 */
  async ingestRaw(
    raw: string,
    topicDeviceId: string,
    source: IngestSource,
  ): Promise<IngestOutcome> {
    const result = validateEnvelope(raw, topicDeviceId);

    if (!result.ok) {
      this.logger.warn(
        `校验失败事件已按原样落库（不进业务流程）：reason=${result.reason} device=${topicDeviceId}`,
      );
      await this.persist(
        buildInvalidRecord(topicDeviceId, raw, result.reason),
        source,
      );
      return 'stored_invalid';
    }

    const stored = await this.persist(result.envelope, source);
    if (stored) {
      await this.dispatchStored(result.envelope);
    }
    return stored ? 'stored' : 'duplicate';
  }

  /**
   * 入库成功后的业务分发：快照 → 位置表 → WS 推送。
   * 只对已注册设备生效（未注册的仅 raw 留档）；推送只发给绑定用户。
   */
  private async dispatchStored(e: ValidEnvelope): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { deviceId: e.deviceId },
      select: { deviceId: true, bindUserId: true },
    });
    if (!device) return;

    await this.snapshot.applyEvent(e);

    // 位置表只收校验通过的 location_update；推送复用同一份校验结果（不推脏数据）
    const point =
      e.eventType === 'location_update'
        ? await this.locationRecorder.record(e)
        : null;

    // SOS 状态机入口（Week 7-8）：内部吞错——与副表同哲学，失败大声留日志、raw 可回放
    if (e.eventType === 'possible_fall' || e.eventType === 'manual_sos') {
      await this.sosTrigger.handleTrigger(e, device.bindUserId);
    }

    // 危险事件数据质量告警（EVENTS.md 4.5）：objectType 未知值原样留档但要出声，供与算法团队对口径
    if (RISK_EVENT_TYPES.has(e.eventType)) {
      const objectType = (e.payload as { objectType?: unknown }).objectType;
      if (
        typeof objectType === 'string' &&
        !KNOWN_OBJECT_TYPES.has(objectType)
      ) {
        this.logger.warn(
          `危险事件携带未知 objectType="${objectType}"（已原样留档）：${e.eventId}`,
        );
      }
    }

    if (device.bindUserId) {
      if (e.eventType === 'device_status') {
        this.push.pushDeviceStatus(device.bindUserId, e);
      } else if (point) {
        this.push.pushLocation(device.bindUserId, e.deviceId, point);
      } else if (RISK_EVENT_TYPES.has(e.eventType)) {
        this.push.pushRiskEvent(device.bindUserId, e);
      } else if (DEVICE_EVENT_TYPES.has(e.eventType)) {
        this.push.pushDeviceEvent(device.bindUserId, e);
      }
    }
  }

  /** eventId 幂等：唯一约束兜底并发，重复上报只存一次（EVENTS.md §2）。 */
  private async persist(
    e: ValidEnvelope,
    source: IngestSource,
  ): Promise<boolean> {
    const receivedAt = new Date();
    const clockSkew =
      Math.abs(e.timestamp.getTime() - receivedAt.getTime()) >
      CLOCK_SKEW_THRESHOLD_MS;
    if (clockSkew) {
      this.logger.warn(
        `clock_skew：设备 ${e.deviceId} 事件 ${e.eventId} 的 timestamp 与服务器时间偏差超阈值`,
      );
    }
    try {
      await this.prisma.rawEvent.create({
        data: {
          eventId: e.eventId,
          deviceId: e.deviceId,
          eventType: e.eventType,
          timestamp: e.timestamp,
          receivedAt,
          schemaVersion: e.schemaVersion,
          firmwareVersion: e.firmwareVersion,
          payload: e.payload as Prisma.InputJsonValue,
          source,
          clockSkew,
        },
      });
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.debug(`重复 eventId 已跳过：${e.eventId}`);
        return false;
      }
      throw err;
    }
  }
}
