// Console / Mock 实现（Mock Data Strategy：第三方账号审核期不阻塞开发）：短信打印脱敏号码 + 渲染文案，存储签占位 URL。
import { Logger } from '@nestjs/common';
import { ConsoleSmsProvider, maskPhone, renderSmsText } from './sms.provider';
import { MockStorageProvider } from './storage.provider';

describe('Mock / Console Provider', () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renderSmsText：验证码模板文案与腾讯云审核的一致', () => {
    expect(
      renderSmsText({
        template: 'verify_code',
        params: { code: '123456', ttlMinutes: 5 },
      }),
    ).toBe('您的验证码为123456，5分钟内有效，请勿泄露给他人。');
  });

  it('maskPhone：≥7 位留前 3 后 4；更短的只留首位', () => {
    expect(maskPhone('13800001111')).toBe('138****1111');
    expect(maskPhone('+85291234567')).toBe('+85****4567');
    expect(maskPhone('123456')).toBe('1****');
    expect(maskPhone('')).toBe('****');
  });

  it('ConsoleSmsProvider：打印脱敏号码 + 模板名 + 渲染后的文案（验证码明文供本地凭日志注册），不抛', async () => {
    await expect(
      new ConsoleSmsProvider().send('13800001111', {
        template: 'verify_code',
        params: { code: '654321', ttlMinutes: 5 },
      }),
    ).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      '[MOCK SMS] → 138****1111 [verify_code] 您的验证码为654321，5分钟内有效，请勿泄露给他人。',
    );
  });

  it('MockStorageProvider：签出不可访问的占位 URL，带到期时间戳', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T00:00:00Z') });
    const url = await new MockStorageProvider().getSignedUrl(
      'media/a.mp4',
      600,
    );
    expect(url).toBe(
      `https://mock-storage.local/media/a.mp4?expires=${Date.parse('2026-10-16T00:10:00Z') / 1000}&signature=mock`,
    );
    expect(logSpy).toHaveBeenCalledWith(
      '[MOCK STORAGE] 签发预签名 URL：media/a.mp4（600s）',
    );
  });
});
