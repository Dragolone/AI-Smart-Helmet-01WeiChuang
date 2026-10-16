import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AdminLoginResponse } from '@helmet/shared';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_JWT_SECRET, ADMIN_TOKEN_TTL } from './admin.constants';

/**
 * 管理员 token 里带的密码指纹：改密（create:admin --reset）后旧 token 立即失效、删掉管理员后其 token 立即失效。
 * admin token 无状态、12 h 不能吊销（观察项 7，10-17 评审）；指纹取密码哈希的哈希前 16 位，不泄露哈希本身
 */
export const adminPasswordVersion = (passwordHash: string): string =>
  createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);

/** 账号不存在时也做一次同成本的比对：否则「用户名存在」比「不存在」慢约 50 ms，可借此枚举管理员用户名 */
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(ADMIN_JWT_SECRET) private readonly secret: string,
  ) {}

  async login(username: string, password: string) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { username },
    });
    // 账号不存在与密码错误同一响应、同一耗时，不给撞库者区分信息
    const ok = await bcrypt.compare(
      password,
      admin?.passwordHash ?? DUMMY_HASH,
    );
    if (!admin || !ok) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: '用户名或密码错误',
      });
    }
    const accessToken = await this.jwt.signAsync(
      {
        sub: admin.id,
        typ: 'admin',
        pv: adminPasswordVersion(admin.passwordHash),
      },
      { secret: this.secret, expiresIn: ADMIN_TOKEN_TTL },
    );
    return {
      admin: { id: admin.id, username: admin.username },
      accessToken,
    } satisfies AdminLoginResponse;
  }
}
