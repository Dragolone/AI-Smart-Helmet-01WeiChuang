import { Injectable, Logger } from '@nestjs/common';

/** DI token：真实短信服务商（暂定阿里云）就绪后换实现，业务代码零改动（CLAUDE.md Provider 抽象） */
export const SMS_PROVIDER = 'SMS_PROVIDER';

export interface SmsProvider {
  /** 发送失败必须 throw：调用方据此记录 failed 并驱动重试 */
  send(phone: string, content: string): Promise<void>;
}

/** 手机号脱敏（Security Rules：日志不打印完整手机号）：138****1111 */
export const maskPhone = (phone: string): string =>
  phone.length >= 7
    ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
    : `${phone.slice(0, 1)}****`;

/** Mock 实现：打印代替真发（第三方账号审核期不阻塞开发，Mock Data Strategy） */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger('ConsoleSmsProvider');

  send(phone: string, content: string): Promise<void> {
    this.logger.log(`[MOCK SMS] → ${maskPhone(phone)}: ${content}`);
    return Promise.resolve();
  }
}
