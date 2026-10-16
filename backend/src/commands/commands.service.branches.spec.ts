// CommandsService 剩余分支：回调注入（cmd_ack 路由、WS 连接补推）、回执消息体各种不合法、
// 越权 / 串线回执、头盔上报键数上限、命令详情归属。Prisma / MQTT / 网关全 mock。
import { Logger } from '@nestjs/common';
import type { MqttConsumerService } from '../ingest/mqtt-consumer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import { CommandsService } from './commands.service';

const cmdRow = (over: Record<string, unknown> = {}) => ({
  id: 'cmd1',
  deviceId: 'helmet_001',
  type: 'set_config',
  params: { volume: 5 },
  status: 'pending',
  issuedBy: 'u1',
  issuedAt: new Date('2026-10-16T00:00:00Z'),
  deliveredAt: null,
  ackResult: null,
  errorCode: null,
  executedAt: null,
  ackedAt: null,
  ...over,
});

describe('CommandsService：剩余分支', () => {
  const prisma = {
    device: { findMany: jest.fn(), findUnique: jest.fn() },
    deviceCommand: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  const mqtt = { setCmdAckHandler: jest.fn(), publishCommand: jest.fn() };
  const gateway = {
    setUserConnectedHandler: jest.fn(),
    sendToClient: jest.fn(),
    pushToUser: jest.fn(),
  };
  let svc: CommandsService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new CommandsService(
      prisma as unknown as PrismaService,
      mqtt as unknown as MqttConsumerService,
      gateway as unknown as RealtimeGateway,
    );
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('onModuleInit 回调注入', () => {
    beforeEach(() => svc.onModuleInit());

    it('cmd_ack 处理器：MQTT 收到的回执原样转给 handleAck', async () => {
      const spy = jest.spyOn(svc, 'handleAck').mockResolvedValue(undefined);
      const handler = (
        mqtt.setCmdAckHandler.mock.calls[0] as [
          (d: string, r: string) => Promise<void>,
        ]
      )[0];
      await handler('helmet_001', '{"commandId":"c"}');
      expect(spy).toHaveBeenCalledWith('helmet_001', '{"commandId":"c"}');
    });

    const connected = () =>
      (
        gateway.setUserConnectedHandler.mock.calls[0] as [
          (userId: string, client: unknown) => Promise<void>,
        ]
      )[0];

    it('WS 连接补推：用户名下没有设备就不查命令', async () => {
      prisma.device.findMany.mockResolvedValue([]);
      await connected()('u1', {});
      expect(prisma.deviceCommand.findMany).not.toHaveBeenCalled();
      expect(gateway.sendToClient).not.toHaveBeenCalled();
    });

    it('WS 连接补推：只补本人下的 pending / delivered，按下发时间顺序逐条定向推给这个连接', async () => {
      const client = { id: 'ws' };
      prisma.device.findMany.mockResolvedValue([
        { deviceId: 'helmet_001' },
        { deviceId: 'helmet_002' },
      ]);
      prisma.deviceCommand.findMany.mockResolvedValue([
        cmdRow({ id: 'a' }),
        cmdRow({ id: 'b', deviceId: 'helmet_002', status: 'delivered' }),
      ]);
      await connected()('u1', client);
      expect(prisma.deviceCommand.findMany).toHaveBeenCalledWith({
        where: {
          deviceId: { in: ['helmet_001', 'helmet_002'] },
          issuedBy: 'u1',
          status: { in: ['pending', 'delivered'] },
        },
        orderBy: { issuedAt: 'asc' },
      });
      expect(gateway.sendToClient).toHaveBeenCalledTimes(2);
      expect(gateway.sendToClient).toHaveBeenNthCalledWith(1, client, {
        type: 'device_command',
        data: {
          deviceId: 'helmet_001',
          commandId: 'a',
          type: 'set_config',
          params: { volume: 5 },
          issuedAt: '2026-10-16T00:00:00.000Z',
        },
        sentAt: expect.any(String),
      });
    });
  });

  describe('handleAck：消息体不合法一律忽略、不查库', () => {
    it.each([
      ['不是 JSON', 'not json'],
      ['JSON null', 'null'],
      ['JSON 数字', '123'],
      ['JSON 字符串', '"success"'],
      ['缺 commandId', '{"result":"success"}'],
      ['commandId 空串', '{"commandId":"","result":"success"}'],
      ['commandId 不是字符串', '{"commandId":7,"result":"success"}'],
      ['result 不在枚举内', '{"commandId":"c1","result":"ok"}'],
    ])('%s', async (_n, raw) => {
      await svc.handleAck('helmet_001', raw);
      expect(warnSpy).toHaveBeenCalledWith(
        'cmd_ack 消息体不合法，忽略（device=helmet_001）',
      );
      expect(prisma.deviceCommand.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['命令不存在', null],
      [
        '命令属于别的设备（串线 / 越权回执）',
        cmdRow({ deviceId: 'helmet_999' }),
      ],
    ])('%s：忽略，不终态化', async (_n, found) => {
      prisma.deviceCommand.findUnique.mockResolvedValue(found);
      await svc.handleAck(
        'helmet_001',
        '{"commandId":"cmd1","result":"success"}',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        'cmd_ack 找不到匹配命令或设备不符，忽略：cmd1（device=helmet_001）',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('已是终态（success / failed）的重复回执：跳过，不开事务', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(
        cmdRow({ status: 'failed' }),
      );
      await svc.handleAck(
        'helmet_001',
        '{"commandId":"cmd1","result":"success"}',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('reportSettings 入参上限', () => {
    beforeEach(() =>
      prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u1' }),
    );

    it('超过 32 个键：400 VALIDATION_FAILED，不开事务', async () => {
      const raw = Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [`k${i}`, 1]),
      );
      await expect(
        svc.reportSettings('u1', 'helmet_001', raw),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'VALIDATION_FAILED',
          message: 'settings 最多 32 个键',
        },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['数组', [1, 2]],
      ['null', null],
      ['字符串', 'volume=5'],
    ])('settings 是%s：400', async (_n, raw) => {
      await expect(
        svc.reportSettings('u1', 'helmet_001', raw),
      ).rejects.toMatchObject({
        response: { message: 'settings 必须是对象' },
      });
    });

    it('设备不归本人：先 404，不校验内容', async () => {
      prisma.device.findUnique.mockResolvedValue({ bindUserId: 'other' });
      await expect(
        svc.reportSettings('u1', 'helmet_001', null),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('getCommand 归属', () => {
    it('命令不存在：404', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(null);
      await expect(svc.getCommand('u1', 'x')).rejects.toMatchObject({
        status: 404,
        response: { code: 'NOT_FOUND' },
      });
    });

    it('不是本人下发的：404，不再查设备', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(
        cmdRow({ issuedBy: 'u2' }),
      );
      await expect(svc.getCommand('u1', 'cmd1')).rejects.toMatchObject({
        status: 404,
      });
      expect(prisma.device.findUnique).not.toHaveBeenCalled();
    });

    it('本人下发、但设备已换绑给别人（或已解绑）：404', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(cmdRow());
      prisma.device.findUnique.mockResolvedValueOnce({ bindUserId: 'u2' });
      await expect(svc.getCommand('u1', 'cmd1')).rejects.toMatchObject({
        status: 404,
      });
      prisma.device.findUnique.mockResolvedValueOnce(null);
      await expect(svc.getCommand('u1', 'cmd1')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('本人下发且设备仍归本人：返回线上格式', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(cmdRow());
      prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u1' });
      await expect(svc.getCommand('u1', 'cmd1')).resolves.toMatchObject({
        commandId: 'cmd1',
        deviceId: 'helmet_001',
        status: 'pending',
      });
    });
  });
});
