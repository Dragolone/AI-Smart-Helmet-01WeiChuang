import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EVENT_TYPES } from '@helmet/shared';
import {
  CLOCK_SKEW_THRESHOLD_MS,
  businessTime,
  isBackfill,
} from '../common/device-time';
import { dbRejectionCode, isUniqueViolation } from '../common/prisma-errors';
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
  type StoredEnvelope,
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
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);
/** 丢一条就可能没人收到求救的事件：重复时要出声（DEVICE_PROTOCOL §10 第 20 条） */
const CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'possible_fall',
  'manual_sos',
]);
/** 同号高危事件时间差超过它就不像重传（没校时的头盔重传时间也会差，所以只告警、不改判） */
const REPLAY_ALERT_GAP_MS = 5 * 60_000;

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

/** payload 的规范化 JSON（键排序）：给冲突事件另存时算摘要用 */
const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : value,
  );

/** 冲突事件另存用的 eventId 分隔符（原 eventId 不含它时才另存，避免无限递归） */
const COLLISION_SEPARATOR = '~';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 两份载荷是否同一次事件的两次上报：按入库后的形态比（JSON 往返——`-0.0` 进 jsonb 读回是 0，
 * 原文直比会把 MQTT 重投当成撞号），相等，或一份是另一份的子集且共有字段取值都相同。
 * 子集：头盔第一次发的帧被截短（MTU 没协商上去），App 只填解得出的字段照样上云；1.5 s 重发或重连补传
 * 的是完整帧，多出 impactG / location 等（DEVICE_PROTOCOL §1.2）。它们是同一次摔倒 / 求救——原来按「撞号」
 * 另存后照常分发，手动求救的重传把本人的 60 秒取消窗口跳过、直接通知联系人，摔倒取消后又起一单（10-17 第二轮评审）。
 * 共有字段只要有一个值不同就是另一件事（序号回退撞号），照旧另存。
 */
export function sameEventPayload(stored: unknown, incoming: unknown): boolean {
  return compatible(stored, JSON.parse(JSON.stringify(incoming ?? null)));
}

