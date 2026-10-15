// 腾讯云短信 Provider：SDK 整个换成假 Client，绝不真发；环境变量全部用测试值（先清掉真实 env 再设）。
// 钉住「失败必须 throw」——SOS 通知据此记 failed 并重试，吞掉就是「记成已通知、其实没发」。
import { Logger } from '@nestjs/common';

const SendSms = jest.fn();
const ClientCtor = jest.fn();

jest.mock('tencentcloud-sdk-nodejs-sms', () => ({
  sms: {
    v20210111: {
      Client: jest.fn().mockImplementation((opts: unknown) => {
        ClientCtor(opts);
        return { SendSms };
      }),
    },
  },
}));

import {
  TencentSmsProvider,
  tencentSmsConfigFromEnv,
  type TencentSmsConfig,
} from './tencent-sms.provider';

const SMS_KEYS = [
  'TENCENT_SMS_SECRET_ID',
  'TENCENT_SMS_SECRET_KEY',
  'TENCENT_SMS_SDK_APP_ID',
  'TENCENT_SMS_SIGN_NAME',
  'TENCENT_SMS_TEMPLATE_VERIFY_CODE',
  'TENCENT_SMS_TEMPLATE_SOS_ALERT',
  'TENCENT_SMS_REGION',
];

const FAKE_ENV: Record<string, string> = {
  TENCENT_SMS_SECRET_ID: 'AKID_FAKE',
  TENCENT_SMS_SECRET_KEY: 'KEY_FAKE',
  TENCENT_SMS_SDK_APP_ID: '1400000000',
  TENCENT_SMS_SIGN_NAME: '测试签名',
  TENCENT_SMS_TEMPLATE_VERIFY_CODE: '1000001',
  TENCENT_SMS_TEMPLATE_SOS_ALERT: '1000002',
};

const config: TencentSmsConfig = {
  secretId: 'AKID_FAKE',
  secretKey: 'KEY_FAKE',
  sdkAppId: '1400000000',
  signName: '测试签名',
  templateIds: { verify_code: '1000001', sos_alert: '1000002' },
};

const verifyMsg = {
  template: 'verify_code' as const,
  params: { code: '123456', ttlMinutes: 5 },
};
const sosMsg = {
  template: 'sos_alert' as const,
  params: {
    nickname: '张三',
    triggeredAt: '18:30',
    locationText: '22.5,114.0',
  },
};

describe('tencentSmsConfigFromEnv', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of SMS_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of SMS_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('六项齐全：返回配置，模板按名映射，地域缺省广州', () => {
    Object.assign(process.env, FAKE_ENV);
    expect(tencentSmsConfigFromEnv()).toEqual({
      ...config,
      region: 'ap-guangzhou',
    });
  });

  it('显式 TENCENT_SMS_REGION 优先；设成空串按未设处理', () => {
    Object.assign(process.env, FAKE_ENV, { TENCENT_SMS_REGION: 'ap-beijing' });
    expect(tencentSmsConfigFromEnv()?.region).toBe('ap-beijing');
    process.env.TENCENT_SMS_REGION = '';
    expect(tencentSmsConfigFromEnv()?.region).toBe('ap-guangzhou');
  });

  it.each(SMS_KEYS.filter((k) => k !== 'TENCENT_SMS_REGION'))(
    '缺 %s：返回 null（整条通道回落 Mock）',
    (missing) => {
      Object.assign(process.env, FAKE_ENV);
      delete process.env[missing];
      expect(tencentSmsConfigFromEnv()).toBeNull();
    },
  );

  it.each(SMS_KEYS.filter((k) => k !== 'TENCENT_SMS_REGION'))(
    '%s 设成空串：同样算缺项',
    (blank) => {
      Object.assign(process.env, FAKE_ENV, { [blank]: '' });
      expect(tencentSmsConfigFromEnv()).toBeNull();
    },
  );
});

