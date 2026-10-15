// Console 推送 Mock：打印代替真发；data / options 有才打印，没有不出现 undefined。
import { Logger } from '@nestjs/common';
import { ConsolePushProvider } from './push.provider';

describe('ConsolePushProvider', () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('只有标题正文', async () => {
    await expect(
      new ConsolePushProvider().send('u1', '标题', '正文'),
    ).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('[MOCK PUSH] → user:u1: 标题 | 正文');
  });

  it('带 data 与 options：各自 JSON 打印', async () => {
    await new ConsolePushProvider().send(
      'u1',
      't',
      'b',
      { sosId: 's1' },
      { category: 'sos', timeSensitive: true },
    );
    expect(logSpy).toHaveBeenCalledWith(
      '[MOCK PUSH] → user:u1: t | b | {"sosId":"s1"} | {"category":"sos","timeSensitive":true}',
    );
  });

  it('只有 options 没有 data', async () => {
    await new ConsolePushProvider().send('u1', 't', 'b', undefined, {
      timeSensitive: true,
    });
    expect(logSpy).toHaveBeenCalledWith(
      '[MOCK PUSH] → user:u1: t | b | {"timeSensitive":true}',
    );
  });
});
