// 审计 2026-09-13 §5：ble-relay-uplink 缺陷复现（断言写的是"应该的行为"，失败即证据）。
// 编号对应 docs/testing/2026-09-13/evidence/ble/result.json 的 findings。
// 注意：本文件预期失败，修复前不要调低断言（审计规则 9）。
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { EventEnvelope, EventType } from '@helmet/shared';

type Uplink = typeof import('../ble-relay-uplink');
type RelayApi = typeof import('@/api/relay');

const mockFs = {
  content: null as string | null,
  reset() {
    this.content = null;
  },
};

jest.mock('expo-file-system', () => ({
  Paths: { document: '/mock/documents' },
  File: class MockFile {
    get exists(): boolean {
      return mockFs.content !== null;
    }
    textSync(): string {
      return mockFs.content ?? '';
    }
    write(s: string): void {
      mockFs.content = s;
    }
  },
}));

jest.mock('@/api/relay', () => ({
  relayApi: { push: jest.fn(), ack: jest.fn() },
}));

let seq = 0;
const env = (eventType: EventType, deviceId: string): EventEnvelope<EventType> => ({
  schemaVersion: 1,
  eventId: `audit-def-${++seq}`,
  deviceId,
  eventType,
  timestamp: new Date().toISOString(),
  firmwareVersion: 'audit',
  payload: {},
});

function load(): { up: Uplink; push: Mock<RelayApi['relayApi']['push']> } {
  let up!: Uplink;
  let relay!: RelayApi;
  jest.isolateModules(() => {
    up = require('../ble-relay-uplink') as Uplink;
    relay = require('@/api/relay') as RelayApi;
  });
  const push = relay.relayApi.push as unknown as Mock<RelayApi['relayApi']['push']>;
  push.mockResolvedValue({ accepted: 1, duplicate: 0, invalid: 0 });
  return { up, push };
}

/** 模拟 client.ts 抛出的规范化错误（404 DEVICE_NOT_FOUND：设备已解绑/换账号） */
const notFound = Object.assign(new Error('device not bound to this user'), {
  code: 'DEVICE_NOT_FOUND',
  status: 404,
});

const sentTypes = (push: Mock<RelayApi['relayApi']['push']>): string[] =>
  push.mock.calls.flatMap((c) =>
    (c[0].envelopes as EventEnvelope[]).map((e) => `${e.deviceId}:${e.eventType}`),
  );

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockFs.reset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('BLE-03 多设备公平性：队头设备大量周期事件不应饿死另一设备的 possible_fall', () => {
  it('设备 A 已积压 250 条 location_update，设备 B 的 possible_fall 应在前 2 轮 flush 内送出（当前需第 4 轮≈15s+）', async () => {
    const { up, push } = load();
    for (let i = 0; i < 250; i += 1) up.enqueueRelayEvent(env('location_update', 'helmet_A'));
    up.enqueueRelayEvent(env('possible_fall', 'helmet_B'));
    await up.flushRelayQueue();
    await up.flushRelayQueue();
    expect(sentTypes(push)).toContain('helmet_B:possible_fall');
  });
});

describe('BLE-04 溢出策略：>1000 时丢弃最旧不应丢掉高危事件', () => {
  it('离线早期发生的 possible_fall 被后续 1000 条 location_update 挤出队列', async () => {
    const { up, push } = load();
    const fall = env('possible_fall', 'helmet_A');
    up.enqueueRelayEvent(fall);
    for (let i = 0; i < 1000; i += 1) up.enqueueRelayEvent(env('location_update', 'helmet_A'));
    for (let i = 0; i < 12; i += 1) await up.flushRelayQueue();
    const sent = push.mock.calls.flatMap((c) =>
      (c[0].envelopes as EventEnvelope[]).map((e) => e.eventId),
    );
    expect(sent).toContain(fall.eventId);
  });

  it('同理 manual_sos 也不应被周期事件挤出', async () => {
    const { up, push } = load();
    const sos = env('manual_sos', 'helmet_A');
    up.enqueueRelayEvent(sos);
    for (let i = 0; i < 1000; i += 1) up.enqueueRelayEvent(env('device_status', 'helmet_A'));
    for (let i = 0; i < 12; i += 1) await up.flushRelayQueue();
    const sent = push.mock.calls.flatMap((c) =>
      (c[0].envelopes as EventEnvelope[]).map((e) => e.eventId),
    );
    expect(sent).toContain(sos.eventId);
  });
});

