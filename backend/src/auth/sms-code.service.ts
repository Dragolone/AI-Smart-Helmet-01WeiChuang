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
import { envPositiveInt } from '../common/env';
import { errorMessage } from '../common/error-text';
import { withTimeout } from '../common/with-timeout';
import { PrismaService } from '../prisma/prisma.service';
import {
  SMS_PROVIDER,
  maskPhone,
  type SmsProvider,
} from '../providers/sms.provider';

// change_phone：phone 为待换绑的新号（API.md §2，2026-09-11）
export type SmsCodePurpose = 'register' | 'reset_password' | 'change_phone';
export const SMS_CODE_PURPOSES: readonly SmsCodePurpose[] = [
  'register',
  'reset_password',
  'change_phone',
];

/** 口径（API.md §2）：6 位数字、5 分钟有效、60s 内不重发、每号每天 10 条、连续错 5 次作废 */
const ttlSeconds = (): number => envPositiveInt('SMS_CODE_TTL_SECONDS', 300);
const resendInterval = (): number =>
  envPositiveInt('SMS_CODE_RESEND_INTERVAL_SECONDS', 60);
const dailyLimit = (): number => envPositiveInt('SMS_CODE_DAILY_LIMIT', 10);
const maxAttempts = (): number => envPositiveInt('SMS_CODE_MAX_ATTEMPTS', 5);
/** 单次短信通道调用的应用层超时（审计 AUTH-11）：挂起的 Provider 不能把发码请求一起挂住 */
const sendTimeoutMs = (): number =>
  envPositiveInt('SMS_SEND_TIMEOUT_MS', 10_000);

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
   * 「查最新 → 计数 → 建记录」在一个事务里、按「用途+号码」持咨询锁串行化（审计 AUTH-04）：
   * 同号并发发码只放行一条，其余按 60s 间隔 429——先查后写不加锁时并发全部放行、Provider 真发多条。
   * 发送在事务外（不让第三方调用占着数据库连接）；发送失败/超时删掉刚建的记录再抛错——
   * 否则用户没收到码还要被限频 60s。
   */
  async issue(phone: string, purpose: SmsCodePurpose): Promise<void> {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(8).toString('hex');

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sms:${purpose}:${phone}`}))`;
      const latest = await tx.smsCode.findFirst({
        where: { phone, purpose },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (
        latest &&
        now - latest.createdAt.getTime() < resendInterval() * 1000
      ) {
        throw new HttpException(
          {
            code: 'SMS_CODE_TOO_FREQUENT',
            message: `请 ${resendInterval()} 秒后再试`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const sentToday = await tx.smsCode.count({
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
      await tx.smsCode.deleteMany({
        where: { phone, createdAt: { lt: dayAgo } },
      });
      return tx.smsCode.create({
        data: {
          phone,
          purpose,
          salt,
          codeHash: hashCode(code, salt),
          expiresAt: new Date(now + ttlSeconds() * 1000),
        },
        select: { id: true },
      });
    });

    try {
      await withTimeout(
        this.sms.send(phone, {
          template: 'verify_code',
          params: { code, ttlMinutes: Math.round(ttlSeconds() / 60) },
        }),
        sendTimeoutMs(),
        'sms.send(verify_code)',
      );
    } catch (err) {
      await this.prisma.smsCode.delete({ where: { id: row.id } });
      const message = errorMessage(err);
      this.logger.error(`验证码发送失败 → ${maskPhone(phone)}：${message}`);
      throw new ServiceUnavailableException({
        code: 'SMS_SEND_FAILED',
        message: '短信发送失败，请稍后重试',
      });
    }
  }

  /**
   * 校验并消费。只认该号码该用途的最新一条；错误统一 SMS_CODE_INVALID（不区分不存在/过期/错误，不给探测信息）。
   * 先占一次尝试名额再比对（条件自增，由行锁串行化）：「读 attempts → 比对 → 错了才 +1」在并发下
   * 所有请求都读到未超限、各比对一次，N 路并发就能猜 N 次，上限形同虚设。
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
    const claimed = await this.prisma.smsCode.updateMany({
      where: {
        id: row.id,
        consumedAt: null,
        attempts: { lt: maxAttempts() },
      },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw invalid();
    if (hashCode(code, row.salt) !== row.codeHash) throw invalid();
    const consumed = await this.prisma.smsCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid();
  }
}
