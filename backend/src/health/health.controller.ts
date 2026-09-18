import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/public.decorator';
import { shutdownState } from '../common/shutdown-state';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthBody {
  status: 'ok' | 'error' | 'draining';
  database: 'connected' | 'unreachable';
}

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 探活响应体按 API.md §1.2 固定为 { status, database }：直接写状态码而不抛异常，统一过滤器不会改写它。
   * 收到 SIGTERM 后的排空期返回 503 draining（数据库仍连通）：网关据此停止转发，在途请求照常完成。
   */
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthBody> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'error', database: 'unreachable' };
    }
    if (shutdownState.isDraining()) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'draining', database: 'connected' };
    }
    return { status: 'ok', database: 'connected' };
  }
}
