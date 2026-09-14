import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../common/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthenticatedRequest extends Request {
  user: { userId: string };
}

/**
 * 全局 JWT 守卫：默认全部接口需要 Bearer accessToken，@Public() 白名单跳过。
 * 验签后再查一次 users.deleted_at：注销后尚未过期的 access token（最长 15 分钟）若放行，
 * 幽灵账号能把设备重新绑走、再建联系人/频道（上线前探针实测），故一律 401。
 * 不存在的 userId 不在这里拦（交给各接口按 404 处理，与既有口径一致）。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
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
      select: { deletedAt: true },
    });
    if (found?.deletedAt) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: '账号已注销',
      });
    }
    req.user = { userId };
    return true;
  }
}
