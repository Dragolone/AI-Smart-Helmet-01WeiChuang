import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { adminPasswordVersion } from './admin-auth.service';
import { ADMIN_JWT_SECRET } from './admin.constants';

export interface AdminRequest extends Request {
  admin: { adminId: string };
}

const unauthorized = () =>
  new UnauthorizedException({
    code: 'UNAUTHORIZED',
    message: '管理员访问令牌无效或已过期',
  });

/**
 * Admin 专用守卫：admin 控制器类级 @Public() 跳过全局用户守卫后，由本守卫接管。
 * 密钥与用户 JWT 不同，App 用户 token 在此必然验签失败。
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ADMIN_JWT_SECRET) private readonly secret: string,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw unauthorized();
    try {
      const payload = await this.jwt.verifyAsync<{
        sub: string;
        typ?: string;
        pv?: string;
      }>(token, { secret: this.secret });
      // typ 双保险：即使未来两套密钥被误配成同值，用户 token 也进不来
      if (payload.typ !== 'admin') throw new Error('not an admin token');
      // 管理员已删除 / 已改密（密码指纹对不上）：旧 token 立即失效，不再等 12 h 自然过期（观察项 7）
      const admin = await this.prisma.adminUser.findUnique({
        where: { id: payload.sub },
        select: { passwordHash: true },
      });
      if (!admin || payload.pv !== adminPasswordVersion(admin.passwordHash)) {
        throw new Error('admin revoked or password changed');
      }
      req.admin = { adminId: payload.sub };
      return true;
    } catch {
      throw unauthorized();
    }
  }
}
