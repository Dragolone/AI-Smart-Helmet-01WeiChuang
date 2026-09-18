import type { Response } from 'express';
import { shutdownState } from '../common/shutdown-state';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController（API.md §1.2 响应体 + 审计 DBOPS-07 排空期）', () => {
  const prisma = { $queryRaw: jest.fn() };
  const controller = new HealthController(prisma as unknown as PrismaService);
  const res = () => {
    const status = jest.fn();
    return { res: { status } as unknown as Response, status };
  };

  beforeEach(() => {
    jest.resetAllMocks();
    shutdownState.reset();
  });

  it('数据库连通 → 200 { ok, connected }', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const { res: r, status } = res();
    await expect(controller.check(r)).resolves.toEqual({
      status: 'ok',
      database: 'connected',
    });
    expect(status).not.toHaveBeenCalled();
  });

  it('数据库不可达 → 503 { error, unreachable }（文档规定的体，不经统一异常过滤器改写）', async () => {
    prisma.$queryRaw.mockRejectedValue(
      new Error("Can't reach database server"),
    );
    const { res: r, status } = res();
    await expect(controller.check(r)).resolves.toEqual({
      status: 'error',
      database: 'unreachable',
    });
    expect(status).toHaveBeenCalledWith(503);
  });

  it('排空期（收到 SIGTERM 后）→ 503 { draining, connected }：网关摘流量，但数据库仍可用', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    shutdownState.markDraining();
    const { res: r, status } = res();
    await expect(controller.check(r)).resolves.toEqual({
      status: 'draining',
      database: 'connected',
    });
    expect(status).toHaveBeenCalledWith(503);
  });

  it('排空期数据库又不可达 → 以 error/unreachable 为准（更严重的状态优先）', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('down'));
    shutdownState.markDraining();
    await expect(controller.check(res().res)).resolves.toEqual({
      status: 'error',
      database: 'unreachable',
    });
  });
});
