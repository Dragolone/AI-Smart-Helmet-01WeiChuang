// BLE 下行命令处理单测(决策 #36):去重、回执顺序、失败允许重试
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { WsDeviceCommandData } from '@helmet/shared';

import { relayApi } from '@/api/relay';
import { handleDeviceCommand } from '../ble-relay';

jest.mock('@/api/relay', () => ({
  relayApi: { ack: jest.fn() },
}));
const ackMock = relayApi.ack as unknown as Mock<typeof relayApi.ack>;

const cmd = (id: string): WsDeviceCommandData => ({
  deviceId: 'helmet_test',
  commandId: id,
  type: 'set_config',
  params: { volume: 75 },
  issuedAt: new Date().toISOString(),
});

beforeEach(() => {
  ackMock.mockReset();
  ackMock.mockResolvedValue({ commandId: 'x', status: 'success' });
});

describe('handleDeviceCommand', () => {
  it('先 delivered 后 executed,顺序与载荷符合 API.md §8', async () => {
    expect(await handleDeviceCommand(cmd('cmd-order'))).toBe(true);
    expect(ackMock).toHaveBeenCalledTimes(2);
    expect(ackMock.mock.calls[0]).toEqual([
      'helmet_test',
      'cmd-order',
      { stage: 'delivered' },
    ]);
    expect(ackMock.mock.calls[1]).toEqual([
      'helmet_test',
      'cmd-order',
      { stage: 'executed', result: 'success' },
    ]);
  });

  it('同 commandId 重复下发只处理一次(连接补推幂等,API.md §11)', async () => {
    await handleDeviceCommand(cmd('cmd-dup'));
    expect(await handleDeviceCommand(cmd('cmd-dup'))).toBe(false);
    expect(ackMock).toHaveBeenCalledTimes(2); // 仍是第一次的两条回执
  });

  it('回执失败移出去重集,补推可重试成功', async () => {
    ackMock.mockRejectedValueOnce(new Error('network down'));
    expect(await handleDeviceCommand(cmd('cmd-retry'))).toBe(false);
    // 服务端补推同一命令 → 允许再处理
    ackMock.mockResolvedValue({ commandId: 'cmd-retry', status: 'success' });
    expect(await handleDeviceCommand(cmd('cmd-retry'))).toBe(true);
  });
});
