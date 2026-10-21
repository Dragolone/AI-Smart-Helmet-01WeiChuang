import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LocationSnapshot } from '@helmet/shared';
import { errorMessage, errorStack } from '../common/error-text';
import { isUniqueViolation } from '../common/prisma-errors';
import {
  CLOCK_SKEW_THRESHOLD_MS,
  latestPlausibleTime,
  MAX_PLAUSIBLE_BACKFILL_MS,
} from '../common/device-time';
import { helmetLabel } from '../common/helmet-label';
import { lockUserIfLive } from '../common/live-user';
import { BindingScopeService } from '../devices/binding-scope.service';
import { timerMs } from '../common/env';
import { sleep } from '../common/sleep';
import { withTimeout } from '../common/with-timeout';
import type { ValidEnvelope } from '../ingest/envelope';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_PROVIDER, type PushProvider } from '../providers/push.provider';
import { RealtimePushService } from '../realtime/realtime-push.service';
import {
  SOS_PUSH_CATEGORY,
  SOS_STARTED_PUSH_KIND,
  SOS_STATUS,
  countdownMs,
  createdPushRetryDelaysMs,
  notifyTimeoutMs,
} from './sos.constants';
import { SosNotifierService } from './sos-notifier.service';
import { toWireSos } from './sos-wire';

/** 建单遇到数据库瞬断时的进程内重试（次数 × 起始间隔，指数退避）；耗尽后交给启动对账兜底 */
const TRIGGER_RETRIES = 2;
const TRIGGER_RETRY_BASE_MS = 200;

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export interface SosSnapshot {
  latitude: number;
  longitude: number;
  coordinateSystem: string;
  accuracy: number | null;
}

/**
 * 触发事件里的位置快照（EVENTS.md 4.3/4.4 location：lat/lng/coordinateSystem 必填，其余选填）。
 * 与 location_update 的校验不同：accuracy/speed/heading 在这里是选填。设备输入不可信，逐字段校验。
 */
export function extractSosLocation(
  payload: Record<string, unknown>,
): SosSnapshot | null {
  const loc = payload.location;
  if (typeof loc !== 'object' || loc === null) return null;
  const p = loc as Partial<LocationSnapshot>;
  if (!isFiniteNumber(p.latitude) || p.latitude < -90 || p.latitude > 90) {
    return null;
  }
  if (!isFiniteNumber(p.longitude) || p.longitude < -180 || p.longitude > 180) {
    return null;
  }
  if (p.coordinateSystem !== 'wgs84' && p.coordinateSystem !== 'gcj02') {
    return null;
  }
  // 精确 (0,0) 是「没定到位」的典型哨兵（几内亚湾里没有我们的用户）：按缺失处理，回落最新轨迹点，
  // 否则事故地点会被钉在赤道上（10-03 报告待硬件答复的一条，软件侧先兜住）
  if (p.latitude === 0 && p.longitude === 0) return null;
  return {
    latitude: p.latitude,
    longitude: p.longitude,
    coordinateSystem: p.coordinateSystem,
    accuracy: isFiniteNumber(p.accuracy) && p.accuracy >= 0 ? p.accuracy : null,
  };
}

/**
 * 补传事件发生在多久之前（决策 #52：旧事件照常倒计时并通知，只在给本人的推送里说明，方便他判断要不要取消）。
 * 不到时钟偏移阈值的不说（就是刚发生的）；超出离线缓存能保留的范围也不说——那是时钟错了，
 * 说「9000 天前」只会诱导本人把一次真摔倒当成旧记录取消掉。
 */
export function describeEventAge(
  eventAt: Date,
  now: number = Date.now(),
): string | null {
  const ageMs = now - eventAt.getTime();
  if (ageMs < CLOCK_SKEW_THRESHOLD_MS || ageMs > MAX_PLAUSIBLE_BACKFILL_MS) {
    return null;
  }
  const minutes = Math.round(ageMs / 60_000);
  return minutes < 90
    ? `约 ${minutes} 分钟前`
    : `约 ${Math.round(minutes / 60)} 小时前`;
}

/**
 * 「SOS 倒计时已开始」推送正文。秒数按 deadline 现算而不是写死倒计时长度：首投超时 10 s、
 * 再按 5 s / 20 s 重试时，最后一次可能只剩 15 秒，还写「60 秒后」会让本人以为来得及慢慢确认。
 * 已到期返回 null（不再发，到期通知由扫描任务负责）。
 */
