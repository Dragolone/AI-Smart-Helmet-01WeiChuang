import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { errorMessage, errorStack } from '../common/error-text';
import type { RawEvent } from '../generated/prisma/client';
import { SUPPORTED_SCHEMA_VERSIONS } from '../ingest/envelope';
import type { ValidEnvelope } from '../ingest/envelope';
import { PrismaService } from '../prisma/prisma.service';
import {
  notifyTimeoutMs,
  reconcileGraceMs,
  reconcileIntervalMs,
  reconcileStartupWindowMs,
  reconcileWindowMs,
  scanIntervalMs,
  SOS_STATUS,
} from './sos.constants';
import { SosNotifierService } from './sos-notifier.service';
import { SosTriggerService } from './sos-trigger.service';

/** 会触发 SOS 状态机的事件类型（EVENTS.md §3） */
const TRIGGER_TYPES = ['possible_fall', 'manual_sos'];

/**
 * SOS 后台扫描（决策 #8：持久化 deadline + 周期扫描，禁止仅靠内存 timer）。
 * 重启恢复不需要独立逻辑——扫描只看数据库，进程重启后第一轮 tick 天然接管所有
 * 「pending 且 deadline 已过」的单；启动时记录接管数量便于核对。
 *
 * 一轮 tick 分两个互不阻塞的阶段（审计 SOS-05）：
 *   ① 到期终态化——只写库，永远很快；
 *   ② 通知投递——要等第三方，可能慢。
 * 各自独立防重入：投递阶段被一条挂起的短信拖住时，下一轮的终态化照常进行，其他用户的 SOS 不受牵连。
 */