describe('BLE-05 队头阻塞：某设备 404/401 永久失败时不应阻塞其余设备', () => {
  it('helmet_A 持续 404（已解绑），helmet_B 的 possible_fall 应仍能送出', async () => {
    const { up, push } = load();
    push.mockImplementation(async (body) => {
      if (body.deviceId === 'helmet_A') throw notFound;
      return { accepted: body.envelopes.length, duplicate: 0, invalid: 0 };
    });
    up.enqueueRelayEvent(env('location_update', 'helmet_A'));
    up.enqueueRelayEvent(env('possible_fall', 'helmet_B'));
    for (let i = 0; i < 10; i += 1) await up.flushRelayQueue();
    expect(sentTypes(push)).toContain('helmet_B:possible_fall');
  });

  it('404 不可恢复错误不应无限重试同一批（10 轮 flush 应少于 10 次请求）', async () => {
    const { up, push } = load();
    push.mockRejectedValue(notFound);
    up.enqueueRelayEvent(env('location_update', 'helmet_A'));
    for (let i = 0; i < 10; i += 1) await up.flushRelayQueue();
    expect(push.mock.calls.length).toBeLessThan(10);
  });
});

describe('BLE-06 账号切换：队列与持久化文件不按用户隔离', () => {
  it('账号 A 退出后账号 B 登录，不应用 B 的会话补传 A 设备的事件（且 B 自己的设备不应被阻塞）', async () => {
    const { up, push } = load();
    // 账号 A 登录期间（use-realtime 传入当前用户 id 作为队列归属）
    up.startRelayUplink('user_A');
    up.enqueueRelayEvent(env('location_update', 'helmet_of_A'));
    up.stopRelayUplink(); // A 退出登录（use-realtime 清理）
    // 账号 B 登录：服务端对 helmet_of_A 返回 404（不是 B 的设备）
    push.mockImplementation(async (body) => {
      if (body.deviceId === 'helmet_of_A') throw notFound;
      return { accepted: body.envelopes.length, duplicate: 0, invalid: 0 };
    });
    up.startRelayUplink('user_B');
    await tick();
    up.enqueueRelayEvent(env('possible_fall', 'helmet_of_B'));
    for (let i = 0; i < 5; i += 1) await up.flushRelayQueue();
    up.stopRelayUplink();
    const devicesPushed = push.mock.calls.map((c) => c[0].deviceId);
    expect(devicesPushed).not.toContain('helmet_of_A');
    expect(sentTypes(push)).toContain('helmet_of_B:possible_fall');
  });

  it('杀 App 后 B 登录：文件里 A 的事件不应被恢复到 B 的会话', async () => {
    // 文件是 A 的分区（带归属标记）；B 登录时不得恢复
    mockFs.content = JSON.stringify({
      v: 2,
      owner: 'user_A',
      events: [env('possible_fall', 'helmet_of_A')],
    });
    const { up, push } = load();
    up.startRelayUplink('user_B');
    await tick();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    expect(push.mock.calls.map((c) => c[0].deviceId)).not.toContain('helmet_of_A');
  });
});

describe('BLE-07 start→stop→start 在 load 完成前重入：持久化内容被重复恢复', () => {
  it('同一 eventId 不应在内存队列里出现两份（会造成一次 flush 内重复提交）', async () => {
    const saved = env('possible_fall', 'helmet_A');
    mockFs.content = JSON.stringify({ v: 2, owner: 'user_A', events: [saved] });
    const { up, push } = load();
    up.startRelayUplink('user_A');
    up.stopRelayUplink();
    up.startRelayUplink('user_A');
    await tick();
    await up.flushRelayQueue();
    up.stopRelayUplink();
    const ids = push.mock.calls.flatMap((c) =>
      (c[0].envelopes as EventEnvelope[]).map((e) => e.eventId),
    );
    expect(ids.filter((id) => id === saved.eventId)).toHaveLength(1);
  });
});

describe('BLE-08 持久化文件内容为 JSON null 时的恢复路径', () => {
  it('load 返回 null 不应产生未处理的 Promise rejection', async () => {
    mockFs.content = 'null';
    const { up } = load();
    const rejections: unknown[] = [];
    const handler = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', handler);
    try {
      up.startRelayUplink();
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', handler);
      up.stopRelayUplink();
    }
    expect(rejections).toEqual([]);
  });
});
