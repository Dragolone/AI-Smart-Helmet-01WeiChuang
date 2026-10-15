// 极光推送的网络错误分支：非超时的网络错误、抛出非 Error 值、4xx 错误体没有 message。
import { JPushError, JPushProvider, type JPushConfig } from './jpush.provider';

const config: JPushConfig = {
  appKey: 'ak',
  masterSecret: 'ms',
  apnsProduction: false,
  apiUrl: 'https://jpush.invalid/v3/push',
  timeoutMs: 5_000,
};

describe('JPushProvider.send：网络错误', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('连接被拒（非超时）：JPushError，httpStatus=0，消息带原始错误', async () => {
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));
    const p = new JPushProvider(config).send('u1', 't', 'b');
    await expect(p).rejects.toBeInstanceOf(JPushError);
    await expect(p).rejects.toMatchObject({
      httpStatus: 0,
      code: undefined,
      message: '极光推送失败：HTTP 0 fetch failed: ECONNREFUSED',
    });
  });

  it('底层抛出的不是 Error（字符串）：照样包成 JPushError', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue('socket closed');
    await expect(
      new JPushProvider(config).send('u1', 't', 'b'),
    ).rejects.toMatchObject({
      httpStatus: 0,
      message: '极光推送失败：HTTP 0 socket closed',
    });
  });

  it('4xx 错误体是 JSON 但没有 error.message / code：仍抛错，消息不带 code=', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: {} }), { status: 401 }),
      );
    await expect(
      new JPushProvider(config).send('u1', 't', 'b'),
    ).rejects.toMatchObject({
      httpStatus: 401,
      code: undefined,
      message: '极光推送失败：HTTP 401',
    });
  });

  it('5xx 错误体 JSON 里完全没有 error 字段：同样失败', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(
      new JPushProvider(config).send('u1', 't', 'b'),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });
});
