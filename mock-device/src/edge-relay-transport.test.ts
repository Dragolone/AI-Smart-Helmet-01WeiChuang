// 中转传输的边界行为（relay-transport.test.ts 覆盖主路径，这里补异常路径）：
// 缓存排空顺序与上限、模拟断网补传、鉴权逐级回落（refresh → 重登 → 放弃本轮）、
// 下行命令的三态与畸形消息、WS 断线重连。全程 stub fetch / WebSocket + 假定时器，不联网不等真实时间。
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { EventEnvelope, EventType } from '@helmet/shared';
import { buildEnvelope } from './envelope.ts';
import { createRelayTransport, type RelayConfig } from './relay-transport.ts';
import type { Transport } from './transport.ts';

const DEVICE = 'helmet_edge';

interface Call {
  path: string;
  auth: string | null;
  body: unknown;
}
type Handler = (call: Call) => Response;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close(): void {}
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls: Call[] = [];
const logs: string[] = [];
const unhandled: unknown[] = [];
let loginCount = 0;
let refreshCount = 0;
// 每个入口一个可替换的处理函数；用例只改自己关心的那一个
let onLogin: Handler;
let onRefresh: Handler;
let onRelay: Handler;
let onAck: Handler;

const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url).pathname;
  const call: Call = {
    path,
    auth: new Headers(init?.headers).get('authorization'),
    body: init?.body ? JSON.parse(String(init.body)) : null,
  };
  calls.push(call);
  if (path === '/api/v1/auth/login') return onLogin(call);
  if (path === '/api/v1/auth/refresh') return onRefresh(call);
  if (path === '/api/v1/ingest/app-relay') return onRelay(call);
  if (path.endsWith('/relay-ack')) return onAck(call);
  return json(404, { code: 'NOT_FOUND' });
};

const config = (over: Partial<RelayConfig> = {}): RelayConfig => ({
  apiBaseUrl: 'http://stub.local',
  deviceId: DEVICE,
  phone: '13800000000',
  password: 'pw',
  flushIntervalMs: 1000,
  maxBatch: 2,
  offlineCycle: 0,
  sendOutOfScope: false,
  cmdResult: 'success',
  log: (msg) => logs.push(msg),
  ...over,
});

const location = { latitude: 22.5, longitude: 113.9, coordinateSystem: 'wgs84' as const, accuracy: 5, speed: 3, heading: 90 };
const locationEvent = (): EventEnvelope<EventType> =>
  buildEnvelope(DEVICE, '1.0.0', 'location_update', location) as EventEnvelope<EventType>;

// 定时器是假的，但 fetch 链路是真 Promise：每次拨动时钟后让出几轮事件循环把异步链跑完
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};
const tick = async (ms: number): Promise<void> => {
  mock.timers.tick(ms);
  await settle();
};

const start = async (over: Partial<RelayConfig> = {}): Promise<Transport> => {
  const t = createRelayTransport(config(over));
  await new Promise<void>((resolve) => t.start(resolve));
  return t;
};
const stop = (t: Transport): Promise<void> => new Promise<void>((resolve) => t.stop(resolve));

const relayCalls = (): Call[] => calls.filter((c) => c.path === '/api/v1/ingest/app-relay');
const relayIds = (c: Call): string[] =>
  (c.body as { envelopes: EventEnvelope<EventType>[] }).envelopes.map((e) => e.eventId);
const ackCalls = (): Array<{ id: string | undefined; auth: string | null; body: Record<string, unknown> }> =>
  calls
    .filter((c) => c.path.endsWith('/relay-ack'))
    .map((c) => ({ id: c.path.split('/').at(-2), auth: c.auth, body: c.body as Record<string, unknown> }));

const pushCommand = (ws: FakeWebSocket, data: Record<string, unknown>): void =>
  ws.onmessage?.({
    data: JSON.stringify({ type: 'device_command', sentAt: new Date().toISOString(), data }),
  });
const command = (commandId: string, params: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  commandId,
  deviceId: DEVICE,
  type: 'set_config',
  params,
  issuedAt: new Date().toISOString(),
  ...over,
});

