import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SOS_STATUS, scanIntervalMs } from './sos.constants';
import { SosNotifierService } from './sos-notifier.service';

/**
 * SOS 后台扫描（决策 #8：持久化 deadline + 周期扫描，禁止仅靠内存 timer）。
 * 重启恢复不需要独立逻辑——扫描只看数据库，进程重启后第一轮 tick 天然接管所有
 * 「pending 且 deadline 已过」的单；启动时记录接管数量便于核对。
 */
@Injectable()
export class SosSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SosSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 单实例内防重入：上一轮没跑完（如通知量大）就跳过本轮，避免自我踩踏 */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: SosNotifierService,
  ) {}

  async onModuleInit(): Promise<void> {
    const pending = await this.prisma.sosCase.count({
      where: { status: SOS_STATUS.pending },
    });
    if (pending > 0) {
      this.logger.warn(`启动接管：${pending} 个进行中 SOS 重新纳入调度`);
    }
    const interval = scanIntervalMs();
    this.timer = setInterval(() => void this.tick(), interval);
    // 不阻止进程退出：HTTP 服务本身保活，测试结束不被定时器拖住
    this.timer.unref();
    this.logger.log(`SOS 扫描任务已启动（间隔 ${interval}ms）`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 一轮扫描：到期 pending 终态化 + 续投未完成通知。公开可调，测试直接驱动不等真实间隔。 */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const expired = await this.prisma.sosCase.findMany({
        where: { status: SOS_STATUS.pending, deadline: { lte: new Date() } },
        select: { id: true },
        orderBy: { deadline: 'asc' },
        take: 50,
      });
      for (const { id } of expired) {
        // 条件更新保证幂等：与 cancel/confirm 或另一轮扫描竞态时只有一方赢
        await this.notifier.finalizeNotified(id);
      }
      await this.notifier.deliverPending();
    } catch (err) {
      this.logger.error(
        `SOS 扫描轮次失败（下一轮继续）：${err instanceof Error ? err.stack : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
