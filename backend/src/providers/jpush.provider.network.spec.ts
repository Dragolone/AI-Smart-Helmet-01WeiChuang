// 极光推送的网络错误分支：非超时的网络错误、抛出非 Error 值、4xx 错误体没有 message。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

describe('JPushProvider.send：只回了响应头、响应体一直不来（10-17 评审）', () => {
  // 真起一个本地服务：先发 500 响应头，再也不发响应体。定时器原来在拿到响应头时就清了，
  // 读响应体没有期限，send 会挂到 undici 默认的 300 s——「倒计时已开始」推送错过 5 s / 20 s 的重试
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.write('{"error":');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/v3/push`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('超时同样中断读响应体：按时失败（JPushError），不挂住', async () => {
    const started = Date.now();
    await expect(
      new JPushProvider({ ...config, apiUrl: url, timeoutMs: 200 }).send(
        'u1',
        't',
        'b',
      ),
    ).rejects.toBeInstanceOf(JPushError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
