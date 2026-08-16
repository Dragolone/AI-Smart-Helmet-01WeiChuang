import { Module } from '@nestjs/common';
import { ConsolePushProvider, PUSH_PROVIDER } from './push.provider';
import { ConsoleSmsProvider, SMS_PROVIDER } from './sms.provider';
import { MockStorageProvider, STORAGE_PROVIDER } from './storage.provider';

/** 第三方 Provider（CLAUDE.md：薄接口 + Mock 实现，账号审核期不阻塞开发；禁止 Plugin Architecture） */
@Module({
  providers: [
    { provide: SMS_PROVIDER, useClass: ConsoleSmsProvider },
    { provide: PUSH_PROVIDER, useClass: ConsolePushProvider },
    { provide: STORAGE_PROVIDER, useClass: MockStorageProvider },
  ],
  exports: [SMS_PROVIDER, PUSH_PROVIDER, STORAGE_PROVIDER],
})
export class ProvidersModule {}
