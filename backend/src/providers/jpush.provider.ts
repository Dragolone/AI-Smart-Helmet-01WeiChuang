import { Injectable, Logger } from '@nestjs/common';
import { envFlag, envPositiveInt } from '../common/env';
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
  /**
   * 厂商通道参数（极光 v3/push 的 `options.third_party_channel`，原样透传）：App 被杀后 Android 只能靠
   * 华为 / 小米等厂商通道送达，而厂商按消息分类限流——SOS 要登记成系统级 / 提醒类消息才不被当营销消息
   * 压掉。各家键名不同（华为 `importance` / `category`，小米 `channel_id`，vivo `classification` / `category`），
   * 由 `JPUSH_THIRD_PARTY_CHANNEL`（JSON）给出，厂商后台申请到什么就填什么，不用改代码。
   */
  thirdPartyChannel?: Record<string, unknown>;
}

/**
 * `JPUSH_THIRD_PARTY_CHANNEL`：JSON 对象，键是厂商（huawei / xiaomi / oppo / vivo / honor），值原样透传给极光。
 * 不是合法 JSON 对象时整体忽略并出声——宁可少带参数（走极光自有通道），不能让一次解析错误拖垮推送。
 * 例外：`REQUIRE_REAL_PROVIDERS` 打开时（生产）拒绝启动——厂商通道丢了，Android 被杀后收不到 SOS 推送，
 * 只打一行日志没人会看见。
 */
export const thirdPartyChannelFromEnv = ():
  Record<string, unknown> | undefined => {
  const raw = process.env.JPUSH_THIRD_PARTY_CHANNEL?.trim();
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 下面统一出声
  }
  if (envFlag('REQUIRE_REAL_PROVIDERS')) {
    throw new Error(
      'JPUSH_THIRD_PARTY_CHANNEL 不是合法的 JSON 对象，而 REQUIRE_REAL_PROVIDERS 已打开：厂商通道参数丢了 Android 被杀后收不到 SOS 推送，拒绝启动',
    );
  }
  new Logger('JPushProvider').error(
    'JPUSH_THIRD_PARTY_CHANNEL 不是合法的 JSON 对象，已忽略：Android 被杀状态下的 SOS 推送将只走极光自有通道',
  );
  return undefined;
};

/** 从环境变量读取；AppKey 或 Master Secret 缺失返回 null → ProvidersModule 回落 Console Mock */
export const jpushConfigFromEnv = (): JPushConfig | null => {
  const appKey = process.env.JPUSH_APP_KEY;
  const masterSecret = process.env.JPUSH_MASTER_SECRET;
  if (!appKey || !masterSecret) return null;
  const thirdPartyChannel = thirdPartyChannelFromEnv();
  return {
    appKey,
    masterSecret,
    apnsProduction: envFlag('JPUSH_APNS_PRODUCTION'),
    apiUrl: process.env.JPUSH_API_URL || 'https://api.jpush.cn/v3/push',
    // 比外层 SOS_NOTIFY_TIMEOUT_MS（默认 10 s）短：同为 10 s 时，第 9.9 s 推送成功会被外层记成超时、到点再推一条（10-17 评审）
    timeoutMs: envPositiveInt('PUSH_SEND_TIMEOUT_MS', 8_000),
    ...(thirdPartyChannel ? { thirdPartyChannel } : {}),
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
  thirdPartyChannel?: Record<string, unknown>,
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
    ...(thirdPartyChannel ? { third_party_channel: thirdPartyChannel } : {}),
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
            this.config.thirdPartyChannel,
          ),
        ),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
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
    }

    // 定时器留到响应体读完再清：只回了响应头、响应体一直不来时，原来 send 会挂到 undici 默认的 300 s，
    // 「倒计时已开始」推送错过 5 s / 20 s 的重试（10-17 评审）。abort 同样中断读响应体
    try {
      return await this.readResponse(res, userId, title);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readResponse(
    res: Response,
    userId: string,
    title: string,
  ): Promise<void> {
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
