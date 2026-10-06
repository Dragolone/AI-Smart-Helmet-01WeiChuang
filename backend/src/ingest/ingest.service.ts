import { Injectable, Logger } from '@nestjs/common';
import { CLOCK_SKEW_THRESHOLD_MS } from '../common/device-time';
import { errorMessage } from '../common/error-text';
import { isUniqueViolation } from '../common/prisma-errors';
import { DeviceSnapshotService } from '../devices/device-snapshot.service';
import { LocationRecorderService } from '../locations/location-recorder.service';
import { MediaRecorderService } from '../media/media-recorder.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimePushService } from '../realtime/realtime-push.service';
import { SosTriggerService } from '../sos/sos-trigger.service';
import { Prisma } from '../generated/prisma/client';
import {
  SUPPORTED_SCHEMA_VERSIONS,
  buildInvalidRecord,
  validateEnvelope,
  type ValidEnvelope,
} from './envelope';

export type IngestOutcome = 'stored' | 'duplicate' | 'stored_invalid';
export type IngestSource = 'mqtt' | 'webhook' | 'app_relay';

export interface IngestOptions {
  /** 入口级事件类型白名单（如蓝牙版中转的 7 种）：合法 envelope 但类型超范围 → 按校验失败留档告警 */
  allowedEventTypes?: ReadonlySet<string>;
}

/** §11 WS 分流：risk_event（详情级）与 device_event（列表项级）各自的事件类型集合 */
const RISK_EVENT_TYPES = new Set([
  'collision_risk',
  'obstacle_risk',
  'risk_cleared',
]);
/**
 * eventId 重复本该是同一事件的重放（补传 / 重传），时间戳应当一致。下面这几类的 eventId 重复、
 * 时间戳却相差很远，多半是头盔的 Event_Seq 回退了（换电池 / 恢复出厂，DEVICE_PROTOCOL §10 第 20 条）：
 * eventId 由 deviceId + Event_Seq 派生，回退后新的摔倒会被当成旧事件静默丢弃（10-06 仿真头盔复现）。
 */
const SEQ_ROLLBACK_WATCH_TYPES = new Set([
  'possible_fall',
  'manual_sos',
  'collision_risk',
  'obstacle_risk',
]);
/** 未校时的头盔补传同一事件时 App 会填收到时刻，几分钟内的差异不算；超过它才像是两次不同的事件 */
const SEQ_ROLLBACK_GAP_MS = 5 * 60_000;

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

/**
 * 数据库对"这一条数据"的拒绝（列范围、编码、非法值）→ 返回原因码；
 * 连接类故障（P1xxx / 初始化失败）→ null，交给上层按真实 5xx 处理、MQTT 侧重试。
 */
