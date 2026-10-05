import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LocationSnapshot } from '@helmet/shared';
import { errorMessage, errorStack } from '../common/error-text';
import { isUniqueViolation } from '../common/prisma-errors';
import {
  CLOCK_SKEW_THRESHOLD_MS,
  latestPlausibleTime,
} from '../common/device-time';
import { sleep } from '../common/sleep';
import type { ValidEnvelope } from '../ingest/envelope';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_PROVIDER, type PushProvider } from '../providers/push.provider';
import { RealtimePushService } from '../realtime/realtime-push.service';
import { SOS_STATUS, countdownMs } from './sos.constants';
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
  return {
    latitude: p.latitude,
    longitude: p.longitude,
    coordinateSystem: p.coordinateSystem,
    accuracy: isFiniteNumber(p.accuracy) && p.accuracy >= 0 ? p.accuracy : null,
  };
}

/** 头盔离线缓存的保留上限是 48 小时（DEVICE_PROTOCOL §6）；留一点余量，再早的时间戳只可能是头盔时钟不对 */
const MAX_PLAUSIBLE_BACKFILL_MS = 72 * 3_600_000;

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

    const snapshot = await this.resolveSnapshot(e);
    try {
      const created = await this.prisma.sosCase.create({
        data: {
          deviceId: e.deviceId,
          userId,
          triggerEventId: e.eventId,
          triggerType: e.eventType,
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
      });
      this.logger.warn(
        `SOS 单已创建 ${created.id}（${e.eventType}，device=${e.deviceId}，deadline=${created.deadline.toISOString()}）`,
      );
      this.realtime.pushSosUpdate(userId, toWireSos(created));
      // 本人倒计时 Push 为尽力而为（App 被杀时的兜底面）；失败不重试——WS + REST active 是权威展示面
      try {
        const action =
          e.eventType === 'manual_sos' ? '触发手动求救' : '检测到疑似摔倒';
        const age = describeEventAge(e.timestamp);
        await this.push.send(
          userId,
          'SOS 倒计时已开始',
          `头盔 ${e.deviceId} ${action}${age ? `（${age}的事件，刚补传到）` : ''}，未取消将于 ${created.deadline.toISOString()} 通知紧急联系人`,
          { sosId: created.id, deviceId: e.deviceId },
        );
      } catch (err) {
        this.logger.warn(
          `SOS 创建 Push 失败（不影响状态机）：${errorMessage(err)}`,
        );
      }
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

  private async applyMergeRule(
    e: ValidEnvelope,
    active: { id: string; triggerEventId: string },
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
      await this.notifier.finalizeNotified(activeSosId);
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
  ): Promise<(SosSnapshot & { source: string }) | null> {
    const fromEvent = extractSosLocation(e.payload);
    if (fromEvent) return { ...fromEvent, source: 'event' };

    try {
      const lastPoint = await this.prisma.locationPoint.findFirst({
        where: {
          deviceId: e.deviceId,
          timestamp: { lte: latestPlausibleTime() },
        },
        orderBy: { timestamp: 'desc' },
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
