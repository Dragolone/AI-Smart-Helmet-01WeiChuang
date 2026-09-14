// 审计 2026-09-13 §5：ble-relay 下行命令在 __DEV__=true / false 下的行为分别验证。
// __DEV__ 是运行时全局（jest-expo 默认 true），writeToHelmet 每次调用时读取，可在用例内切换。
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { WsDeviceCommandData } from '@helmet/shared';

type Relay = typeof import('../ble-relay');
type RelayApi = typeof import('@/api/relay');

jest.mock('@/api/relay', () => ({
  relayApi: { push: jest.fn(), ack: jest.fn() },
}));

const g = globalThis as unknown as { __DEV__: boolean };
const originalDev = g.__DEV__;

function load(): { relay: Relay; ack: Mock<RelayApi['relayApi']['ack']> } {
  let relay!: Relay;
  let api!: RelayApi;
  jest.isolateModules(() => {
    relay = require('../ble-relay') as Relay;
    api = require('@/api/relay') as RelayApi;
  });
  const ack = api.relayApi.ack as unknown as Mock<RelayApi['relayApi']['ack']>;
  ack.mockResolvedValue({ commandId: 'x', status: 'success' });
  return { relay, ack };
}

const cmd = (id: string, deviceId = 'helmet_audit'): WsDeviceCommandData => ({
  deviceId,
  commandId: id,
  type: 'set_config',
  params: { volume: 90, light: 2 },
  issuedAt: new Date().toISOString(),
});

let logSpy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  g.__DEV__ = originalDev;
  jest.restoreAllMocks();
});

describe('__DEV__ = false（生产构建，BLE GATT 未实现）', () => {
  it('只记日志、不回执 delivered/executed，返回 false（设置页如实显示 offline）', async () => {
    g.__DEV__ = false;
    const { relay, ack } = load();
    expect(await relay.handleDeviceCommand(cmd('cmd-prod-1'))).toBe(false);
    expect(ack).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('device_command cmd-prod-1'),
      expect.anything(),
    );
  });

  it('生产下未写入头盔的命令仍被记入 handled 集合：服务端重连补推同一命令时被静默忽略（BLE-10）', async () => {
    g.__DEV__ = false;
    const { relay, ack } = load();
    await relay.handleDeviceCommand(cmd('cmd-prod-2'));
    // 假设此后 BLE 链路可用（例如 __DEV__ 场景切换只是为了暴露 handled 残留）
    g.__DEV__ = true;
    expect(await relay.handleDeviceCommand(cmd('cmd-prod-2'))).toBe(false);
    expect(ack).not.toHaveBeenCalled();
  });
});

describe('__DEV__ = true（开发模拟：写入成功 + 模拟头盔执行）', () => {
  it('delivered → executed(success) 两条回执按序提交，返回 true（模拟验证，非真机执行）', async () => {
    g.__DEV__ = true;
    const { relay, ack } = load();
    expect(await relay.handleDeviceCommand(cmd('cmd-dev-1'))).toBe(true);
    expect(ack.mock.calls.map((c) => c[2])).toEqual([
      { stage: 'delivered' },
      { stage: 'executed', result: 'success' },
    ]);
  });

  it('delivered 成功但 executed 回执失败 → 移出去重集，补推时会再次提交 delivered（服务端幂等）', async () => {
    g.__DEV__ = true;
    const { relay, ack } = load();
    ack
      .mockResolvedValueOnce({ commandId: 'cmd-dev-2', status: 'delivered' })
      .mockRejectedValueOnce(new Error('network'));
    expect(await relay.handleDeviceCommand(cmd('cmd-dev-2'))).toBe(false);
    ack.mockResolvedValue({ commandId: 'cmd-dev-2', status: 'success' });
    expect(await relay.handleDeviceCommand(cmd('cmd-dev-2'))).toBe(true);
    expect(ack.mock.calls.map((c) => c[2].stage)).toEqual([
      'delivered',
      'executed',
      'delivered',
      'executed',
    ]);
  });

  it('同一 commandId 并发两次到达（WS 实时推 + 连接补推）只处理一次', async () => {
    g.__DEV__ = true;
    const { relay, ack } = load();
    const [a, b] = await Promise.all([
      relay.handleDeviceCommand(cmd('cmd-dev-3')),
      relay.handleDeviceCommand(cmd('cmd-dev-3')),
    ]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(ack).toHaveBeenCalledTimes(2);
  });

  it('handled 集合仅内存且永不收缩：处理 N 条命令后集合保持 N（跨账号/长会话残留，BLE-10 备注）', async () => {
    g.__DEV__ = true;
    const { relay, ack } = load();
    for (let i = 0; i < 50; i += 1) await relay.handleDeviceCommand(cmd(`cmd-grow-${i}`));
    ack.mockClear();
    // 所有 50 条再次到达全部被忽略——说明集合未回收；也没有按账号清理的入口
    for (let i = 0; i < 50; i += 1) {
      expect(await relay.handleDeviceCommand(cmd(`cmd-grow-${i}`))).toBe(false);
    }
    expect(ack).not.toHaveBeenCalled();
  });
});