export function createdPushBody(
  /** 头盔称呼：名字优先、没有才用编号（helmetLabel） */
  helmet: string,
  eventType: string,
  eventAt: Date,
  deadline: Date,
  now: number = Date.now(),
): string | null {
  const remainingSec = Math.ceil((deadline.getTime() - now) / 1000);
  if (remainingSec <= 0) return null;
  const action = eventType === 'manual_sos' ? '触发手动求救' : '检测到疑似摔倒';
  const age = describeEventAge(eventAt, now);
  return `头盔 ${helmet} ${action}${age ? `（${age}的事件，刚补传到）` : ''}，未取消将于 ${remainingSec} 秒后通知紧急联系人`;
}

/**
 * possible_fall / manual_sos → SOS 单（Ingest 分发入口）。
 * 与 Ingest 其他副表同哲学：这里绝不向上抛错——抛错不会带来重投（raw 已落库、重投会被幂等挡掉），
 * 只会丢掉本次业务动作；失败大声记 ERROR，raw_events 留档可人工回放。
 */
@Injectable()
export class SosTriggerService {
  private readonly logger = new Logger(SosTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: SosNotifierService,
    private readonly realtime: RealtimePushService,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    private readonly scope: BindingScopeService,
  ) {}

  async handleTrigger(
    e: ValidEnvelope,
    bindUserId: string | null,
  ): Promise<void> {
    try {
      if (!bindUserId) {
        // 口径（2026-08-16 定稿）：未绑定设备只留档不建单——没有绑定用户就没有联系人可通知、无人可取消
        this.logger.warn(
          `${e.eventType} 来自未绑定设备 ${e.deviceId}，不建 SOS 单（raw 已留档）：${e.eventId}`,
        );
        return;
      }
      await this.createOrMergeWithRetry(e, bindUserId);
    } catch (err) {
      // raw 已落库、eventId 幂等会挡住重投，这里的失败只能靠调度器的对账（reconcileLostTriggers）补建
      this.logger.error(
        `SOS 触发处理失败（raw 已留档，等待对账补建）event=${e.eventId} device=${e.deviceId}：${errorStack(err)}`,
      );
    }
  }

