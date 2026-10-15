// 命令超时扫描：pending/delivered 超时 → offline；防重入；失败只记日志；关停停定时器。
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { CommandsSchedulerService } from './commands-scheduler.service';

describe('CommandsSchedulerService', () => {
  const updateMany = jest.fn();
  let svc: CommandsSchedulerService;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const ENV = ['COMMAND_ACK_TIMEOUT_SECONDS', 'COMMAND_SCAN_INTERVAL_MS'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    updateMany.mockReset().mockResolvedValue({ count: 0 });
    svc = new CommandsSchedulerService({
      deviceCommand: { updateMany },
    } as unknown as PrismaService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    svc.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('超时命令判 offline：只动 pending / delivered，按下发时间早于「现在 − 回执超时」', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T00:00:30Z') });
    updateMany.mockResolvedValue({ count: 2 });
    await svc.tick();
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['pending', 'delivered'] },
        issuedAt: { lte: new Date('2026-10-16T00:00:00Z') },
      },
      data: { status: 'offline' },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '2 个命令回执超时 → offline（设备离线或未执行，App 显示未送达）',
    );
  });

  it('没有超时的：不告警', async () => {
    await svc.tick();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('查库失败：只记 error，下一轮还能跑', async () => {
    updateMany.mockRejectedValueOnce(new Error('db gone'));
    await svc.tick();
    expect(errorSpy).toHaveBeenCalledWith(
      '命令扫描轮次失败（下一轮继续）：db gone',
    );
    await svc.tick();
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it('上一轮还没跑完：这一轮跳过', async () => {
    let release!: () => void;
    updateMany.mockReturnValueOnce(
      new Promise((r) => {
        release = () => r({ count: 0 });
      }),
    );
    const first = svc.tick();
    await svc.tick();
    expect(updateMany).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('启动后按间隔扫描，关停后不再扫；没启动过也能安全关停', async () => {
    jest.useFakeTimers();
    svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(5_000);
    const n = updateMany.mock.calls.length;
    expect(n).toBeGreaterThan(0);
    svc.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(updateMany).toHaveBeenCalledTimes(n);
    const fresh = new CommandsSchedulerService({
      deviceCommand: { updateMany },
    } as unknown as PrismaService);
    expect(() => fresh.onModuleDestroy()).not.toThrow();
  });
});