const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

describe('relay-transport 边界', () => {
  const realFetch = globalThis.fetch;
  const realWs = globalThis.WebSocket;

  beforeEach(() => {
    calls.length = 0;
    logs.length = 0;
    unhandled.length = 0;
    loginCount = 0;
    refreshCount = 0;
    FakeWebSocket.instances = [];
    onLogin = () => {
      loginCount += 1;
      return json(200, { accessToken: `access_${loginCount}`, refreshToken: `refresh_${loginCount}` });
    };
    onRefresh = () => {
      refreshCount += 1;
      return json(200, { accessToken: `access_r${refreshCount}`, refreshToken: `refresh_r${refreshCount}` });
    };
    onRelay = (c) =>
      json(202, { accepted: (c.body as { envelopes: unknown[] }).envelopes.length, duplicate: 0, invalid: 0 });
    onAck = (c) => json(200, { commandId: c.path.split('/').at(-2), status: 'success' });
    globalThis.fetch = fakeFetch as typeof fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    mock.timers.reset();
    mock.restoreAll();
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWs;
  });

  describe('缓存与批量', () => {
    it('多轮 flush 按入队顺序分批排空：每条恰好提交一次，队列空了不再发请求', async () => {
      const t = await start({ maxBatch: 2 });
      const events = Array.from({ length: 5 }, locationEvent);
      events.forEach((e) => t.send('location', e));
      await tick(1000);
      await tick(1000);
      await tick(1000);
      await tick(1000); // 第 4 轮：队列已空
      assert.deepEqual(relayCalls().map((c) => relayIds(c).length), [2, 2, 1]);
      assert.deepEqual(relayCalls().flatMap(relayIds), events.map((e) => e.eventId));
      await stop(t);
      assert.equal(relayCalls().length, 3, 'stop 时队列为空，不补发空批');
    });

    it('offlineCycle=2：每第 2 次 flush 不发请求、缓存原样保留，下一轮按原 eventId 补传且不重复', async () => {
      const t = await start({ maxBatch: 1, offlineCycle: 2 });
      const events = Array.from({ length: 3 }, locationEvent);
      events.forEach((e) => t.send('location', e));
      for (let i = 0; i < 5; i += 1) await tick(1000);
      // 5 轮：发 a / 断网 / 发 b / 断网 / 发 c
      assert.deepEqual(relayCalls().flatMap(relayIds), events.map((e) => e.eventId));
      assert.equal(logs.filter((l) => l.includes('模拟断网')).length, 2);
      await stop(t);
    });

    it('缓存上限 1000 条：第 1001 条入队时丢最旧的一条并告警，其余顺序不变', async () => {
      const t = await start({ maxBatch: 100 });
      const events = Array.from({ length: 1001 }, locationEvent);
      events.forEach((e) => t.send('location', e));
      assert.equal(logs.filter((l) => l.includes('离线缓存已满')).length, 1);
      await stop(t);
      const ids = relayIds(relayCalls()[0]);
      assert.equal(ids.length, 100);
      assert.equal(ids[0], events[1].eventId, '最旧的 events[0] 已被丢弃');
      assert.ok(logs.some((l) => l.includes('退出时仍有 900 条未提交')), '剩余条数如实告警，不静默丢');
    });

    it('网关返回非 JSON 的 502 → 缓存保留，下一轮整批重试（同一批 eventId）', async () => {
      let n = 0;
      const ok = onRelay;
      onRelay = (c) => {
        n += 1;
        return n === 1 ? new Response('<html>Bad Gateway</html>', { status: 502 }) : ok(c);
      };
      const t = await start({ maxBatch: 10 });
      t.send('location', locationEvent());
      t.send('location', locationEvent());
      await tick(1000);
      await tick(1000);
      assert.equal(relayCalls().length, 2);
      assert.deepEqual(relayIds(relayCalls()[1]), relayIds(relayCalls()[0]));
      await tick(1000);
      assert.equal(relayCalls().length, 2, '第二轮成功后队列已空');
      await stop(t);
    });

    it('fetch 抛网络错 → 本轮记日志并保留缓存；flushing 标志复位，下一轮照常重试', async () => {
      let n = 0;
      const ok = onRelay;
      onRelay = (c) => {
        n += 1;
        if (n === 1) throw new TypeError('fetch failed');
        return ok(c);
      };
      const t = await start({ maxBatch: 10 });
      t.send('location', locationEvent());
      await tick(1000);
      assert.ok(logs.some((l) => l.includes('中转异常') && l.includes('fetch failed')));
      await tick(1000);
      assert.equal(relayCalls().length, 2);
      assert.deepEqual(relayIds(relayCalls()[1]), relayIds(relayCalls()[0]));
      await stop(t);
      assert.deepEqual(unhandled, []);
    });

    it('202 之外的 2xx（如 200）不算提交成功：Contract 只认 202，缓存保留', async () => {
      onRelay = () => json(200, { accepted: 1, duplicate: 0, invalid: 0 });
      const t = await start({ maxBatch: 10 });
      t.send('location', locationEvent());
      await tick(1000);
      await tick(1000);
      assert.equal(relayCalls().length, 2, '第二轮仍在重试同一条');
      await stop(t);
    });
  });

  describe('鉴权回落', () => {
    it('提交 401 且 refresh 也被拒 → 回落到重新登录，用新登录的 token 重试同一批', async () => {
      let n = 0;
      const ok = onRelay;
      onRelay = (c) => {
        n += 1;
        return n === 1 ? json(401, { code: 'UNAUTHORIZED' }) : ok(c);
      };
      onRefresh = () => json(401, { code: 'UNAUTHORIZED' });
      const t = await start({ maxBatch: 10 });
      t.send('event', buildEnvelope(DEVICE, '1.0.0', 'manual_sos', {}) as EventEnvelope<EventType>);
      await tick(1000);
      assert.equal(loginCount, 2);
      assert.deepEqual(relayCalls().map((c) => c.auth), ['Bearer access_1', 'Bearer access_2']);
      assert.deepEqual(relayIds(relayCalls()[1]), relayIds(relayCalls()[0]));
      await stop(t);
    });

    it('refresh 请求本身抛网络错 → 同样回落到重新登录', async () => {
      let n = 0;
      const ok = onRelay;
      onRelay = (c) => {
        n += 1;
        return n === 1 ? json(401, { code: 'UNAUTHORIZED' }) : ok(c);
      };
      onRefresh = () => {
        throw new TypeError('fetch failed');
      };
      const t = await start({ maxBatch: 10 });
      t.send('location', locationEvent());
      await tick(1000);
      assert.equal(loginCount, 2);
      assert.equal(relayCalls().at(-1)?.auth, 'Bearer access_2');
      await stop(t);
    });

    it('refresh 与重登都失败 → 放弃本轮、缓存保留、进程不崩；鉴权恢复后下一轮补传', async () => {
      let loginBroken = true;
      const okLogin = onLogin;
      const t = await start({ maxBatch: 10 });
      onRelay = (c) =>
        c.auth === 'Bearer access_1'
          ? json(401, { code: 'UNAUTHORIZED' })
          : json(202, { accepted: 1, duplicate: 0, invalid: 0 });
      onRefresh = () => json(401, { code: 'UNAUTHORIZED' });
      onLogin = (c) => (loginBroken ? json(429, { code: 'RATE_LIMITED' }) : okLogin(c));
      const e = locationEvent();
      t.send('location', e);
      await tick(1000);
      assert.ok(logs.some((l) => l.includes('中转异常') && l.includes('登录失败 429')));
      loginBroken = false;
      await tick(1000);
      assert.deepEqual(relayIds(relayCalls().at(-1) as Call), [e.eventId]);
      assert.equal(relayCalls().at(-1)?.auth, 'Bearer access_2');
      await tick(1000);
      assert.equal(relayCalls().filter((c) => c.auth === 'Bearer access_2').length, 1, '补传成功后不再重发');
      await stop(t);
      assert.deepEqual(unhandled, []);
    });

    it('启动时登录失败 → 退出码 1，不启动剧本、不连 WS、不起 flush 定时器', async () => {
      onLogin = () => json(401, { code: 'UNAUTHORIZED', message: '手机号或密码错误' });
      const exit = mock.method(process, 'exit', () => undefined as never);
      const onReady = mock.fn();
      const t = createRelayTransport(config());
      t.start(onReady);
      await settle();
      assert.deepEqual(exit.mock.calls.map((c) => c.arguments), [[1]]);
      assert.equal(onReady.mock.callCount(), 0);
      assert.equal(FakeWebSocket.instances.length, 0);
      assert.ok(logs.some((l) => l.includes('登录失败 401') && l.includes('RELAY_PHONE')));
      t.send('location', locationEvent());
      await tick(5000);
      assert.equal(relayCalls().length, 0);
    });

    it('API 地址带多余的尾斜杠 / https：请求路径不出现 `//`，WS 换成 wss，token 做 URL 编码', async () => {
      onLogin = () => json(200, { accessToken: 'a+b/c=&d', refreshToken: 'r' });
      const t = await start({ apiBaseUrl: 'https://api.stub.local///' });
      assert.equal(calls[0].path, '/api/v1/auth/login');
      assert.equal(FakeWebSocket.instances[0].url, 'wss://api.stub.local/ws?token=a%2Bb%2Fc%3D%26d');
      await stop(t);
    });
  });

  describe('下行命令', () => {
    it('同账号下其他设备的命令：本"头盔"不认，一条回执都不发', async () => {
      const t = await start();
      pushCommand(FakeWebSocket.instances[0], command('cmd_other', { volume: 50 }, { deviceId: 'helmet_someone_else' }));
      await tick(500);
      assert.deepEqual(ackCalls(), []);
      await stop(t);
    });

    it('cmdResult=silent：只回 delivered，永不回 executed（留给服务端 30s 超时判 offline）', async () => {
      const t = await start({ cmdResult: 'silent' });
      pushCommand(FakeWebSocket.instances[0], command('cmd_silent', { volume: 50 }));
      await tick(500);
      await tick(60_000);
      assert.deepEqual(ackCalls().map((a) => [a.id, a.body.stage]), [['cmd_silent', 'delivered']]);
      await stop(t);
    });

    it('cmdResult=failed：参数合法也强制回 failed + MOCK_REJECTED；executedAt 为带 Z 的 ISO 8601', async () => {
      const t = await start({ cmdResult: 'failed' });
      pushCommand(FakeWebSocket.instances[0], command('cmd_rej', { volume: 50 }));
      await tick(499);
      assert.equal(ackCalls().length, 1, '执行耗时 500ms 内只有 delivered');
      await tick(1);
      const executed = ackCalls()[1];
      assert.equal(executed.body.stage, 'executed');
      assert.equal(executed.body.result, 'failed');
      assert.equal(executed.body.errorCode, 'MOCK_REJECTED');
      assert.match(String(executed.body.executedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      await stop(t);
    });

    it('set_config 的 params 为空对象 / null / 数组 / 缺失 → 回 failed，绝不把没执行的命令报成 success', async () => {
      const t = await start();
      const ws = FakeWebSocket.instances[0];
      pushCommand(ws, command('cmd_empty', {}));
      pushCommand(ws, command('cmd_null', null));
      pushCommand(ws, command('cmd_array', [{ volume: 50 }]));
      const missing = command('cmd_missing', undefined);
      delete missing.params;
      pushCommand(ws, missing);
      await tick(500);
      const executed = ackCalls().filter((a) => a.body.stage === 'executed');
      assert.deepEqual(
        executed.map((a) => [a.id, a.body.result, a.body.errorCode]),
        [
          ['cmd_empty', 'failed', 'EMPTY_PARAMS'],
          ['cmd_null', 'failed', 'ERR_LENGTH'],
          ['cmd_array', 'failed', 'ERR_LENGTH'],
          ['cmd_missing', 'failed', 'ERR_LENGTH'],
        ],
      );
      await stop(t);
    });

    it('畸形 WS 消息（非 JSON / JSON null / 其他 type / 缺 data）一律忽略：不回执、不抛异常', async () => {
      const t = await start();
      const ws = FakeWebSocket.instances[0];
      for (const data of ['not json', 'null', '42', '{"type":"sos_update","data":{}}', '{"type":"device_command"}', '']) {
        assert.doesNotThrow(() => ws.onmessage?.({ data }), data);
      }
      await tick(500);
      assert.deepEqual(ackCalls(), []);
      // 畸形消息之后通道仍可用
      pushCommand(ws, command('cmd_after', { volume: 50 }));
      await tick(500);
      assert.deepEqual(ackCalls().map((a) => a.body.stage), ['delivered', 'executed']);
      await stop(t);
      assert.deepEqual(unhandled, []);
    });

    it('relay-ack 遇 401 → 刷新 token 后重发同一条回执', async () => {
      const ok = onAck;
      onAck = (c) => (c.auth === 'Bearer access_1' ? json(401, { code: 'UNAUTHORIZED' }) : ok(c));
      const t = await start({ cmdResult: 'silent' });
      pushCommand(FakeWebSocket.instances[0], command('cmd_401', { volume: 50 }));
      await settle();
      assert.equal(refreshCount, 1);
      assert.deepEqual(
        ackCalls().map((a) => [a.auth, a.body.stage]),
        [
          ['Bearer access_1', 'delivered'],
          ['Bearer access_r1', 'delivered'],
        ],
      );
      await stop(t);
    });

    it('relay-ack 请求抛网络错（后端重启瞬间）→ 记日志，不留未处理的 rejection 把常驻 Mock 进程打崩', async () => {
      onAck = () => {
        throw new TypeError('fetch failed');
      };
      const t = await start();
      pushCommand(FakeWebSocket.instances[0], command('cmd_net', { volume: 50 }));
      await tick(500);
      assert.deepEqual(unhandled, []);
      assert.equal(ackCalls().length, 2, 'delivered 失败不影响后续 executed 照常尝试');
      assert.equal(logs.filter((l) => l.includes('relay-ack 异常') && l.includes('fetch failed')).length, 2);
      await stop(t);
    });
  });

  describe('WS 断线重连', () => {
    it('普通断开（1006）：不刷新 token，固定 5s 后用原 token 重连', async () => {
      const t = await start();
      FakeWebSocket.instances[0].onclose?.({ code: 1006 });
      await settle(); // 重连定时器挂在 Promise 链后面，先让它排上
      await tick(4999);
      assert.equal(FakeWebSocket.instances.length, 1);
      await tick(1);
      assert.equal(FakeWebSocket.instances.length, 2);
      assert.equal(refreshCount, 0);
      assert.ok(FakeWebSocket.instances[1].url.endsWith('token=access_1'));
      await stop(t);
    });

    it('4401（token 失效）：先刷新，5s 后带新 token 重连', async () => {
      const t = await start();
      FakeWebSocket.instances[0].onclose?.({ code: 4401 });
      await settle();
      assert.equal(refreshCount, 1);
      await tick(5000);
      assert.equal(FakeWebSocket.instances.length, 2);
      assert.ok(FakeWebSocket.instances[1].url.endsWith('token=access_r1'));
      await stop(t);
    });

    it('4401 但 refresh 与重登都失败：不崩，仍按 5s 退避重连（下次 4401 再试）', async () => {
      const t = await start();
      onRefresh = () => json(401, { code: 'UNAUTHORIZED' });
      onLogin = () => json(429, { code: 'RATE_LIMITED' });
      FakeWebSocket.instances[0].onclose?.({ code: 4401 });
      await settle();
      await tick(5000);
      assert.deepEqual(unhandled, []);
      assert.ok(logs.some((l) => l.includes('重新鉴权失败') && l.includes('登录失败 429')));
      assert.equal(FakeWebSocket.instances.length, 2);
      await stop(t);
    });

    it('stop 之后的断开事件不再重连', async () => {
      const t = await start();
      await stop(t);
      FakeWebSocket.instances[0].onclose?.({ code: 1000 });
      await tick(10_000);
      assert.equal(FakeWebSocket.instances.length, 1);
    });
  });
});