  /**
   * 建单失败绝大多数是数据库瞬断/超时：先在进程内重试几次（审计 SOS-02 复现的正是「一次抛错就永久漏单」），
   * 重试耗尽再交给启动/周期对账。createOrMerge 自身对 P2002 幂等，重复执行不会多建单。
   */
  private async createOrMergeWithRetry(
    e: ValidEnvelope,
    userId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= TRIGGER_RETRIES; attempt++) {
      try {
        await this.createOrMerge(e, userId);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < TRIGGER_RETRIES) {
          const delay = TRIGGER_RETRY_BASE_MS * 2 ** attempt;
          this.logger.warn(
            `SOS 建单失败（第 ${attempt + 1} 次），${delay}ms 后重试：${errorMessage(err)}`,
          );
          await sleep(delay);
        }
      }
    }
    throw lastError;
  }

  /**
   * 合并规则（2026-08-16 定稿，EVENTS.md §4.4；决策 #40 改为按「设备 + 用户」判定）：
   * 该设备在同一绑定用户名下已有 pending 时——新 possible_fall 只留档不建单（同一事故的重复判定）；
   * 新 manual_sos 不建单但立即终态化通知（倒计时中按实体键 = 明确人为求救，等价 SOS Now）。
   * 终态（notified/cancelled）后的新事件正常建新单。
   * 换绑后新用户的事件与前用户的进行中单互不相干（审计 SOS-03）：前用户的单照常倒计时、到期通知前用户的联系人。
   */
  private async createOrMerge(e: ValidEnvelope, userId: string): Promise<void> {
    const active = await this.prisma.sosCase.findFirst({
      where: { deviceId: e.deviceId, userId, status: SOS_STATUS.pending },
    });
    if (active) {
      await this.applyMergeRule(e, active);
      return;
    }

    const snapshot = await this.resolveSnapshot(e, userId);
    try {
      // 建单与注销串行（O15）：先给用户行加共享锁，与注销事务对用户行的更新互斥。
      // 注销先提交 → 不建：联系人已随注销删光，没有人可通知，也没有人能取消（同「未绑定设备只留档」）；
      // 这里先提交 → 注销事务里的「进行中求救」检查一定看得到这张单，拒绝注销
      const created = await this.prisma.$transaction(async (tx) =>
        (await lockUserIfLive(tx, userId))
          ? tx.sosCase.create({
              data: {
                deviceId: e.deviceId,
                userId,
                triggerEventId: e.eventId,
                triggerType: e.eventType,
                triggeredAt: e.timestamp,
                // 服务器时间权威：设备时钟偏移（clock_skew）不影响保命链路
                deadline: new Date(Date.now() + countdownMs()),
                ...(snapshot
                  ? {
                      latitude: snapshot.latitude,
                      longitude: snapshot.longitude,
                      coordinateSystem: snapshot.coordinateSystem,
                      accuracy: snapshot.accuracy,
                      locationSource: snapshot.source,
                    }
                  : {}),
              },
            })
          : null,
      );
      if (!created) {
        this.logger.warn(
          `${e.eventType} 到达时账号 ${userId} 已注销，不建 SOS 单（raw 已留档）：${e.eventId}`,
        );
        return;
      }
      this.logger.warn(
        `SOS 单已创建 ${created.id}（${e.eventType}，device=${e.deviceId}，deadline=${created.deadline.toISOString()}）`,
      );
      this.realtime.pushSosUpdate(userId, toWireSos(created));
      // 本人倒计时 Push 是 App 被杀 / 没连头盔时唯一能取消误报的入口：不在 ingest 路径里等第三方
      //（极光挂起时会拖住整条 MQTT / app-relay 队列 10 s），后台发、失败按节奏再试；WS + REST active 仍是权威展示面
      void this.pushCreated(created, e, userId);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // 并发兜底：同 triggerEventId 重放，或 partial unique index（每设备每用户至多一个 pending）拦下并发建单
        const nowActive = await this.prisma.sosCase.findFirst({
          where: { deviceId: e.deviceId, userId, status: SOS_STATUS.pending },
        });
        if (nowActive) {
          await this.applyMergeRule(e, nowActive);
        } else {
          this.logger.debug(`SOS 重复触发已跳过：${e.eventId}`);
        }
        return;
      }
      throw err;
    }
  }

  /**
   * 「SOS 倒计时已开始」推送（类别 "sos"：远程推送上也带 App 注册的「我没事，取消」按钮；
   * 时效性：专注模式下照样弹出，否则 60 秒取消窗口会被静默收进通知中心）。
   * 首投失败按 createdPushRetryDelaysMs 再试，每次先确认这单还在倒计时——已取消 / 已到期就不再发。
   * 这里的定时器只是尽力而为的重试，不是状态机的依赖（deadline 在库里，到期由扫描任务判）。
   */
  private async pushCreated(
    created: { id: string; deadline: Date },
    e: ValidEnvelope,
    userId: string,
  ): Promise<void> {
    // 用户看不懂也不关心精确到毫秒的 UTC（10-07 A 线反馈）：写「N 秒后」，N = 发这一次时离 deadline 还剩几秒
    const helmet = await this.helmetLabelOf(e.deviceId, userId);
    const bodyNow = () =>
      createdPushBody(helmet, e.eventType, e.timestamp, created.deadline);
    const delays = createdPushRetryDelaysMs();
    try {
      await this.pushCreatedWithRetry(
        created.id,
        userId,
        bodyNow,
        e.deviceId,
        delays,
      );
    } catch (err) {
      this.logger.warn(`SOS 创建 Push 重试中断：${errorMessage(err)}`);
    }
  }

  /** 推送里怎么称呼这顶头盔；查不到 / 查询出错就用编号，推送照发。名字只认这单主人起的（换绑后不露新主人起的名字） */
  private async helmetLabelOf(
    deviceId: string,
    userId: string,
  ): Promise<string> {
    try {
      const device = await this.prisma.device.findUnique({
        where: { deviceId },
        select: { name: true, bindUserId: true },
      });
      return helmetLabel({
        name: device?.bindUserId === userId ? device.name : null,
        deviceId,
      });
    } catch {
      return deviceId;
    }
  }

  private async pushCreatedWithRetry(
    sosId: string,
    userId: string,
    bodyNow: () => string | null,
    deviceId: string,
    delays: number[],
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const body = bodyNow();
      if (body === null) return;
      try {
        // 套应用层超时：推送通道挂住（只回了响应头、响应体不来）时不能一直等到倒计时结束、错过 5 s / 20 s 的重试（10-17 评审）
        await withTimeout(
          this.push.send(
            userId,
            'SOS 倒计时已开始',
            body,
            { sosId, deviceId, kind: SOS_STARTED_PUSH_KIND },
            { category: SOS_PUSH_CATEGORY, timeSensitive: true },
          ),
          notifyTimeoutMs(),
          'sos.created-push',
        );
        return;
      } catch (err) {
        const delay = delays[attempt];
        this.logger.warn(
          `SOS 创建 Push 失败（第 ${attempt + 1} 次，不影响状态机）${delay === undefined ? '，不再重试' : `，${delay / 1000}s 后再试`}：${errorMessage(err)}`,
        );
        if (delay === undefined) return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, timerMs(delays[attempt])).unref(),
      );
      const still = await this.prisma.sosCase.findUnique({
        where: { id: sosId },
        select: { status: true },
      });
      if (still?.status !== SOS_STATUS.pending) return;
    }
  }

  private async applyMergeRule(
    e: ValidEnvelope,
    active: { id: string; triggerEventId: string; userId: string },
  ): Promise<void> {
    const activeSosId = active.id;
    // 进行中的这一单就是本事件自己建的：同一事件被处理了第二遍（建单成功但响应丢失后的进程内重试、
    // 对账与在途分发撞车）。它不是「倒计时中又来一条」——否则一条 manual_sos 会把自己的倒计时跳过去
    if (active.triggerEventId === e.eventId) {
      this.logger.debug(`SOS 重复触发已跳过：${e.eventId}`);
      return;
    }
    if (e.eventType === 'manual_sos') {
      this.logger.warn(
        `倒计时中收到设备 manual_sos（${e.eventId}），按 SOS Now 升级立即通知：${activeSosId}`,
      );
      const won = await this.notifier.finalizeNotified(activeSosId);
      if (!won) {
        // 读到 pending 与升级之间那一单被别人终态化了。被取消（本人刚点「我没事」）→ 这次实体键求救
        // 是终态之后的新事件，必须建新单，否则一次明确的人为求救会被静默吞掉；
        // 被到期扫描抢先 notified → 联系人已在通知，用户意图已达成，不再建第二单
        const now = await this.prisma.sosCase.findUnique({
          where: { id: activeSosId },
          select: { status: true },
        });
        if (now?.status === SOS_STATUS.cancelled) {
          this.logger.warn(
            `升级时 ${activeSosId} 已被取消，manual_sos ${e.eventId} 按终态后的新事件建单`,
          );
          await this.createOrMerge(e, active.userId);
          return;
        }
        this.logger.warn(
          `升级时 ${activeSosId} 已是 ${now?.status ?? '未知'}，manual_sos ${e.eventId} 不再建单`,
        );
      }
    } else {
      this.logger.log(
        `倒计时中收到重复 ${e.eventType}（${e.eventId}），并入进行中 SOS ${activeSosId}（只留档不建单）`,
      );
    }
  }

  /**
   * 位置快照口径（2026-08-16 定稿）：优先触发事件 payload.location（逐字段校验），
   * 回落该设备最新轨迹点；都没有则为空——不能因为缺位置不建单。
   */
  private async resolveSnapshot(
    e: ValidEnvelope,
    userId: string,
  ): Promise<(SosSnapshot & { source: string }) | null> {
    const fromEvent = extractSosLocation(e.payload);
    if (fromEvent) return { ...fromEvent, source: 'event' };

    try {
      // 只回落到建单用户绑定区间内到达的点（决策 #39，与 locations latest 同口径）：
      // 换绑后新主人的事故位置 / 联系人短信不能用前主人的最后位置（边界测试 B3）
      const intervals = await this.scope.intervals(e.deviceId, userId);
      const lastPoint = await this.prisma.locationPoint.findFirst({
        where: {
          deviceId: e.deviceId,
          timestamp: { lte: latestPlausibleTime() },
          // 精确 (0,0) 是「没定到位」的哨兵（同 extractSosLocation）：跳过它找上一个真实点，
          // 否则短信里的位置是 0,0（边界测试 B2）
          NOT: { latitude: 0, longitude: 0 },
          AND: [this.scope.scopeWhere('receivedAt', intervals)],
        },
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        select: {
          latitude: true,
          longitude: true,
          coordinateSystem: true,
          accuracy: true,
        },
      });
      return lastPoint ? { ...lastPoint, source: 'last_point' } : null;
    } catch (err) {
      // 快照只是附加信息：副表查询失败绝不能阻塞建单（决策 #26③「都无则空快照照建单」，审计 SOS-01）
      this.logger.warn(
        `SOS 位置快照查询失败，按空快照建单 device=${e.deviceId}：${errorMessage(err)}`,
      );
      return null;
    }
  }
}
