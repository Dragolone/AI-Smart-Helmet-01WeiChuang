// 极光 Provider（THIRD_PARTY.md §6）：请求体字段、鉴权头、错误必须 throw（否则 SOS 通知会误记成功）。
import {
  JPushError,
  JPushProvider,
  buildJPushBody,
  jpushConfigFromEnv,
} from './jpush.provider';

const config = {
  appKey: 'ak',
  masterSecret: 'ms',
  apnsProduction: false,
  apiUrl: 'https://api.jpush.cn/v3/push',
  timeoutMs: 200,
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('jpushConfigFromEnv', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('AppKey 或 Master Secret 缺一返回 null（回落 Console Mock）', () => {
    delete process.env.JPUSH_APP_KEY;
    delete process.env.JPUSH_MASTER_SECRET;
    expect(jpushConfigFromEnv()).toBeNull();
    process.env.JPUSH_APP_KEY = 'ak';
    expect(jpushConfigFromEnv()).toBeNull();
  });

  it('齐全时读取；apns_production 默认 false，超时默认 10s', () => {
    process.env.JPUSH_APP_KEY = 'ak';
    process.env.JPUSH_MASTER_SECRET = 'ms';
    delete process.env.JPUSH_APNS_PRODUCTION;
    delete process.env.PUSH_SEND_TIMEOUT_MS;
    expect(jpushConfigFromEnv()).toEqual({
      appKey: 'ak',
      masterSecret: 'ms',
      apnsProduction: false,
      apiUrl: 'https://api.jpush.cn/v3/push',
      timeoutMs: 10_000,
    });
    process.env.JPUSH_APNS_PRODUCTION = 'true';
    process.env.PUSH_SEND_TIMEOUT_MS = '3000';
    expect(jpushConfigFromEnv()).toMatchObject({
      apnsProduction: true,
      timeoutMs: 3000,
    });
  });
});

describe('buildJPushBody', () => {
  it('按 alias=userId 定向，双平台都带标题正文与 extras，离线保留一天', () => {
    expect(
      buildJPushBody('user_1', 'SOS 已通知', '正文', { sosId: 's1' }, true),
    ).toEqual({
      platform: 'all',
      audience: { alias: ['user_1'] },
      notification: {
        alert: '正文',
        android: {
          alert: '正文',
          title: 'SOS 已通知',
          extras: { sosId: 's1' },
        },
        ios: {
          alert: { title: 'SOS 已通知', body: '正文' },
          sound: 'default',
          badge: '+1',
          extras: { sosId: 's1' },
        },
      },
      options: { time_to_live: 86_400, apns_production: true },
    });
  });
});

describe('JPushProvider.send', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('成功：POST 到 v3/push，Basic 鉴权 = base64(appKey:masterSecret)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { sendno: '0', msg_id: '123' }));
    globalThis.fetch = fetchMock;
    await new JPushProvider(config).send('u1', 't', 'b', { k: 'v' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.jpush.cn/v3/push');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('ak:ms').toString('base64')}`,
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      audience: { alias: ['u1'] },
      options: { apns_production: false },
    });
  });

  it('极光返回 4xx（如 1011 该用户无设备）→ 抛 JPushError 带 code，绝不静默成功', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      jsonResponse(400, {
        error: { code: 1011, message: 'cannot find user by this audience' },
      }),
    );
    const p = new JPushProvider(config).send('u1', 't', 'b');
    await expect(p).rejects.toBeInstanceOf(JPushError);
    await expect(p).rejects.toMatchObject({ httpStatus: 400, code: 1011 });
  });

  it('响应体不是 JSON 也算失败并抛错', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    await expect(
      new JPushProvider(config).send('u1', 't', 'b'),
    ).rejects.toMatchObject({
      httpStatus: 502,
    });
  });

  it('2xx 但响应体不是 JSON：极光已受理，按成功处理（抛错会让上层重试成重复推送）', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(new Response('OK', { status: 200 }));
    await expect(
      new JPushProvider(config).send('u1', 't', 'b'),
    ).resolves.toBeUndefined();
  });

  it('超时：超过 timeoutMs 未返回 → 抛错，消息含 timeout', async () => {
    globalThis.fetch = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    ) as unknown as typeof fetch;
    await expect(
      new JPushProvider({ ...config, timeoutMs: 50 }).send('u1', 't', 'b'),
    ).rejects.toThrow(/timeout after 50ms/);
  });
});