@Injectable()
export class SosSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SosSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private finalizing = false;
  private delivering = false;
  private reconciling = false;
  /** 正在跑的那一轮投递：关闭时等它写完结果（有上界）再断库 */
  private deliveryInFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: SosNotifierService,
    private readonly sosTrigger: SosTriggerService,
  ) {}

  async onModuleInit(): Promise<void> {
    const pending = await this.prisma.sosCase.count({
      where: { status: SOS_STATUS.pending },
    });
    if (pending > 0) {
      this.logger.warn(`启动接管：${pending} 个进行中 SOS 重新纳入调度`);
    }
    // 对账（审计 SOS-02，决策 #51）：「raw 已落库、SOS 尚未建单」的事件在这里补建。
    // 启动时跑一次接住上次进程倒下时丢的；之后周期跑接住运行中丢的——建单前那次查询瞬时失败时，
    // 重投会被 eventId 幂等挡掉，原先要等到下次重启才补得回来。
    // 窗口扫描走 raw_events(received_at) 索引（2026-10-03 加），周期跑不贵
    void this.runReconcile('启动', reconcileStartupWindowMs());
    this.reconcileTimer = setInterval(
      () => void this.runReconcile('周期'),
      reconcileIntervalMs(),
    );
    this.reconcileTimer.unref();
    const interval = scanIntervalMs();
    this.timer = setInterval(() => void this.tick(), interval);
    // 不阻止进程退出：HTTP 服务本身保活，测试结束不被定时器拖住
    this.timer.unref();
    this.logger.log(
      `SOS 扫描任务已启动（间隔 ${interval}ms，对账间隔 ${reconcileIntervalMs()}ms）`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    // 在飞的那一轮投递让它写完结果再断库：短信已被服务商受理却没来得及记 sent，重启后会再发一条
    if (this.deliveryInFlight) {
      await Promise.race([
        this.deliveryInFlight,
        new Promise((resolve) =>
          setTimeout(resolve, notifyTimeoutMs()).unref(),
        ),
      ]);
    }
  }

  /** 对账一轮：独立防重入（上一轮还没跑完就跳过），失败只记日志——不影响到期扫描与通知投递 */
  private async runReconcile(
    trigger: string,
    windowMs = reconcileWindowMs(),
  ): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.reconcileLostTriggers(windowMs);
    } catch (err) {
      this.logger.error(
        `${trigger}对账失败（不影响调度，下一轮继续）：${errorMessage(err)}`,
      );
    } finally {
      this.reconciling = false;
    }
  }

  /** 一轮扫描：到期 pending 终态化 + 续投未完成通知。公开可调，测试直接驱动不等真实间隔。 */
  async tick(): Promise<void> {
    await this.finalizeExpired();
    await this.deliverOutstanding();
  }

  private async finalizeExpired(): Promise<void> {
    if (this.finalizing) return;
    this.finalizing = true;
    try {
      const expired = await this.prisma.sosCase.findMany({
        where: { status: SOS_STATUS.pending, deadline: { lte: new Date() } },
        select: { id: true },
        orderBy: { deadline: 'asc' },
        take: 50,
      });
      for (const { id } of expired) {
        // 条件更新保证幂等：与 cancel/confirm 或另一轮扫描竞态时只有一方赢；
        // 不在这里等投递——通知行已在事务里铺好，由投递阶段（或下一轮）接手
        await this.notifier.finalizeNotified(id, { deliverInline: false });
      }
    } catch (err) {
      this.logger.error(`SOS 到期扫描失败（下一轮继续）：${errorStack(err)}`);
    } finally {
      this.finalizing = false;
    }
  }

  private async deliverOutstanding(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      await this.notifier.failInterrupted();
      this.deliveryInFlight = this.notifier.deliverPending();
      await this.deliveryInFlight;
    } catch (err) {
      this.logger.error(
        `SOS 通知投递轮次失败（下一轮继续）：${errorStack(err)}`,
      );
    } finally {
      this.deliveryInFlight = null;
      this.delivering = false;
    }
  }

  /**
   * 对账：回看窗口内 raw_events 里的 possible_fall / manual_sos，若既没有对应的 SOS 单、
   * 当时设备也没有进行中的单可并入（合并规则，EVENTS.md §4.4）、且当时有绑定用户，
   * 说明建单在分发阶段丢失（DB 瞬断重试耗尽 / 进程被杀），按当时的绑定用户重新触发。
   * 返回补建条数；公开供测试与运维手动调用。
   */
  async reconcileLostTriggers(windowMs = reconcileWindowMs()): Promise<number> {
    const now = Date.now();
    const candidates = await this.prisma.rawEvent.findMany({
      where: {
        eventType: { in: TRIGGER_TYPES },
        schemaVersion: { in: [...SUPPORTED_SCHEMA_VERSIONS] },
        receivedAt: {
          gte: new Date(now - windowMs),
          lte: new Date(now - reconcileGraceMs()),
        },
      },
      orderBy: { receivedAt: 'asc' },
      take: 200,
    });
    if (candidates.length === 0) return 0;

    // eventId 只在设备内唯一（决策 #54）：按 (deviceId, eventId) 成对比对
    const pairKey = (deviceId: string, eventId: string): string =>
      `${deviceId}\u0000${eventId}`;
    const existing = await this.prisma.sosCase.findMany({
      where: {
        OR: candidates.map((c) => ({
          deviceId: c.deviceId,
          triggerEventId: c.eventId,
        })),
      },
      select: { deviceId: true, triggerEventId: true },
    });
    const hasCase = new Set(
      existing.map((c) => pairKey(c.deviceId, c.triggerEventId)),
    );

    let recovered = 0;
    for (const raw of candidates) {
      if (hasCase.has(pairKey(raw.deviceId, raw.eventId))) continue;
      // 当时无绑定用户 → 口径为只留档（没有人可通知/取消）
      const binding = await this.prisma.deviceBinding.findFirst({
        where: {
          deviceId: raw.deviceId,
          boundAt: { lte: raw.receivedAt },
          OR: [{ unboundAt: null }, { unboundAt: { gte: raw.receivedAt } }],
        },
        orderBy: { boundAt: 'desc' },
        select: { userId: true },
      });
      if (!binding) continue;
      // 当时该用户在该设备上已有进行中的单 → 按合并规则（设备 + 用户，决策 #40）只留档不建单，属正常，不是丢失。
      // manual_sos 并入的单只会以 notified 收尾（升级即立即通知）：并入对象若是 cancelled，只可能是
      // 「读到 pending 后、升级前被本人取消」那次竞态把求救吞掉了，这里要补建
      const mergedInto = await this.prisma.sosCase.findFirst({
        where: {
          deviceId: raw.deviceId,
          userId: binding.userId,
          createdAt: { lte: raw.receivedAt },
          OR: [{ finalizedAt: null }, { finalizedAt: { gte: raw.receivedAt } }],
          ...(raw.eventType === 'manual_sos'
            ? { status: { not: SOS_STATUS.cancelled } }
            : {}),
        },
        select: { id: true },
      });
      if (mergedInto) continue;
      this.logger.warn(
        `SOS 对账：事件 ${raw.eventId}（${raw.eventType}，device=${raw.deviceId}）已落库但无 SOS 单，重新触发`,
      );
      await this.sosTrigger.handleTrigger(toEnvelope(raw), binding.userId);
      recovered += 1;
    }
    if (recovered > 0) this.logger.warn(`SOS 对账补建 ${recovered} 单`);
    return recovered;
  }
}

/** raw_events 行 → 分发用 envelope（与 Ingest 校验通过后的形态一致） */
function toEnvelope(raw: RawEvent): ValidEnvelope {
  return {
    schemaVersion: raw.schemaVersion,
    eventId: raw.eventId,
    deviceId: raw.deviceId,
    eventType: raw.eventType,
    timestamp: raw.timestamp,
    firmwareVersion: raw.firmwareVersion,
    payload: (raw.payload ?? {}) as Record<string, unknown>,
  };
}
