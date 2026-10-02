import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { errorMessage } from '../common/error-text';
import { PrismaService } from '../prisma/prisma.service';
import {
  COMMAND_STATUS,
  ackTimeoutMs,
  commandScanIntervalMs,
} from './commands.constants';

/**
 * 命令超时扫描（与 SOS 调度器同模式）：pending/delivered 超过回执超时窗口 → offline。
 * 只看数据库，重启后第一轮 tick 天然接管遗留命令；迟到回执可覆盖 offline（如实记录）。
 * 设备离线时命令显示「未送达」——绝不把未执行显示为成功（CLAUDE.md 设置下发铁律）。
 */
@Injectable()
export class CommandsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandsSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    const interval = commandScanIntervalMs();
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    this.logger.log(
      `命令超时扫描已启动（间隔 ${interval}ms，回执超时 ${ackTimeoutMs() / 1000}s）`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 公开可调：测试直接驱动，不等真实间隔 */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const timedOut = await this.prisma.deviceCommand.updateMany({
        where: {
          status: { in: [COMMAND_STATUS.pending, COMMAND_STATUS.delivered] },
          issuedAt: { lte: new Date(Date.now() - ackTimeoutMs()) },
        },
        data: { status: COMMAND_STATUS.offline },
      });
      if (timedOut.count > 0) {
        this.logger.warn(
          `${timedOut.count} 个命令回执超时 → offline（设备离线或未执行，App 显示未送达）`,
        );
      }
    } catch (err) {
      this.logger.error(`命令扫描轮次失败（下一轮继续）：${errorMessage(err)}`);
    } finally {
      this.running = false;
    }
  }
}
