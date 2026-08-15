import { Injectable, Logger } from '@nestjs/common';

/** DI token：极光/APNs 就绪后换实现（依赖公司 Apple Developer 账号，见 CLAUDE.md 待确认事项） */
export const PUSH_PROVIDER = 'PUSH_PROVIDER';

export interface PushProvider {
  /** 发送失败必须 throw：调用方据此记录 failed 并驱动重试 */
  send(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
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
  ): Promise<void> {
    this.logger.log(
      `[MOCK PUSH] → user:${userId}: ${title} | ${body}${data ? ` | ${JSON.stringify(data)}` : ''}`,
    );
    return Promise.resolve();
  }
}
