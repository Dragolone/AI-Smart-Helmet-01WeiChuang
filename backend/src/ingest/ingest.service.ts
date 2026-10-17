import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EVENT_TYPES } from '@helmet/shared';
import { CLOCK_SKEW_THRESHOLD_MS, isBackfill } from '../common/device-time';
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
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

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
 * 瞬时故障的 Prisma 错误码：P2024 连接池超时、P2028 事务 API、P2034 写冲突 / 死锁、P2036 / P2037 驱动适配器错误 / 连接数满。
 * adapter-pg 下没有专门映射的 SQLSTATE 一律报 P2039——要再看原始 SQLSTATE 才分得清
 */
const TRANSIENT_PRISMA_CODES = new Set([
  'P2024',
  'P2028',
  'P2034',
  'P2036',
  'P2037',
]);
/** 瞬时类 SQLSTATE：08 连接、40 事务回滚 / 死锁、53 资源不足、55 锁不可得、57 管理员关停 / 取消、58 系统、XX 内部 */
const TRANSIENT_SQLSTATE = /^(08|40|53|55|57|58|XX)/;

/**
 * 数据库对"这一条数据"的拒绝（列范围、编码、非法值）→ 返回原因码，按 _invalid 留档；
 * 瞬时故障（连接、死锁、关停、资源不足……）→ null，交给上层按真实 5xx 处理、App / MQTT 重试。
 * 原来 P1 开头以外的已知错误码一律当「这条数据被拒」：adapter-pg 把后端被杀（57P01）、死锁（40P01）、连接数满（53300）
 * 报成 P2039 / P2037，摔倒事件就被改记成随机 eventId 的 _invalid、202 回给 App（App 从队列删掉），对账也捞不到——求救永久丢失（10-17 评审）
 */
export function dbRejectionCode(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientValidationError) return 'validation';
  // 引擎报不出码的未知错误照旧按这条数据留档：一律重抛的话，一条毒数据会让 App 整批反复重传、堵住后面的摔倒（队头阻塞）
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return 'unknown';
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (err.code.startsWith('P1') || TRANSIENT_PRISMA_CODES.has(err.code)) {
    return null;
  }
  const sqlState = (
    err.meta?.driverAdapterError as
      { cause?: { originalCode?: unknown } } | undefined
  )?.cause?.originalCode;
  if (typeof sqlState === 'string' && TRANSIENT_SQLSTATE.test(sqlState)) {
    return null;
  }
  return err.code;
}

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

    let stored: ValidEnvelope | null;
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
  ): Promise<ValidEnvelope | null> {
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
      return e;
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
  ): Promise<ValidEnvelope | null> {
    const prior = await this.prisma.rawEvent.findUnique({
      where: {
        deviceId_eventId: { deviceId: e.deviceId, eventId: e.eventId },
      },
      select: { eventType: true, payload: true },
    });
    if (
      !prior ||
      (prior.eventType === e.eventType &&
        sameEventPayload(prior.payload, e.payload))
    ) {
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
