// Provider 选择分支：配置齐全走真实现（SDK 全部 mock，不发网络请求），缺项回落 Mock，
// REQUIRE_REAL_PROVIDERS=1 时缺项拒绝启动（另见 providers.module.spec.ts）。
import { Logger } from '@nestjs/common';

jest.mock('tencentcloud-sdk-nodejs-sms', () => ({
  sms: { v20210111: { Client: jest.fn().mockImplementation(() => ({})) } },
}));
jest.mock('cos-nodejs-sdk-v5', () =>
  jest.fn().mockImplementation(() => ({ getObjectUrl: jest.fn() })),
);

import { Test } from '@nestjs/testing';
import { JPushProvider } from './jpush.provider';
import {
  ProvidersModule,
  pushProviderFactory,
  smsProviderFactory,
  storageProviderFactory,
} from './providers.module';
import { ConsolePushProvider, PUSH_PROVIDER } from './push.provider';
import { ConsoleSmsProvider, SMS_PROVIDER } from './sms.provider';
import { MockStorageProvider, STORAGE_PROVIDER } from './storage.provider';
import { TencentCosProvider } from './tencent-cos.provider';
import { TencentSmsProvider } from './tencent-sms.provider';

const KEYS = [
  'REQUIRE_REAL_PROVIDERS',
  'TENCENT_SMS_SECRET_ID',
  'TENCENT_SMS_SECRET_KEY',
  'TENCENT_SMS_SDK_APP_ID',
  'TENCENT_SMS_SIGN_NAME',
  'TENCENT_SMS_TEMPLATE_VERIFY_CODE',
  'TENCENT_SMS_TEMPLATE_SOS_ALERT',
  'TENCENT_SMS_REGION',
  'JPUSH_APP_KEY',
  'JPUSH_MASTER_SECRET',
  'JPUSH_APNS_PRODUCTION',
  'JPUSH_THIRD_PARTY_CHANNEL',
  'JPUSH_API_URL',
  'TENCENT_COS_SECRET_ID',
  'TENCENT_COS_SECRET_KEY',
  'TENCENT_COS_BUCKET',
  'TENCENT_COS_REGION',
];

const SMS_FULL = {
  TENCENT_SMS_SECRET_ID: 'id',
  TENCENT_SMS_SECRET_KEY: 'key',
  TENCENT_SMS_SDK_APP_ID: '1400000000',
  TENCENT_SMS_SIGN_NAME: '测试签名',
  TENCENT_SMS_TEMPLATE_VERIFY_CODE: '1',
  TENCENT_SMS_TEMPLATE_SOS_ALERT: '2',
};
const PUSH_FULL = { JPUSH_APP_KEY: 'appkey', JPUSH_MASTER_SECRET: 'secret' };
const COS_FULL = {
  TENCENT_COS_SECRET_ID: 'id',
  TENCENT_COS_SECRET_KEY: 'key',
  TENCENT_COS_BUCKET: 'media-1250000000',
};

describe('Provider 工厂：配置齐全走真实现', () => {
  const saved: Record<string, string | undefined> = {};
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const logged = (): string =>
    logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  it('短信六项齐全：腾讯云实现，日志点名签名；REQUIRE_REAL_PROVIDERS=1 也放行', () => {
    Object.assign(process.env, SMS_FULL, { REQUIRE_REAL_PROVIDERS: '1' });
    expect(smsProviderFactory()).toBeInstanceOf(TencentSmsProvider);
    expect(logged()).toContain('短信通道：腾讯云（签名「测试签名」）');
  });

  it('短信回落 Mock 时日志说明验证码打印在日志', () => {
    expect(smsProviderFactory()).toBeInstanceOf(ConsoleSmsProvider);
    expect(logged()).toContain('短信通道：Console Mock');
  });

  it('推送齐全（沙盒、未配厂商通道）：极光实现，日志写明沙盒 + 只走极光自有通道', () => {
    Object.assign(process.env, PUSH_FULL);
    expect(pushProviderFactory()).toBeInstanceOf(JPushProvider);
    expect(logged()).toContain(
      '推送通道：极光（APNs 沙盒环境；厂商通道参数：未配置，Android 被杀状态下只走极光自有通道）',
    );
  });

  it('推送齐全（生产 + 厂商通道）：日志列出已配的厂商键名', () => {
    Object.assign(process.env, PUSH_FULL, {
      JPUSH_APNS_PRODUCTION: 'true',
      JPUSH_THIRD_PARTY_CHANNEL: JSON.stringify({
        huawei: { importance: 'NORMAL' },
        xiaomi: { channel_id: 'sos' },
      }),
      REQUIRE_REAL_PROVIDERS: '1',
    });
    expect(pushProviderFactory()).toBeInstanceOf(JPushProvider);
    expect(logged()).toContain(
      '推送通道：极光（APNs 生产环境；厂商通道参数：huawei/xiaomi）',
    );
  });

  it('推送厂商通道 JSON 写坏：仍走极光（不拖垮推送），但出声并按未配置处理', () => {
    Object.assign(process.env, PUSH_FULL, {
      JPUSH_THIRD_PARTY_CHANNEL: '{huawei:',
    });
    expect(pushProviderFactory()).toBeInstanceOf(JPushProvider);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('JPUSH_THIRD_PARTY_CHANNEL 不是合法的 JSON 对象'),
    );
    expect(logged()).toContain('厂商通道参数：未配置');
  });

  it('推送只有 AppKey 没有 Master Secret：回落 Mock', () => {
    process.env.JPUSH_APP_KEY = 'appkey';
    expect(pushProviderFactory()).toBeInstanceOf(ConsolePushProvider);
    expect(logged()).toContain('推送通道：Console Mock');
  });

  it('COS 齐全：腾讯云实现，日志带桶名与缺省地域', () => {
    Object.assign(process.env, COS_FULL, { REQUIRE_REAL_PROVIDERS: '1' });
    expect(storageProviderFactory()).toBeInstanceOf(TencentCosProvider);
    expect(logged()).toContain(
      '对象存储：腾讯云 COS（media-1250000000 / ap-guangzhou）',
    );
  });

  it('COS 缺桶名：回落 Mock 占位 URL；REQUIRE_REAL_PROVIDERS=1 时拒绝', () => {
    process.env.TENCENT_COS_SECRET_ID = 'id';
    process.env.TENCENT_COS_SECRET_KEY = 'key';
    expect(storageProviderFactory()).toBeInstanceOf(MockStorageProvider);
    expect(logged()).toContain('对象存储：Mock');
    process.env.REQUIRE_REAL_PROVIDERS = '1';
    expect(() => storageProviderFactory()).toThrow(
      /对象存储未配置（TENCENT_COS_\*）.*REQUIRE_REAL_PROVIDERS=1 禁止回落 Mock/,
    );
  });

  it('ProvidersModule 组装：三个 token 都能注入，取到的是工厂按当前环境选出的实现', async () => {
    Object.assign(process.env, SMS_FULL);
    const mod = await Test.createTestingModule({
      imports: [ProvidersModule],
    }).compile();
    expect(mod.get(SMS_PROVIDER)).toBeInstanceOf(TencentSmsProvider);
    expect(mod.get(PUSH_PROVIDER)).toBeInstanceOf(ConsolePushProvider);
    expect(mod.get(STORAGE_PROVIDER)).toBeInstanceOf(MockStorageProvider);
    await mod.close();
  });
});
