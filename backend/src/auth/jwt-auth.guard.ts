import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { errorMessage } from '../common/error-text';
import { accountDeleted } from '../common/live-user';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { CLIENT_TIMEZONE_HEADER, normalizeTimeZone } from '../common/time-zone';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthenticatedRequest extends Request {
  user: { userId: string };
}

/**
 * 全局 JWT 守卫：默认全部接口需要 Bearer accessToken，@Public() 白名单跳过。
 * 验签后再查一次 users.deleted_at：注销后尚未过期的 access token（最长 15 分钟）若放行，
 * 幽灵账号能把设备重新绑走、再建联系人/频道（上线前探针实测），故一律 401 ACCOUNT_DELETED。
 * 不存在的 userId 不在这里拦（交给各接口按 404 处理，与既有口径一致）。
 * 顺带记下手机时区（O13）：反正每个请求都要读一次用户行，X-Client-Timezone 与记下的不同才写一次。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: '缺少访问令牌',
      });
    }
    let userId: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; typ?: string }>(
        token,
      );
      // 双保险（与 admin 守卫对称）：两套密钥被误配成同值时，admin token 也进不来用户接口
      if (payload.typ === 'admin') throw new Error('not a user token');
      userId = payload.sub;
    } catch {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: '访问令牌无效或已过期',
      });
    }
    const found = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true, timeZone: true },
    });
    if (found?.deletedAt) throw accountDeleted();
    const timeZone = normalizeTimeZone(req.headers[CLIENT_TIMEZONE_HEADER]);
    if (found && timeZone && timeZone !== found.timeZone) {
      await this.rememberTimeZone(userId, timeZone);
    }
    req.user = { userId };
    return true;
  }

  /** 推送正文的时间按它写（API.md §1）。写失败不影响这次请求：下一个请求还会再写 */
  private async rememberTimeZone(
    userId: string,
    timeZone: string,
  ): Promise<void> {
    try {
      // 条件 deleted_at IS NULL：守卫查完到这里之间注销提交了，不把时区写回已注销账号（注销时清空）
      await this.prisma.user.updateMany({
        where: { id: userId, deletedAt: null },
        data: { timeZone },
      });
    } catch (err) {
      this.logger.warn(
        `记录用户 ${userId} 的手机时区失败（推送时间暂按旧值 / 北京时间）：${errorMessage(err)}`,
      );
    }
  }
}