describe('TencentSmsProvider', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    SendSms.mockReset();
    ClientCtor.mockReset();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('构造：凭证透传，地域缺省广州，SDK 超时压到 10 秒（默认 60 秒会拖死发码请求）', () => {
    new TencentSmsProvider(config);
    expect(ClientCtor).toHaveBeenCalledWith({
      credential: { secretId: 'AKID_FAKE', secretKey: 'KEY_FAKE' },
      region: 'ap-guangzhou',
      profile: {
        httpProfile: { endpoint: 'sms.tencentcloudapi.com', reqTimeout: 10 },
      },
    });
  });

  it('构造：配置里的地域优先', () => {
    new TencentSmsProvider({ ...config, region: 'ap-nanjing' });
    expect(ClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'ap-nanjing' }),
    );
  });

  it('验证码发送成功：国内号码补 +86，模板 ID 与参数按模板映射，日志里号码脱敏', async () => {
    SendSms.mockResolvedValue({
      SendStatusSet: [{ Code: 'Ok', Message: 'send success', SerialNo: 'S1' }],
    });
    await new TencentSmsProvider(config).send('13800001111', verifyMsg);
    expect(SendSms).toHaveBeenCalledWith({
      PhoneNumberSet: ['+8613800001111'],
      SmsSdkAppId: '1400000000',
      SignName: '测试签名',
      TemplateId: '1000001',
      TemplateParamSet: ['123456', '5'],
    });
    expect(logSpy).toHaveBeenCalledWith(
      '短信已发送 → 138****1111 [verify_code] serial=S1',
    );
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('13800001111');
  });

  it('SOS 通知：走 sos_alert 模板、不带变量；已带 + 前缀的号码原样发送', async () => {
    SendSms.mockResolvedValue({
      SendStatusSet: [{ Code: 'Ok', SerialNo: 'S2' }],
    });
    await new TencentSmsProvider(config).send('+85291234567', sosMsg);
    expect(SendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        PhoneNumberSet: ['+85291234567'],
        TemplateId: '1000002',
        TemplateParamSet: [],
      }),
    );
  });

  it('运营商拒发（Code 非 Ok）：throw，错误里带腾讯云错误码与说明', async () => {
    SendSms.mockResolvedValue({
      SendStatusSet: [
        {
          Code: 'LimitExceeded.PhoneNumberDailyLimit',
          Message: '单个手机号日下发条数超限',
        },
      ],
    });
    await expect(
      new TencentSmsProvider(config).send('13800001111', verifyMsg),
    ).rejects.toThrow(
      '腾讯云短信发送失败：LimitExceeded.PhoneNumberDailyLimit 单个手机号日下发条数超限',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('部分失败：每次只发一个号码，只看第一条状态——第一条失败就整体失败，哪怕后面混进 Ok', async () => {
    SendSms.mockResolvedValue({
      SendStatusSet: [
        { Code: 'FailedOperation.PhoneNumberInBlacklist' },
        { Code: 'Ok', SerialNo: 'S3' },
      ],
    });
    await expect(
      new TencentSmsProvider(config).send('13800001111', sosMsg),
    ).rejects.toThrow(
      /^腾讯云短信发送失败：FailedOperation\.PhoneNumberInBlacklist$/,
    );
  });

  it.each([
    ['SendStatusSet 为空数组', { SendStatusSet: [] }],
    ['没有 SendStatusSet', {}],
  ])('%s：按失败处理（NO_STATUS），不能当成发送成功', async (_n, res) => {
    SendSms.mockResolvedValue(res);
    await expect(
      new TencentSmsProvider(config).send('13800001111', sosMsg),
    ).rejects.toThrow(/^腾讯云短信发送失败：NO_STATUS$/);
  });

  it('网络错误 / SDK 超时：原样抛出', async () => {
    SendSms.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(
      new TencentSmsProvider(config).send('13800001111', sosMsg),
    ).rejects.toThrow('ETIMEDOUT');
  });
});
