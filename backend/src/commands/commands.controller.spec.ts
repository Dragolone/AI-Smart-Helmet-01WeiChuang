// 命令控制器：参数映射 + relay-ack 的字段依赖（stage=executed 必带 result）在这里收口。
import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { CommandsController } from './commands.controller';
import type { CommandsService } from './commands.service';

describe('CommandsController', () => {
  const svc = {
    putSettings: jest.fn(),
    getSettings: jest.fn(),
    reportSettings: jest.fn(),
    relayAck: jest.fn(),
    listCommands: jest.fn(),
    getCommand: jest.fn(),
  };
  const ctl = new CommandsController(svc as unknown as CommandsService);
  const req = { user: { userId: 'u1' } } as AuthenticatedRequest;
  beforeEach(() => jest.clearAllMocks());

  it('relay-ack：stage=executed 却没带 result → 400，不进服务层', () => {
    let err: unknown;
    try {
      void ctl.relayAck(req, 'helmet_001', 'cmd1', {
        stage: 'executed',
      } as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'stage=executed 时 result 必填',
    });
    expect(svc.relayAck).not.toHaveBeenCalled();
  });

  it('relay-ack：delivered 不要求 result；executed 带 result 原样转给服务层', () => {
    void ctl.relayAck(req, 'helmet_001', 'cmd1', {
      stage: 'delivered',
    } as never);
    void ctl.relayAck(req, 'helmet_001', 'cmd1', {
      stage: 'executed',
      result: 'failed',
      errorCode: 'ERR_X',
    } as never);
    expect(svc.relayAck.mock.calls).toEqual([
      ['u1', 'helmet_001', 'cmd1', { stage: 'delivered' }],
      [
        'u1',
        'helmet_001',
        'cmd1',
        { stage: 'executed', result: 'failed', errorCode: 'ERR_X' },
      ],
    ]);
  });

  it('其余接口：userId 取自登录态，参数原样透传', () => {
    void ctl.putSettings(req, 'h', { settings: { volume: 5 } });
    void ctl.getSettings(req, 'h');
    void ctl.reportSettings(req, 'h', { settings: { light: 1 } });
    void ctl.list(req, 'h', { page: 2, pageSize: 10 });
    void ctl.detail(req, 'cmd9');
    expect(svc.putSettings).toHaveBeenCalledWith('u1', 'h', { volume: 5 });
    expect(svc.getSettings).toHaveBeenCalledWith('u1', 'h');
    expect(svc.reportSettings).toHaveBeenCalledWith('u1', 'h', { light: 1 });
    expect(svc.listCommands).toHaveBeenCalledWith('u1', 'h', 2, 10);
    expect(svc.getCommand).toHaveBeenCalledWith('u1', 'cmd9');
  });
});
