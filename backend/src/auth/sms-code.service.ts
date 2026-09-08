import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  SMS_PROVIDER,
  maskPhone,
  type SmsProvider,
} from '../providers/sms.provider';

export type SmsCodePurpose = 'register' | 'reset_password';
export const SMS_CODE_PURPOSES: readonly SmsCodePurpose[] = [
  'register',
  'reset_password',
];

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** 口径（API.md §2）：6 位数字、5 分钟有效、60s 内不重发、每号每天 10 条、连续错 5 次作废 */
const ttlSeconds = (): number => envInt('SMS_CODE_TTL_SECONDS', 300);
const resendInterval = (): number =>
  envInt('SMS_CODE_RESEND_INTERVAL_SECONDS', 60);
const dailyLimit = (): number => envInt('SMS_CODE_DAILY_LIMIT', 10);
const maxAttempts = (): number => envInt('SMS_CODE_MAX_ATTEMPTS', 5);

const hashCode = (code: string, salt: string): string =>
  createHash('sha256').update(`${salt}:${code}`).digest('hex');

const invalid = (): BadRequestException =>
  new BadRequestException({
    code: 'SMS_CODE_INVALID',
    message: '验证码错误或已失效',
  });

@Injectable()
export class SmsCodeService {
  private readonly logger = new Logger(SmsCodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  /**
   * 下发验证码。限频与日限在这里挡；手机号是否已注册由调用方按 purpose 先行校验。
   * 发送失败时删掉刚建的记录再抛错——否则用户没收到码还要被限频 60s。
   */
  async issue(phone: string, purpose: SmsCodePurpose): Promise<void> {
    const now = Date.now();
    const latest = await this.prisma.smsCode.findFirst({
      where: { phone, purpose },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (latest && now - latest.createdAt.getTime() < resendInterval() * 1000) {
      throw new HttpException(
        {
          code: 'SMS_CODE_TOO_FREQUENT',
          message: `请 ${resendInterval()} 秒后再试`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const sentToday = await this.prisma.smsCode.count({
      where: { phone, purpose, createdAt: { gte: dayAgo } },
    });
    if (sentToday >= dailyLimit()) {
      throw new HttpException(
        {
          code: 'SMS_CODE_DAILY_LIMIT',
          message: '今日验证码发送次数已达上限',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // 顺手清掉该号码 24h 前的旧记录：无需定时任务，表不会无限涨
    await this.prisma.smsCode.deleteMany({
      where: { phone, createdAt: { lt: dayAgo } },
    });

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(8).toString('hex');
    const row = await this.prisma.smsCode.create({
      data: {
        phone,
        purpose,
        salt,
        codeHash: hashCode(code, salt),
        expiresAt: new Date(now + ttlSeconds() * 1000),
      },
      select: { id: true },
    });
    try {
      await this.sms.send(phone, {
        template: 'verify_code',
        params: { code, ttlMinutes: Math.round(ttlSeconds() / 60) },
      });
    } catch (err) {
      await this.prisma.smsCode.delete({ where: { id: row.id } });
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`验证码发送失败 → ${maskPhone(phone)}：${message}`);
      throw new ServiceUnavailableException({
        code: 'SMS_SEND_FAILED',
        message: '短信发送失败，请稍后重试',
      });
    }
  }

  /**
   * 校验并消费。只认该号码该用途的最新一条；错误统一 SMS_CODE_INVALID（不区分不存在/过期/错误，不给探测信息）。
   * 消费用条件更新（consumedAt 仍为空才置位）：并发两次提交同一验证码只有一方成功。
   */
  async verifyAndConsume(
    phone: string,
    purpose: SmsCodePurpose,
    code: string,
  ): Promise<void> {
    const row = await this.prisma.smsCode.findFirst({
      where: { phone, purpose },
      orderBy: { createdAt: 'desc' },
    });
    if (
      !row ||
      row.consumedAt ||
      row.expiresAt.getTime() < Date.now() ||
      row.attempts >= maxAttempts()
    ) {
      throw invalid();
    }
    if (hashCode(code, row.salt) !== row.codeHash) {
      await this.prisma.smsCode.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
      });
      throw invalid();
    }
    const consumed = await this.prisma.smsCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid();
  }
}
