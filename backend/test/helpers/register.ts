// e2e 公共辅助：注册必须带短信验证码（API.md §2），这里把「取码 → 注册」封装成一步。
// 验证码从 SMS Provider 的发送记录里取：默认 ConsoleSmsProvider 会被 jest mock 包一层；
// 用例若自行 overrideProvider(SMS_PROVIDER)，只要 send 是 jest.fn 同样可取。
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  SMS_PROVIDER,
  type SmsMessage,
} from '../../src/providers/sms.provider';

type SendMock = jest.Mock<Promise<void>, [string, SmsMessage]>;

/** 从 provider 的 send 调用记录里找该号码最近一次验证码 */
export const lastCodeFor = (app: INestApplication, phone: string): string => {
  const provider = app.get<{
    send: SendMock | ((p: string, m: SmsMessage) => Promise<void>);
  }>(SMS_PROVIDER);
  const send = provider.send as SendMock;
  if (!send.mock) {
    throw new Error(
      'SMS provider.send 不是 jest.fn：请在 createTestingModule 后用 spyOnSms(app) 或 overrideProvider(SMS_PROVIDER, { send: jest.fn() })',
    );
  }
  for (let i = send.mock.calls.length - 1; i >= 0; i -= 1) {
    const [to, message] = send.mock.calls[i];
    if (to === phone && message.template === 'verify_code') {
      return message.params.code;
    }
  }
  throw new Error(`未找到 ${phone} 的验证码发送记录`);
};

/** 把当前 SMS provider 的 send 包成 jest.fn（保留原实现，Console 仍会打印） */
export const spyOnSms = (app: INestApplication): SendMock => {
  const provider = app.get<{
    send: (p: string, m: SmsMessage) => Promise<void>;
  }>(SMS_PROVIDER);
  if ((provider.send as SendMock).mock) return provider.send as SendMock;
  const original = provider.send.bind(provider);
  const spy = jest.fn(original) as SendMock;
  provider.send = spy;
  return spy;
};

export interface RegisterInput {
  phone: string;
  password: string;
  nickname?: string;
}

/** 取验证码并注册，断言 201，返回响应（body 含 user / accessToken / refreshToken） */
export const registerUser = async (
  app: INestApplication,
  http: Parameters<typeof request>[0],
  input: RegisterInput,
): Promise<request.Response> => {
  spyOnSms(app);
  await request(http)
    .post('/api/v1/auth/sms-code')
    .send({ phone: input.phone, purpose: 'register' })
    .expect(204);
  const code = lastCodeFor(app, input.phone);
  return request(http)
    .post('/api/v1/auth/register')
    .send({ ...input, code })
    .expect(201);
};
