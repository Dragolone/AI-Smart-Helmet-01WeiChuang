import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_JWT_SECRET, ADMIN_TOKEN_TTL } from './admin.constants';

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
    // 账号不存在与密码错误同一响应，不给撞库者区分信息（与用户登录同口径）
    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: '用户名或密码错误',
      });
    }
    const accessToken = await this.jwt.signAsync(
      { sub: admin.id, typ: 'admin' },
      { secret: this.secret, expiresIn: ADMIN_TOKEN_TTL },
    );
    return {
      admin: { id: admin.id, username: admin.username },
      accessToken,
    };
  }
}