function dbRejectionCode(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code.startsWith('P1') ? null : err.code;
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return 'unknown';
  if (err instanceof Prisma.PrismaClientValidationError) return 'validation';
  return null;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: DeviceSnapshotService,
    private readonly locationRecorder: LocationRecorderService,
    private readonly push: RealtimePushService,
    private readonly sosTrigger: SosTriggerService,
    private readonly mediaRecorder: MediaRecorderService,
  ) {}

  /** 所有入口（MQTT / App 中转 / Webhook / Mock）都汇聚到这里；返回值仅用于日志与测试。 */
  async ingestRaw(
    raw: string,
    topicDeviceId: string,
    source: IngestSource,
    opts?: IngestOptions,
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

    if (
      opts?.allowedEventTypes &&
      !opts.allowedEventTypes.has(result.envelope.eventType)
    ) {
      // 蓝牙版范围外的类型（DEVICE_PROTOCOL §1.1）：留档告警，不进业务流程
      this.logger.warn(
        `入口 ${source} 不允许的事件类型 ${result.envelope.eventType}，按校验失败留档：${result.envelope.eventId}`,
      );
      await this.persist(
        buildInvalidRecord(topicDeviceId, raw, 'event_type_not_allowed'),
        source,
      );
      return 'stored_invalid';
    }

    if (!SUPPORTED_SCHEMA_VERSIONS.has(result.envelope.schemaVersion)) {
      // 版本未知：按原 eventId/eventType 留档（幂等、可回放），但不分发——语义未知的事件不能进业务流程
      this.logger.warn(
        `未知 schemaVersion=${result.envelope.schemaVersion}，只留档不进业务流程：${result.envelope.eventId}（device=${topicDeviceId}）`,
      );
      await this.persistOrArchive(result.envelope, raw, topicDeviceId, source);
      return 'stored_invalid';
    }

    let stored: boolean;
    try {
      stored = await this.persist(result.envelope, source);
    } catch (err) {
      // 校验层没拦住但数据库仍拒绝（列约束/编码等）：降级为 _invalid 留档而不是让入口 5xx——
      // app-relay 整批失败会让 App 反复重传同一批，把后面的 possible_fall 一起卡死（队头阻塞）
      const rejection = dbRejectionCode(err);
      if (!rejection) throw err;
      this.logger.error(
        `事件入库被数据库拒绝（已按 _invalid 留档）：${rejection} event=${result.envelope.eventId} device=${topicDeviceId}`,
      );
      await this.persist(
        buildInvalidRecord(topicDeviceId, raw, `db_rejected_${rejection}`),
        source,
      );
      return 'stored_invalid';
    }
    if (stored) {
      await this.dispatchStored(result.envelope);
    }
    return stored ? 'stored' : 'duplicate';
  }

  /**
   * 入库成功后的业务分发：快照 → 位置表 → SOS 触发 → 媒体表 → WS 推送。
   * 只对已注册设备生效（未注册的仅 raw 留档）；推送只发给绑定用户。
   */
  private async dispatchStored(e: ValidEnvelope): Promise<void> {
    const device = await this.snapshot.applyEvent(e);
    if (!device) return;

    // 位置表只收校验通过的 location_update；推送复用同一份校验结果（不推脏数据）
    const point =
      e.eventType === 'location_update'
        ? await this.locationRecorder.record(e)
        : null;

    // SOS 状态机入口（Week 7-8）：内部吞错——与副表同哲学，失败大声留日志、raw 可回放
    if (e.eventType === 'possible_fall' || e.eventType === 'manual_sos') {
      await this.sosTrigger.handleTrigger(e, device.bindUserId);
    }

    // 媒体元数据（§9）：video_ready 入媒体表（内部吞错，raw 可回填）
    if (e.eventType === 'video_ready') {
      await this.mediaRecorder.record(e);
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

  /** 留档但不分发：数据库拒绝单条数据时同样降级为 _invalid 留档，与主路径同口径 */
  private async persistOrArchive(
    e: ValidEnvelope,
    raw: string,
    topicDeviceId: string,
    source: IngestSource,
  ): Promise<void> {
    try {
      await this.persist(e, source);
    } catch (err) {
      const rejection = dbRejectionCode(err);
      if (!rejection) throw err;
      await this.persist(
        buildInvalidRecord(topicDeviceId, raw, `db_rejected_${rejection}`),
        source,
      );
    }
  }

  /** eventId 幂等：唯一约束兜底并发，重复上报只存一次（EVENTS.md §2）。 */
  private async persist(
    e: ValidEnvelope,
    source: IngestSource,
  ): Promise<boolean> {
    const receivedAt = new Date();
    // 补传事件本应豁免此标记，但补传语义待设备离线缓存实装后才能识别（DEVICE_PROTOCOL §6 ⚠️），当前一律按偏差判定
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
        // 只要「写进去了」这个事实：不让数据库把整行（含 payload）再回传一遍
        select: { id: true },
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.debug(`重复 eventId 已跳过：${e.eventId}`);
        await this.warnIfSeqRolledBack(e);
        return false;
      }
      throw err;
    }
  }

  /** 只能出声、不能建单：eventId 幂等是 Contract（EVENTS.md §2），这里是给运维和硬件对口径的信号 */
  private async warnIfSeqRolledBack(e: ValidEnvelope): Promise<void> {
    if (!SEQ_ROLLBACK_WATCH_TYPES.has(e.eventType)) return;
    try {
      const prior = await this.prisma.rawEvent.findUnique({
        where: { eventId: e.eventId },
        select: { timestamp: true },
      });
      if (!prior) return;
      const gapMs = Math.abs(e.timestamp.getTime() - prior.timestamp.getTime());
      if (gapMs < SEQ_ROLLBACK_GAP_MS) return;
      this.logger.error(
        `疑似 Event_Seq 回退：设备 ${e.deviceId} 的 ${e.eventType} ${e.eventId} 与库中同 eventId 的事件时间相差 ${Math.round(gapMs / 60_000)} 分钟，本次上报已按重复丢弃——请核查头盔序号是否在掉电 / 恢复出厂后回退（DEVICE_PROTOCOL §10 第 20 条）`,
      );
    } catch (err) {
      this.logger.warn(
        `Event_Seq 回退检查失败（不影响入库结果）：${errorMessage(err)}`,
      );
    }
  }
}
