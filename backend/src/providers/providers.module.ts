import { Logger, Module } from '@nestjs/common';
import { ConsolePushProvider, PUSH_PROVIDER } from './push.provider';
import {
  ConsoleSmsProvider,
  SMS_PROVIDER,
  type SmsProvider,
} from './sms.provider';
import { MockStorageProvider, STORAGE_PROVIDER } from './storage.provider';
import {
  TencentSmsProvider,
  tencentSmsConfigFromEnv,
} from './tencent-sms.provider';

/**
 * 短信：TENCENT_SMS_* 六项环境变量齐全即走腾讯云，否则 Console Mock。
 * 选择只发生在这里（组装层），业务代码不感知（CLAUDE.md：禁止业务层 if (isMock)）。
 */
const smsProviderFactory = (): SmsProvider => {
  const config = tencentSmsConfigFromEnv();
  if (config) {
    new Logger('ProvidersModule').log(
      `短信通道：腾讯云（签名「${config.signName}」）`,
    );
    return new TencentSmsProvider(config);
  }
  new Logger('ProvidersModule').log(
    '短信通道：Console Mock（未配置 TENCENT_SMS_*，验证码打印在日志）',
  );
  return new ConsoleSmsProvider();
};

/** 第三方 Provider（CLAUDE.md：薄接口 + Mock 实现，账号审核期不阻塞开发；禁止 Plugin Architecture） */
@Module({
  providers: [
    { provide: SMS_PROVIDER, useFactory: smsProviderFactory },
    { provide: PUSH_PROVIDER, useClass: ConsolePushProvider },
    { provide: STORAGE_PROVIDER, useClass: MockStorageProvider },
  ],
  exports: [SMS_PROVIDER, PUSH_PROVIDER, STORAGE_PROVIDER],
})
export class ProvidersModule {}
