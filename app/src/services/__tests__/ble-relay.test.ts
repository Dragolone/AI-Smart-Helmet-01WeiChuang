// BLE 下行命令处理单测(决策 #36 + 协议 v0.6 GATT 写入):去重、回执顺序、寄存器映射、失败允许重试
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { WsDeviceCommandData } from '@helmet/shared';

import { relayApi } from '@/api/relay';
import { isHelmetConnected, writeHelmetRegister } from '@/services/ble-link';
import { handleDeviceCommand } from '../ble-relay';

jest.mock('@/api/relay', () => ({
  relayApi: { ack: jest.fn() },
}));
jest.mock('@/services/ble-link', () => ({
  isHelmetConnected: jest.fn(),
  writeHelmetRegister: jest.fn(),
}));
const ackMock = relayApi.ack as unknown as Mock<typeof relayApi.ack>;
const connectedMock = isHelmetConnected as unknown as Mock<typeof isHelmetConnected>;
const writeMock = writeHelmetRegister as unknown as Mock<typeof writeHelmetRegister>;

const cmd = (id: string, params: Record<string, unknown> = { volume: 75 }): WsDeviceCommandData => ({
  deviceId: 'helmet_test',
  commandId: id,
  type: 'set_config',
  params,
  issuedAt: new Date().toISOString(),
});

beforeEach(() => {
  ackMock.mockReset();
  ackMock.mockResolvedValue({ commandId: 'x', status: 'success' });
  connectedMock.mockReset();
  connectedMock.mockReturnValue(true);
  writeMock.mockReset();
  writeMock.mockResolvedValue({ delivered: true, executed: true });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('handleDeviceCommand', () => {
  it('先 delivered 后 executed,顺序与载荷符合 API.md §8', async () => {
    expect(await handleDeviceCommand(cmd('cmd-order'))).toBe(true);
    expect(ackMock).toHaveBeenCalledTimes(2);
    expect(ackMock.mock.calls[0]).toEqual(['helmet_test', 'cmd-order', { stage: 'delivered' }]);
    expect(ackMock.mock.calls[1]).toEqual([
      'helmet_test',
      'cmd-order',
      { stage: 'executed', result: 'success' },
    ]);
  });

  it('参数逐键映射到内存表寄存器并单独写入（音量 0x24、大灯 0x26 不连写）', async () => {
    await handleDeviceCommand(cmd('cmd-regs', { volume: 90, light: true }));
    expect(writeMock.mock.calls).toEqual([
      ['helmet_test', 0x24, [90]],
      ['helmet_test', 0x26, [1]],
    ]);
  });

  it('头盔应答错误码 → executed failed + errorCode（绝不显示成功）', async () => {
    writeMock.mockResolvedValue({ delivered: true, executed: false, errorCode: 'ERR_PARAM_VALUE' });
    expect(await handleDeviceCommand(cmd('cmd-err'))).toBe(true);
    expect(ackMock.mock.calls[1][2]).toEqual({
      stage: 'executed',
      result: 'failed',
      errorCode: 'ERR_PARAM_VALUE:volume',
    });
  });

  it('硬件不支持的设置键 → executed failed UNSUPPORTED_SETTING，不写任何寄存器', async () => {
    expect(await handleDeviceCommand(cmd('cmd-unsupported', { hologram: 1 }))).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
    expect(ackMock.mock.calls[1][2]).toEqual({
      stage: 'executed',
      result: 'failed',
      errorCode: 'UNSUPPORTED_SETTING:hologram',
    });
  });

  it('头盔未连接 → 不回执、返回 false，且不占用去重集（连上后服务端补推可再处理）', async () => {
    connectedMock.mockReturnValue(false);
    expect(await handleDeviceCommand(cmd('cmd-offline'))).toBe(false);
    expect(ackMock).not.toHaveBeenCalled();
    connectedMock.mockReturnValue(true);
    expect(await handleDeviceCommand(cmd('cmd-offline'))).toBe(true);
    expect(ackMock).toHaveBeenCalledTimes(2);
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
