// 10-06 不变式评审 F-2：生产环境不能把 Mock 发送记成「已通知」——REQUIRE_REAL_PROVIDERS=1 时配置不全就拒绝启动
import { ConsolePushProvider } from './push.provider';
import {
  pushProviderFactory,
  smsProviderFactory,
  storageProviderFactory,
} from './providers.module';
import { ConsoleSmsProvider } from './sms.provider';
import { MockStorageProvider } from './storage.provider';

const KEYS = [
  'REQUIRE_REAL_PROVIDERS',
  'TENCENT_SMS_SECRET_ID',
  'TENCENT_SMS_SECRET_KEY',
  'TENCENT_SMS_SDK_APP_ID',
  'TENCENT_SMS_SIGN_NAME',
  'TENCENT_SMS_TEMPLATE_VERIFY_CODE',
  'TENCENT_SMS_TEMPLATE_SOS_ALERT',
  'JPUSH_APP_KEY',
  'JPUSH_MASTER_SECRET',
  'TENCENT_COS_SECRET_ID',
  'TENCENT_COS_SECRET_KEY',
  'TENCENT_COS_BUCKET',
  'TENCENT_COS_REGION',
];

describe('Provider 工厂与 REQUIRE_REAL_PROVIDERS', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('没设开关、配置不全：三条通道都回落 Mock（development 联调期的口径）', () => {
    expect(smsProviderFactory()).toBeInstanceOf(ConsoleSmsProvider);
    expect(pushProviderFactory()).toBeInstanceOf(ConsolePushProvider);
    expect(storageProviderFactory()).toBeInstanceOf(MockStorageProvider);
  });

  it('REQUIRE_REAL_PROVIDERS=1 且配置不全：拒绝启动，错误信息点名是哪条通道、缺什么', () => {
    process.env.REQUIRE_REAL_PROVIDERS = '1';
    expect(() => smsProviderFactory()).toThrow(/短信通道.*TENCENT_SMS_\*/);
    expect(() => pushProviderFactory()).toThrow(/推送通道.*JPUSH_APP_KEY/);
    expect(() => storageProviderFactory()).toThrow(/对象存储.*TENCENT_COS_\*/);
  });

  it('REQUIRE_REAL_PROVIDERS=1 但短信只漏 SOS 模板这一项：同样拒绝（六项全要，漏一项整条通道就是 Mock）', () => {
    process.env.REQUIRE_REAL_PROVIDERS = '1';
    process.env.TENCENT_SMS_SECRET_ID = 'id';
    process.env.TENCENT_SMS_SECRET_KEY = 'key';
    process.env.TENCENT_SMS_SDK_APP_ID = '1400000000';
    process.env.TENCENT_SMS_SIGN_NAME = '深圳零一唯创';
    process.env.TENCENT_SMS_TEMPLATE_VERIFY_CODE = '2739084';
    expect(() => smsProviderFactory()).toThrow(/短信通道/);
  });

  it('开关写成 true / YES 同样生效（原来只认 "1"，写成 true 静默回落 Mock——生产把假发送记成已通知）；认不出的值拒绝启动', () => {
    for (const v of ['true', 'YES', ' on ']) {
      process.env.REQUIRE_REAL_PROVIDERS = v;
      expect(() => smsProviderFactory()).toThrow('REQUIRE_REAL_PROVIDERS');
    }
    process.env.REQUIRE_REAL_PROVIDERS = 'ture';
    expect(() => smsProviderFactory()).toThrow('不是开关值');
    for (const v of ['0', 'false', '']) {
      process.env.REQUIRE_REAL_PROVIDERS = v;
      expect(smsProviderFactory()).toBeInstanceOf(ConsoleSmsProvider);
    }
  });
});
