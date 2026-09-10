import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { SmsCodeService, type SmsCodePurpose } from './sms-code.service';

/** API.md §2 定稿：access 15 分钟 / refresh 30 天（轮换制） */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface SafeUser {
  id: string;
  phone: string;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}

const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly smsCodes: SmsCodeService,
  ) {}

  /**
   * 下发验证码前按用途校验手机号状态：注册用途拒绝已注册号（不给已注册号发码，也让前端提前提示去登录）；
   * 找回密码用途要求已注册。两者都会暴露"该号是否注册"，与 register 的 409 口径一致，MVP 接受。
   */
  async sendSmsCode(phone: string, purpose: SmsCodePurpose): Promise<void> {
    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (purpose === 'register' && existing) {
      throw new ConflictException({
        code: 'PHONE_ALREADY_REGISTERED',
        message: '该手机号已注册',
      });
    }
    if (purpose === 'reset_password' && !existing) {
      throw new NotFoundException({
        code: 'PHONE_NOT_REGISTERED',
        message: '该手机号未注册',
      });
    }
    await this.smsCodes.issue(phone, purpose);
  }

  async register(
    phone: string,
    code: string,
    password: string,
    nickname?: string,
  ): Promise<{ user: SafeUser } & TokenPair> {
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      throw new ConflictException({
        code: 'PHONE_ALREADY_REGISTERED',
        message: '该手机号已注册',
      });
    }
    // 先校验并消费验证码，再建用户：验证码错误不留下半成品账号
    await this.smsCodes.verifyAndConsume(phone, 'register', code);
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { phone, passwordHash, nickname: nickname ?? null },
    });
    const tokens = await this.issueTokens(user.id);
    return { user: this.toSafeUser(user), ...tokens };
  }

  async login(
    phone: string,
    password: string,
  ): Promise<{ user: SafeUser } & TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    // 手机号不存在与密码错误返回同一错误，不给撞库者区分信息
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: '手机号或密码错误',
      });
    }
    const tokens = await this.issueTokens(user.id);
    return { user: this.toSafeUser(user), ...tokens };
  }

  /** 找回密码：验证码通过后改密，并撤销该用户全部会话（旧设备需重新登录）。 */
  async resetPassword(
    phone: string,
    code: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException({
        code: 'PHONE_NOT_REGISTERED',
        message: '该手机号未注册',
      });
    }
    await this.smsCodes.verifyAndConsume(phone, 'reset_password', code);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    this.logger.log(`用户 ${user.id} 已通过验证码重置密码，全部会话已撤销`);
  }

  /** refresh 轮换：旧 token 立即作废；检测到已作废 token 被复用 → 撤销该用户全部会话。 */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!record) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'refresh token 无效',
      });
    }
    if (record.revokedAt) {
      // 已轮换掉的 token 再次出现 = 疑似被盗用，终止该用户所有会话
      this.logger.warn(
        `refresh token 复用检测：撤销用户 ${record.userId} 全部会话`,
      );
      await this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'refresh token 已失效，请重新登录',
      });
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'refresh token 已过期，请重新登录',
      });
    }
    // 条件轮换：同一 token 并发刷新只有一方成功，输家拿 401 但不触发全局撤销（那是良性竞态，不是盗用）
    const rotated = await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (rotated.count === 0) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'refresh token 已被使用，请用最新的 token',
      });
    }
    return this.issueTokens(record.userId);
  }

  /** 登出：作废指定 refresh token（幂等——不存在也返回成功）。 */
  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(userId: string): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ sub: userId });
    // refresh 用不透明随机串（非 JWT）：可撤销、可轮换，库中只存哈希
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { accessToken, refreshToken };
  }

  private toSafeUser(u: {
    id: string;
    phone: string;
    nickname: string | null;
    avatarUrl: string | null;
    createdAt: Date;
  }): SafeUser {
    return {
      id: u.id,
      phone: u.phone,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      createdAt: u.createdAt,
    };
  }
}
