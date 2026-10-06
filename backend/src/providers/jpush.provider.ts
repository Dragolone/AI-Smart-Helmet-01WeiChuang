import { Injectable, Logger } from '@nestjs/common';
import { envPositiveInt } from '../common/env';
import type { PushOptions, PushProvider } from './push.provider';

/**
 * 极光推送（决策 #10：极光统一接入层，安卓厂商通道与 iOS APNs 都挂在极光后台）。
 * 定向口径：audience = alias，alias = 用户 ID——App 登录成功后 setAlias(userId)、退出 deleteAlias，
 * 服务端只认「给哪个用户推」，不存设备 token、不建表；换手机、多设备由极光按 alias 分发。
 * REST v3 文档：https://docs.jiguang.cn/jpush/server/push/rest_api_v3_push
 */
export interface JPushConfig {
  appKey: string;
  masterSecret: string;
  /** iOS 走 APNs 生产环境（TestFlight / App Store 包）还是沙盒（Xcode 直装的开发包） */
  apnsProduction: boolean;
  apiUrl: string;
  timeoutMs: number;
}

/** 从环境变量读取；AppKey 或 Master Secret 缺失返回 null → ProvidersModule 回落 Console Mock */
export const jpushConfigFromEnv = (): JPushConfig | null => {
  const appKey = process.env.JPUSH_APP_KEY;
  const masterSecret = process.env.JPUSH_MASTER_SECRET;
  if (!appKey || !masterSecret) return null;
  return {
    appKey,
    masterSecret,
    apnsProduction: process.env.JPUSH_APNS_PRODUCTION === 'true',
    apiUrl: process.env.JPUSH_API_URL || 'https://api.jpush.cn/v3/push',
    timeoutMs: envPositiveInt('PUSH_SEND_TIMEOUT_MS', 10_000),
  };
};

/** 极光返回的错误体：{ error: { code, message } }；code 1011 = 该 alias 下没有任何设备 */
export interface JPushErrorBody {
  error?: { code?: number; message?: string };
}

export class JPushError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | undefined,
    detail: string,
  ) {
    super(
      `极光推送失败：HTTP ${httpStatus}${code !== undefined ? ` code=${code}` : ''} ${detail}`.trim(),
    );
    this.name = 'JPushError';
  }
}

/** 组装 v3/push 请求体（纯函数，单测钉住字段） */
export const buildJPushBody = (
  userId: string,
  title: string,
  body: string,
  data: Record<string, string> | undefined,
  apnsProduction: boolean,
  options?: PushOptions,
): Record<string, unknown> => ({
  platform: 'all',
  audience: { alias: [userId] },
  notification: {
    alert: body,
    android: { alert: body, title, extras: data ?? {} },
    ios: {
      alert: { title, body },
      sound: 'default',
      badge: '+1',
      extras: data ?? {},
      // 极光 Push API v3 的 iOS 字段：category 对应 APNs 的 category；interruption-level 对应 iOS 15 的中断等级
      ...(options?.category ? { category: options.category } : {}),
      ...(options?.timeSensitive
        ? { 'interruption-level': 'time-sensitive' }
        : {}),
    },
  },
  options: {
    // 离线保留一天：SOS 到期通知过了一天再送到已无意义
    time_to_live: 86_400,
    apns_production: apnsProduction,
  },
});

@Injectable()
export class JPushProvider implements PushProvider {
  private readonly logger = new Logger('JPushProvider');
  private readonly authHeader: string;

  constructor(private readonly config: JPushConfig) {
    this.authHeader = `Basic ${Buffer.from(`${config.appKey}:${config.masterSecret}`).toString('base64')}`;
  }

  async send(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: PushOptions,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref();
    let res: Response;
    try {
      res = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.authHeader,
        },
        body: JSON.stringify(
          buildJPushBody(
            userId,
            title,
            body,
            data,
            this.config.apnsProduction,
            options,
          ),
        ),
        signal: controller.signal,
      });
    } catch (err) {
      // 超时 / 网络错误都必须 throw（PushProvider 契约）：SOS 通知据此记 failed 并重试
      throw new JPushError(
        0,
        undefined,
        controller.signal.aborted
          ? `timeout after ${this.config.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = '';
      let code: number | undefined;
      try {
        const parsed = (await res.json()) as JPushErrorBody;
        code = parsed.error?.code;
        detail = parsed.error?.message ?? '';
      } catch {
        detail = '（响应体不是 JSON）';
      }
      throw new JPushError(res.status, code, detail);
    }
    // 2xx 即极光已受理：响应体读不出来（网关改写、连接中断）不能再当失败抛——上层会重试，用户就收到重复推送
    const msgId = await res
      .json()
      .then((ok: { msg_id?: string }) => ok.msg_id)
      .catch(() => undefined);
    this.logger.log(
      `推送已提交 → user:${userId} [${title}] msg_id=${msgId ?? '-'}`,
    );
  }
}
