import { Injectable, Logger } from '@nestjs/common';

/** DI token：极光/APNs 就绪后换实现（依赖公司 Apple Developer 账号，见 CLAUDE.md 待确认事项） */
export const PUSH_PROVIDER = 'PUSH_PROVIDER';

/** 发送选项（iOS 侧）：类别让远程推送也带上 App 注册的按钮；时效性让它穿透专注模式 */
export interface PushOptions {
  /** UNNotificationCategory 标识。App 登录后向系统注册类别 "sos"（取消 / 打开两个按钮），杀掉 App 后仍有效 */
  category?: string;
  /** iOS 15+ 时效性通知：勿扰 / 睡眠 / 驾驶等专注模式下照样弹出；App 需声明 time-sensitive entitlement（A 线 10-06 已加） */
  timeSensitive?: boolean;
}

export interface PushProvider {
  /** 发送失败必须 throw：调用方据此记录 failed 并驱动重试 */
  send(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: PushOptions,
  ): Promise<void>;
}

/** Mock 实现：打印代替真推（SOS 链路演示经 WS 兜底展示） */
@Injectable()
export class ConsolePushProvider implements PushProvider {
  private readonly logger = new Logger('ConsolePushProvider');

  send(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: PushOptions,
  ): Promise<void> {
    this.logger.log(
      `[MOCK PUSH] → user:${userId}: ${title} | ${body}${data ? ` | ${JSON.stringify(data)}` : ''}${options ? ` | ${JSON.stringify(options)}` : ''}`,
    );
    return Promise.resolve();
  }
}
