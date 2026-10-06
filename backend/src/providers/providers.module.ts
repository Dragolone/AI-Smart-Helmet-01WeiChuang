import { Logger, Module } from '@nestjs/common';
import { JPushProvider, jpushConfigFromEnv } from './jpush.provider';
import {
  ConsolePushProvider,
  PUSH_PROVIDER,
  type PushProvider,
} from './push.provider';
import {
  ConsoleSmsProvider,
  SMS_PROVIDER,
  type SmsProvider,
} from './sms.provider';
import {
  MockStorageProvider,
  STORAGE_PROVIDER,
  type StorageProvider,
} from './storage.provider';
import {
  TencentCosProvider,
  tencentCosConfigFromEnv,
} from './tencent-cos.provider';
import {
  TencentSmsProvider,
  tencentSmsConfigFromEnv,
} from './tencent-sms.provider';

/**
 * `REQUIRE_REAL_PROVIDERS=1`（production 的 .env 必须设）：任一通道配置不全时拒绝启动，而不是静默回落 Mock。
 * Mock 短信「发送成功」与真发在通知记录、本人推送文案、事故详情里完全不可区分——生产漏填一项
 * `TENCENT_SMS_*`，每一次真求救都会记成「已通知联系人」而一条短信都没发（10-06 不变式评审 F-2）。
 * development 不设：短信签名 / 推送账号审核期间就是要用 Mock 跑联调。
 */
const requireReal = (): boolean => process.env.REQUIRE_REAL_PROVIDERS === '1';
const refuseMock = (channel: string, missing: string): never => {
  throw new Error(
    `${channel}未配置（${missing}），而 REQUIRE_REAL_PROVIDERS=1 禁止回落 Mock——生产环境不能把假发送记成已通知。补齐配置或去掉该开关后重启`,
  );
};

/**
 * 短信：TENCENT_SMS_* 六项环境变量齐全即走腾讯云，否则 Console Mock。
 * 选择只发生在这里（组装层），业务代码不感知（CLAUDE.md：禁止业务层 if (isMock)）。
 */
export const smsProviderFactory = (): SmsProvider => {
  const config = tencentSmsConfigFromEnv();
  if (config) {
    new Logger('ProvidersModule').log(
      `短信通道：腾讯云（签名「${config.signName}」）`,
    );
    return new TencentSmsProvider(config);
  }
  if (requireReal()) refuseMock('短信通道', 'TENCENT_SMS_* 六项不全');
  new Logger('ProvidersModule').log(
    '短信通道：Console Mock（未配置 TENCENT_SMS_*，验证码打印在日志）',
  );
  return new ConsoleSmsProvider();
};

/** 推送：JPUSH_APP_KEY + JPUSH_MASTER_SECRET 齐全即走极光（按 alias=userId 定向），否则 Console Mock */
export const pushProviderFactory = (): PushProvider => {
  const config = jpushConfigFromEnv();
  if (config) {
    new Logger('ProvidersModule').log(
      `推送通道：极光（APNs ${config.apnsProduction ? '生产' : '沙盒'}环境）`,
    );
    return new JPushProvider(config);
  }
  if (requireReal())
    refuseMock('推送通道', 'JPUSH_APP_KEY / JPUSH_MASTER_SECRET');
  new Logger('ProvidersModule').log(
    '推送通道：Console Mock（未配置 JPUSH_*，推送内容打印在日志）',
  );
  return new ConsolePushProvider();
};

/** 对象存储：TENCENT_COS_* 密钥与桶名齐全即走腾讯云 COS，否则 Mock（占位 URL，不可访问） */
export const storageProviderFactory = (): StorageProvider => {
  const config = tencentCosConfigFromEnv();
  if (config) {
    new Logger('ProvidersModule').log(
      `对象存储：腾讯云 COS（${config.bucket} / ${config.region}）`,
    );
    return new TencentCosProvider(config);
  }
  if (requireReal()) refuseMock('对象存储', 'TENCENT_COS_*');
  new Logger('ProvidersModule').log(
    '对象存储：Mock（未配置 TENCENT_COS_*，签发的是不可访问的占位 URL）',
  );
  return new MockStorageProvider();
};

/** 第三方 Provider（CLAUDE.md：薄接口 + Mock 实现，账号审核期不阻塞开发；禁止 Plugin Architecture） */
@Module({
  providers: [
    { provide: SMS_PROVIDER, useFactory: smsProviderFactory },
    { provide: PUSH_PROVIDER, useFactory: pushProviderFactory },
    { provide: STORAGE_PROVIDER, useFactory: storageProviderFactory },
  ],
  exports: [SMS_PROVIDER, PUSH_PROVIDER, STORAGE_PROVIDER],
})
export class ProvidersModule {}
