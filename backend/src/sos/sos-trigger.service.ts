import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LocationSnapshot } from '@helmet/shared';
import { Prisma } from '../generated/prisma/client';
import type { ValidEnvelope } from '../ingest/envelope';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_PROVIDER, type PushProvider } from '../providers/push.provider';
import { RealtimePushService } from '../realtime/realtime-push.service';
import { SOS_STATUS, countdownMs } from './sos.constants';
import { SosNotifierService } from './sos-notifier.service';
import { toWireSos } from './sos-wire';

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
      await this.createOrMerge(e, bindUserId);
    } catch (err) {
      this.logger.error(
        `SOS 触发处理失败（raw 已留档，可人工回放）event=${e.eventId} device=${e.deviceId}：${err instanceof Error ? err.stack : String(err)}`,
      );
    }
  }

  /**
   * 合并规则（2026-08-16 定稿，EVENTS.md §4.4）：
   * 该设备已有 pending 时——新 possible_fall 只留档不建单（同一事故的重复判定）；
   * 新 manual_sos 不建单但立即终态化通知（倒计时中按实体键 = 明确人为求救，等价 SOS Now）。
   * 终态（notified/cancelled）后的新事件正常建新单。
   */
  private async createOrMerge(e: ValidEnvelope, userId: string): Promise<void> {
    const active = await this.prisma.sosCase.findFirst({
      where: { deviceId: e.deviceId, status: SOS_STATUS.pending },
    });
    if (active) {
      await this.applyMergeRule(e, active.id);
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
        await this.push.send(
          userId,
          'SOS 倒计时已开始',
          `头盔 ${e.deviceId} ${e.eventType === 'manual_sos' ? '触发手动求救' : '检测到疑似摔倒'}，未取消将于 ${created.deadline.toISOString()} 通知紧急联系人`,
          { sosId: created.id, deviceId: e.deviceId },
        );
      } catch (err) {
        this.logger.warn(
          `SOS 创建 Push 失败（不影响状态机）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // 并发兜底：同 triggerEventId 重放，或 partial unique index（每设备至多一个 pending）拦下并发建单
        const nowActive = await this.prisma.sosCase.findFirst({
          where: { deviceId: e.deviceId, status: SOS_STATUS.pending },
        });
        if (nowActive) {
          await this.applyMergeRule(e, nowActive.id);
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
    activeSosId: string,
  ): Promise<void> {
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

    const lastPoint = await this.prisma.locationPoint.findFirst({
      where: { deviceId: e.deviceId },
      orderBy: { timestamp: 'desc' },
      select: {
        latitude: true,
        longitude: true,
        coordinateSystem: true,
        accuracy: true,
      },
    });
    return lastPoint ? { ...lastPoint, source: 'last_point' } : null;
  }
}