function compatible(a: unknown, b: unknown): boolean {
  if (isPlainObject(a) && isPlainObject(b)) {
    const [small, big] =
      Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a];
    return Object.keys(small).every(
      (k) => Object.hasOwn(big, k) && compatible(small[k], big[k]),
    );
  }
  return isDeepStrictEqual(a, b);
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
      const archived = await this.persistOrArchive(
        result.envelope,
        raw,
        topicDeviceId,
        source,
      );
      // 同一条重传：按重复算（原来每次都计 invalid，统计口径不对，观察项 11）
      return archived ? 'stored_invalid' : 'duplicate';
    }

    let stored: StoredEnvelope | null;
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
      if (!KNOWN_EVENT_TYPES.has(stored.eventType)) {
        // EVENTS.md §1 / §2：未知类型进原始事件表并告警（不进任何业务表，App 查询也看不到）
        this.logger.warn(
          `未知 eventType「${stored.eventType}」已原样留档（入口 ${source}）：${stored.eventId}（device=${topicDeviceId}）`,
        );
      }
      // 分发的是实际落库的那份（冲突另存时 eventId 带了摘要后缀，求救单按它幂等）
      await this.dispatchStored(stored);
    } else if (result.envelope.eventType === 'location_update') {
      // 重传的位置：上一次可能写完 raw、写位置表时撞上瞬时故障回了 5xx，这次补上（位置表按 eventId 幂等）
      await this.locationRecorder.recordIfMissing(result.envelope);
    }
    return stored ? 'stored' : 'duplicate';
  }

  /**
   * 入库成功后的业务分发：快照 → 位置表 → SOS 触发 → 媒体表 → WS 推送。
   * 只对已注册设备生效（未注册的仅 raw 留档）；推送只发给绑定用户。
   */
  private async dispatchStored(e: StoredEnvelope): Promise<void> {
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

    // 补传的旧状态 / 旧位置不当实时数据推（快照也没刷新，见 DeviceSnapshotService.applyEvent）：旧点会把 App 上的实时标记拽回去
    const live = !isBackfill(e.timestamp, new Date());
    if (device.bindUserId) {
      if (e.eventType === 'device_status') {
        if (live)
          this.push.pushDeviceStatus(device.bindUserId, e.deviceId, device);
      } else if (point) {
        if (live) this.push.pushLocation(device.bindUserId, e.deviceId, point);
      } else if (RISK_EVENT_TYPES.has(e.eventType)) {
        this.push.pushRiskEvent(device.bindUserId, e);
      } else if (DEVICE_EVENT_TYPES.has(e.eventType)) {
        this.push.pushDeviceEvent(device.bindUserId, e);
      }
    }
  }

  /** 留档但不分发：数据库拒绝单条数据时同样降级为 _invalid 留档，与主路径同口径。返回是否新写了一行（false = 重复） */
  private async persistOrArchive(
    e: ValidEnvelope,
    raw: string,
    topicDeviceId: string,
    source: IngestSource,
  ): Promise<boolean> {
    try {
      return (await this.persist(e, source)) !== null;
    } catch (err) {
      const rejection = dbRejectionCode(err);
      if (!rejection) throw err;
      await this.persist(
        buildInvalidRecord(topicDeviceId, raw, `db_rejected_${rejection}`),
        source,
      );
      return true;
    }
  }

  /**
   * eventId 幂等：唯一约束兜底并发，重复上报只存一次（EVENTS.md §2）。返回落库的那份 envelope，重复返回 null。
   * 同一设备同一 eventId 再次出现、但类型或 payload 与库里那条不同：不是重传，是另一件事撞了号——按「原 eventId~内容摘要」另存
   * 并照常分发（见 handleCollision）。
   */
  private async persist(
    e: ValidEnvelope,
    source: IngestSource,
  ): Promise<StoredEnvelope | null> {
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
          businessTime: businessTime(e.timestamp, receivedAt),
          schemaVersion: e.schemaVersion,
          firmwareVersion: e.firmwareVersion,
          payload: e.payload as Prisma.InputJsonValue,
          source,
          clockSkew,
        },
        // 只要「写进去了」这个事实：不让数据库把整行（含 payload）再回传一遍
        select: { id: true },
      });
      return { ...e, receivedAt };
    } catch (err) {
      if (isUniqueViolation(err)) return this.handleCollision(e, source);
      throw err;
    }
  }

  /**
   * (deviceId, eventId) 已存在。类型相同、payload 是同一次事件（见 sameEventPayload）→ 重传（App 重发、MQTT 重投、
   * Webhook 重试、截短帧补全），按重复跳过；
   * 否则是另一件事撞了号：头盔恢复出厂 / 掉电后 Event_Seq 回退（DEVICE_PROTOCOL §10 第 20 条），或头盔转手后前主人
   * 用可推算的 UUIDv5(deviceId:seq) 预先占号——原来一律当重复，新主人的摔倒不建单、对账也补不回来（10-17 评审 R4-1）。
   * 不比时间戳：没校时的头盔重传时 App 填的是收到时刻，几小时后同一事件重传时间会不同，比了反而重复建单。
   */
  private async handleCollision(
    e: ValidEnvelope,
    source: IngestSource,
  ): Promise<StoredEnvelope | null> {
    const prior = await this.prisma.rawEvent.findUnique({
      where: {
        deviceId_eventId: { deviceId: e.deviceId, eventId: e.eventId },
      },
      select: {
        eventType: true,
        payload: true,
        schemaVersion: true,
        timestamp: true,
      },
    });
    // 库里那条版本未知，只留档、没进过业务流程：这条版本能懂就不是重传。原来按重传丢掉，
    // 先发一条未知版本的空载荷占号，之后同号的真摔倒不建单、对账也补不回来（11-01 本地实测）
    const archivedOnly =
      !!prior &&
      !SUPPORTED_SCHEMA_VERSIONS.has(prior.schemaVersion) &&
      SUPPORTED_SCHEMA_VERSIONS.has(e.schemaVersion);
    if (
      !prior ||
      (!archivedOnly &&
        prior.eventType === e.eventType &&
        sameEventPayload(prior.payload, e.payload))
    ) {
      // 序号回退且载荷相同时只能按重传丢，至少要看得见：DEVICE_PROTOCOL §10 第 20 条写的那道告警
      if (
        prior &&
        CRITICAL_EVENT_TYPES.has(e.eventType) &&
        Math.abs(prior.timestamp.getTime() - e.timestamp.getTime()) >
          REPLAY_ALERT_GAP_MS
      ) {
        this.logger.warn(
          `高危事件 eventId 重复但时间相差 5 分钟以上，按重复跳过：设备 ${e.deviceId} 的 ${e.eventType} ${e.eventId}——请核查头盔序号是否回退（DEVICE_PROTOCOL §10 第 20 条）`,
        );
      }
      this.logger.debug(`重复 eventId 已跳过：${e.eventId}`);
      return null;
    }
    if (e.eventId.includes(COLLISION_SEPARATOR)) {
      // 另存的键本身又撞了（摘要碰撞，或上游 eventId 里就带分隔符）：不再递归，按重复处理并出声
      this.logger.error(
        `eventId 冲突且无法另存，按重复丢弃：设备 ${e.deviceId} 的 ${e.eventType} ${e.eventId}`,
      );
      return null;
    }
    const digest = createHash('sha256')
      .update(`${e.eventType}${COLLISION_SEPARATOR}${canonicalJson(e.payload)}`)
      .digest('hex')
      .slice(0, 12);
    const rekeyed = {
      ...e,
      eventId: `${e.eventId}${COLLISION_SEPARATOR}${digest}`,
    };
    this.logger.error(
      `eventId 冲突：设备 ${e.deviceId} 的 ${e.eventType} ${e.eventId} 与库中同号事件（${prior.eventType}）内容不同，按 ${rekeyed.eventId} 另存并照常处理——请核查头盔序号是否回退（DEVICE_PROTOCOL §10 第 20 条）`,
    );
    return this.persist(rekeyed, source);
  }
}
