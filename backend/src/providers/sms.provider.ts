import { Injectable, Logger } from '@nestjs/common';

/** DI token：真实短信服务商（腾讯云，决策 #34）就绪后换实现，业务代码零改动（CLAUDE.md Provider 抽象） */
export const SMS_PROVIDER = 'SMS_PROVIDER';

/**
 * 短信按模板发送（腾讯云等运营商通道只允许"模板 ID + 变量"，不允许自由文本）。
 * 每个模板的变量按对象命名，由具体 Provider 映射为运营商要求的顺序。
 * 模板文案见 docs/THIRD_PARTY.md §4，变量顺序 {1}{2}{3} 与此处字段声明顺序一致。
 */
export type SmsMessage =
  | {
      template: 'verify_code';
      /** {1} 验证码；{2} 有效期分钟数 */
      params: { code: string; ttlMinutes: number };
    }
  | {
      template: 'sos_alert';
      /** {1} 佩戴者昵称；{2} 触发时间（本地时区短格式）；{3} 位置文本或链接 */
      params: { nickname: string; triggeredAt: string; locationText: string };
    };

export type SmsTemplate = SmsMessage['template'];

export interface SmsProvider {
  /** 发送失败必须 throw：调用方据此记录 failed 并驱动重试 */
  send(phone: string, message: SmsMessage): Promise<void>;
}

/** 手机号脱敏（Security Rules：日志不打印完整手机号）：138****1111 */
export const maskPhone = (phone: string): string =>
  phone.length >= 7
    ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
    : `${phone.slice(0, 1)}****`;

/** 模板渲染成可读文本（Mock 打印用；与腾讯云侧审核通过的模板文案保持一致） */
export const renderSmsText = (m: SmsMessage): string => {
  switch (m.template) {
    case 'verify_code':
      return `您的验证码为${m.params.code}，${m.params.ttlMinutes}分钟内有效，请勿泄露给他人。`;
    case 'sos_alert':
      return `您的联系人${m.params.nickname}佩戴的智能头盔于${m.params.triggeredAt}触发紧急求救，位置：${m.params.locationText}，请尽快联系确认。`;
  }
};

/** Mock 实现：打印代替真发（第三方账号审核期不阻塞开发，Mock Data Strategy）。验证码明文进日志，本地/演示环境凭日志完成注册。 */
@Injectable()
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger('ConsoleSmsProvider');

  send(phone: string, message: SmsMessage): Promise<void> {
    this.logger.log(
      `[MOCK SMS] → ${maskPhone(phone)} [${message.template}] ${renderSmsText(message)}`,
    );
    return Promise.resolve();
  }
}
