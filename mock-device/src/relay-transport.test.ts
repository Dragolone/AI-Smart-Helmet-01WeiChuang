// 中转传输的可测行为（不联网：stub 全局 fetch / WebSocket）：7 种事件范围过滤、批量上限、
// 提交体形状与鉴权头、401 → 刷新后重试、非 202 保留缓存。剧本与传输解耦（transport.ts）使这些可单测。
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { EventEnvelope, EventType } from '@helmet/shared';
import { buildEnvelope } from './envelope.ts';
import { createRelayTransport, type RelayConfig } from './relay-transport.ts';

interface Call {
  path: string;
  auth: string | null;
  body: unknown;
}

class FakeWebSocket {
  static urls: string[] = [];
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    FakeWebSocket.urls.push(url);
    FakeWebSocket.last = this;
  }
  close(): void {}
}

const calls: Call[] = [];
let relayResponses: Array<{ status: number; json: unknown }> = [];
let loginCount = 0;
let refreshCount = 0;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url).pathname;
  const headers = new Headers(init?.headers);
  calls.push({
    path,
    auth: headers.get('authorization'),
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  if (path === '/api/v1/auth/login') {
    loginCount += 1;
    return json(200, { accessToken: `access_${loginCount}`, refreshToken: `refresh_${loginCount}` });
  }
  if (path === '/api/v1/auth/refresh') {
    refreshCount += 1;
    return json(200, { accessToken: `access_r${refreshCount}`, refreshToken: `refresh_r${refreshCount}` });
  }
  if (path.endsWith('/relay-ack')) {
    return json(200, { commandId: path.split('/').at(-2), status: 'success' });
  }
  if (path === '/api/v1/ingest/app-relay') {
    const next = relayResponses.shift() ?? {
      status: 202,
      json: { accepted: (init?.body ? (JSON.parse(String(init.body)) as { envelopes: unknown[] }).envelopes.length : 0), duplicate: 0, invalid: 0 },
    };
    return json(next.status, next.json);
  }
  return json(404, { code: 'NOT_FOUND' });
};

const config = (over: Partial<RelayConfig> = {}): RelayConfig => ({
  apiBaseUrl: 'http://stub.local',
  deviceId: 'helmet_relay_test',
  phone: '13800000000',
  password: 'pw',
  flushIntervalMs: 60_000,
  maxBatch: 2,
  offlineCycle: 0,
  sendOutOfScope: false,
  cmdResult: 'success',
  log: () => undefined,
  ...over,
});

const env = <T extends EventType>(type: T, payload: Parameters<typeof buildEnvelope<T>>[3]) =>
  buildEnvelope('helmet_relay_test', '1.0.0', type, payload) as EventEnvelope<EventType>;

const location = { latitude: 22.5, longitude: 113.9, coordinateSystem: 'wgs84' as const, accuracy: 5, speed: 3, heading: 90 };

describe('relay-transport', () => {
  const realFetch = globalThis.fetch;
  const realWs = globalThis.WebSocket;

  beforeEach(() => {
    calls.length = 0;
    relayResponses = [];
    loginCount = 0;
    refreshCount = 0;
    FakeWebSocket.urls = [];
    FakeWebSocket.last = null;
    globalThis.fetch = fakeFetch as typeof fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWs;
  });

  it('start：先登录再连 WS（带 token）；范围外事件本地过滤；stop 时按 maxBatch 提交并带 Bearer', async () => {
    const t = createRelayTransport(config());
    await new Promise<void>((resolve) => t.start(resolve));
    assert.equal(loginCount, 1);
    assert.equal(FakeWebSocket.urls.length, 1);
    assert.ok(FakeWebSocket.urls[0].startsWith('ws://stub.local/ws?token=access_1'));

    t.send('event', env('possible_fall', { confidence: 0.9, algorithmVersion: 'v1', location }));
    t.send('event', env('video_ready', { videoId: 'v', relatedEventId: 'e', duration: 1, sizeBytes: 1, storageKey: 'k' }));
    t.send('location', env('location_update', location));
    t.send('location', env('location_update', location));
    await new Promise<void>((resolve) => t.stop(resolve));

    const relay = calls.filter((c) => c.path === '/api/v1/ingest/app-relay');
    assert.equal(relay.length, 1, 'stop 只做一次最后提交');
    assert.equal(relay[0].auth, 'Bearer access_1');
    const body = relay[0].body as { deviceId: string; envelopes: EventEnvelope<EventType>[] };
    assert.equal(body.deviceId, 'helmet_relay_test');
    assert.equal(body.envelopes.length, 2, '单批不超过 maxBatch');
    assert.deepEqual(
      body.envelopes.map((e) => e.eventType),
      ['possible_fall', 'location_update'],
      'video_ready 不在蓝牙版第一期 7 种范围内，本地跳过',
    );
  });

  it('sendOutOfScope=true 时范围外事件照发（用于验证服务端留档告警）', async () => {
    const t = createRelayTransport(config({ sendOutOfScope: true, maxBatch: 10 }));
    await new Promise<void>((resolve) => t.start(resolve));
    t.send('event', env('video_ready', { videoId: 'v', relatedEventId: 'e', duration: 1, sizeBytes: 1, storageKey: 'k' }));
    await new Promise<void>((resolve) => t.stop(resolve));
    const relay = calls.filter((c) => c.path === '/api/v1/ingest/app-relay');
    assert.equal((relay[0].body as { envelopes: unknown[] }).envelopes.length, 1);
  });

  it('提交遇 401 → 刷新 token 后用新 token 重试同一批；非 202 时缓存保留', async () => {
    relayResponses = [
      { status: 401, json: { code: 'UNAUTHORIZED' } },
      { status: 404, json: { code: 'DEVICE_NOT_FOUND' } },
    ];
    const t = createRelayTransport(config({ maxBatch: 10 }));
    await new Promise<void>((resolve) => t.start(resolve));
    t.send('event', env('manual_sos', { location }));
    await new Promise<void>((resolve) => t.stop(resolve));

    const relay = calls.filter((c) => c.path === '/api/v1/ingest/app-relay');
    assert.equal(relay.length, 2);
    assert.equal(relay[0].auth, 'Bearer access_1');
    assert.equal(refreshCount, 1);
    assert.equal(relay[1].auth, 'Bearer access_r1', '重试用刷新后的 token');
    assert.deepEqual(relay[1].body, relay[0].body, '重试的是同一批（原 eventId 补传）');
  });

  it('WS 下行 set_config：先回 delivered，再按 v0.6 清单执行——越界回 executed failed + ERR_PARAM_VALUE:<key>，合法回 success', async () => {
    const t = createRelayTransport(config());
    await new Promise<void>((resolve) => t.start(resolve));
    const ws = FakeWebSocket.last;
    assert.ok(ws?.onmessage, 'WS 已挂上 onmessage');

    const push = (commandId: string, params: Record<string, unknown>) =>
      ws!.onmessage!({
        data: JSON.stringify({
          type: 'device_command',
          sentAt: new Date().toISOString(),
          data: { commandId, deviceId: 'helmet_relay_test', type: 'set_config', params, issuedAt: new Date().toISOString() },
        }),
      });
    push('cmd_bad', { volume: 101 });
    push('cmd_ok', { volume: 70, light: 2 });
    push('cmd_bad', { volume: 101 }); // 连接补推的重复命令：幂等跳过
    await new Promise((r) => setTimeout(r, 650));
    await new Promise<void>((resolve) => t.stop(resolve));

    const acks = calls.filter((c) => c.path.endsWith('/relay-ack')).map((c) => ({ id: c.path.split('/').at(-2), body: c.body as Record<string, unknown> }));
    assert.deepEqual(
      acks.map((a) => [a.id, a.body.stage, a.body.result ?? null, a.body.errorCode ?? null]),
      [
        ['cmd_bad', 'delivered', null, null],
        ['cmd_ok', 'delivered', null, null],
        ['cmd_bad', 'executed', 'failed', 'ERR_PARAM_VALUE:volume'],
        ['cmd_ok', 'executed', 'success', null],
      ],
      '重复命令不再回执；越界由"头盔"拒绝而不是静默成功',
    );
    assert.equal(acks[0].body.stage, 'delivered');
  });
});
