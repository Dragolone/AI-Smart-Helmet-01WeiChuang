// 审计 2026-09-13 §5（2026-09-16 随 GATT 落地改写）：ble-relay 下行命令在「头盔未连接」与
// 「模拟器无蓝牙 + __DEV__」两种环境下的行为分别验证；真机连接路径见 ble-relay.test.ts。
// __DEV__ 是运行时全局（jest-expo 默认 true），writeToHelmet 每次调用时读取，可在用例内切换。
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { WsDeviceCommandData } from '@helmet/shared';

type Relay = typeof import('../ble-relay');
type RelayApi = typeof import('@/api/relay');
type BleStore = typeof import('@/stores/ble-store');

jest.mock('@/api/relay', () => ({
  relayApi: { push: jest.fn(), ack: jest.fn() },
}));
jest.mock('@/services/ble-link', () => ({
  isHelmetConnected: jest.fn(() => false),
  writeHelmetRegister: jest.fn(),
}));

const g = globalThis as unknown as { __DEV__: boolean };
const originalDev = g.__DEV__;

function load(adapter: 'on' | 'unsupported'): {
  relay: Relay;
  ack: Mock<RelayApi['relayApi']['ack']>;
} {
  let relay!: Relay;
  let api!: RelayApi;
  jest.isolateModules(() => {
    relay = require('../ble-relay') as Relay;
    api = require('@/api/relay') as RelayApi;
    (require('@/stores/ble-store') as BleStore).useBleStore.getState().setAdapter(adapter);
  });
  const ack = api.relayApi.ack as unknown as Mock<RelayApi['relayApi']['ack']>;
  ack.mockReset();
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

describe('头盔未连接（真机蓝牙可用但头盔不在身边）', () => {
  it.each([true, false])('__DEV__=%s：不回执、返回 false，服务端按 30s 超时判 offline', async (dev) => {
    g.__DEV__ = dev;
    const { relay, ack } = load('on');
    expect(await relay.handleDeviceCommand(cmd('cmd-nolink'))).toBe(false);
    expect(ack).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('[BLE-RELAY]', expect.stringContaining('cmd-nolink 未送达'));
  });

  it('未送达的命令不占用去重集：服务端补推同一命令时会再次尝试（BLE-10 已收口）', async () => {
    const { relay, ack } = load('on');
    await relay.handleDeviceCommand(cmd('cmd-again'));
    await relay.handleDeviceCommand(cmd('cmd-again'));
    expect(ack).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.filter((c: unknown[]) => c.map(String).join(' ').includes('cmd-again 未送达'))).toHaveLength(2);
  });
});

describe('模拟器无蓝牙（adapter=unsupported）+ __DEV__：模拟头盔执行，便于无硬件验证设置页状态流转', () => {
  it('delivered → executed(success) 两条回执按序提交，返回 true（模拟验证，非真机执行）', async () => {
    g.__DEV__ = true;
    const { relay, ack } = load('unsupported');
    expect(await relay.handleDeviceCommand(cmd('cmd-dev-1'))).toBe(true);
    expect(ack.mock.calls.map((c) => c[2])).toEqual([
      { stage: 'delivered' },
      { stage: 'executed', result: 'success' },
    ]);
  });

  it('生产构建即使在无蓝牙环境也不模拟：不回执、返回 false', async () => {
    g.__DEV__ = false;
    const { relay, ack } = load('unsupported');
    expect(await relay.handleDeviceCommand(cmd('cmd-prod-sim'))).toBe(false);
    expect(ack).not.toHaveBeenCalled();
  });

  it('delivered 成功但 executed 回执失败 → 移出去重集，补推时会再次提交 delivered（服务端幂等）', async () => {
    g.__DEV__ = true;
    const { relay, ack } = load('unsupported');
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
    const { relay, ack } = load('unsupported');
    const [a, b] = await Promise.all([
      relay.handleDeviceCommand(cmd('cmd-dev-3')),
      relay.handleDeviceCommand(cmd('cmd-dev-3')),
    ]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(ack).toHaveBeenCalledTimes(2);
  });

  it('handled 集合仅内存且永不收缩：处理 N 条命令后集合保持 N（跨账号/长会话残留，BLE-10 备注）', async () => {
    g.__DEV__ = true;
    const { relay, ack } = load('unsupported');
    for (let i = 0; i < 50; i += 1) await relay.handleDeviceCommand(cmd(`cmd-grow-${i}`));
    ack.mockClear();
    for (let i = 0; i < 50; i += 1) {
      expect(await relay.handleDeviceCommand(cmd(`cmd-grow-${i}`))).toBe(false);
    }
    expect(ack).not.toHaveBeenCalled();
  });
});
