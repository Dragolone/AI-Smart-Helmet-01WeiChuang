// 命令与回执状态机（API.md §8，决策 #36 / #45）核心路径：下发双路、PUBACK 条件前进、回执终态化与「只有 success 才写生效设置」、
// 迟到回执不覆盖更新命令的键、relay-ack 两段、头盔实际设置上报的跳过规则。Prisma / MQTT / WS 全 mock。
import { Logger } from '@nestjs/common';
import type { MqttConsumerService } from '../ingest/mqtt-consumer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import { CommandsService } from './commands.service';

const ISSUED = new Date('2026-10-16T00:00:00Z');
const cmd = (over: Record<string, unknown> = {}) => ({
  id: 'cmd1',
  deviceId: 'helmet_001',
  type: 'set_config',
  params: { volume: 50, light: 2 },
  status: 'pending',
  issuedBy: 'u1',
  issuedAt: ISSUED,
  deliveredAt: null,
  ackResult: null,
  errorCode: null,
  executedAt: null,
  ackedAt: null,
  ...over,
});

describe('CommandsService：命令与回执核心路径', () => {
  const tx = {
    $executeRaw: jest.fn(),
    deviceCommand: { updateMany: jest.fn(), findMany: jest.fn() },
    device: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
  };
  const prisma = {
    device: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
    deviceCommand: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (t: typeof tx) => Promise<unknown>)(tx)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  const mqtt = { setCmdAckHandler: jest.fn(), publishCommand: jest.fn() };
  const gateway = {
    setUserConnectedHandler: jest.fn(),
    pushToUser: jest.fn(),
    sendToClient: jest.fn(),
  };
  let svc: CommandsService;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u1' });
    tx.$executeRaw.mockResolvedValue(1);
    tx.deviceCommand.updateMany.mockResolvedValue({ count: 1 });
    tx.deviceCommand.findMany.mockResolvedValue([]);
    tx.device.findUnique.mockResolvedValue({
      settings: { volume: 10, buzzer: true },
    });
    tx.device.update.mockResolvedValue({});
    svc = new CommandsService(
      prisma as unknown as PrismaService,
      mqtt as unknown as MqttConsumerService,
      gateway as unknown as RealtimeGateway,
    );
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('putSettings', () => {
    beforeEach(() => {
      prisma.deviceCommand.create.mockResolvedValue(
        cmd({ params: { volume: 80 } }),
      );
    });

    it('建 pending 命令 → 先 WS 推给本人（BLE 链路）→ 再 MQTT QoS1 → PUBACK 后条件前进到 delivered；响应固定是 pending 快照', async () => {
      const order: string[] = [];
      gateway.pushToUser.mockImplementation(() => order.push('ws'));
      mqtt.publishCommand.mockImplementation(() => {
        order.push('mqtt');
        return Promise.resolve();
      });
      prisma.deviceCommand.updateMany.mockImplementation(() => {
        order.push('delivered');
        return Promise.resolve({ count: 1 });
      });
      await expect(
        svc.putSettings('u1', 'helmet_001', { volume: 80 }),
      ).resolves.toEqual({ commandId: 'cmd1', status: 'pending' });
      expect(order).toEqual(['ws', 'mqtt', 'delivered']);
      expect(prisma.deviceCommand.create).toHaveBeenCalledWith({
        data: {
          deviceId: 'helmet_001',
          type: 'set_config',
          params: { volume: 80 },
          issuedBy: 'u1',
        },
      });
      expect(
        JSON.parse((mqtt.publishCommand.mock.calls[0] as [string, string])[1]),
      ).toEqual({
        commandId: 'cmd1',
        type: 'set_config',
        params: { volume: 80 },
        issuedAt: ISSUED.toISOString(),
      });
      expect(prisma.deviceCommand.updateMany).toHaveBeenCalledWith({
        where: { id: 'cmd1', status: 'pending' },
        data: { status: 'delivered', deliveredAt: expect.any(Date) },
      });
      expect(gateway.pushToUser).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({
          type: 'device_command',
          data: expect.objectContaining({
            commandId: 'cmd1',
            deviceId: 'helmet_001',
          }),
        }),
      );
    });

    it('MQTT 发布失败（Broker 不在）：留 pending、只告警，接口照常返回', async () => {
      mqtt.publishCommand.mockRejectedValue(new Error('MQTT 未连接'));
      await expect(
        svc.putSettings('u1', 'helmet_001', { volume: 80 }),
      ).resolves.toEqual({ commandId: 'cmd1', status: 'pending' });
      expect(prisma.deviceCommand.updateMany).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '命令发布失败或未及时确认（留 pending，超时后判 offline）cmd1：MQTT 未连接',
      );
    });

    it('Broker 半开、PUBACK 一直不来：接口最多等 5 s 就返回 pending，不一直挂着；PUBACK 晚到照样记 delivered（R4-9）', async () => {
      jest.useFakeTimers();
      try {
        let puback!: () => void;
        mqtt.publishCommand.mockReturnValue(
          new Promise<void>((r) => (puback = r)),
        );
        const p = svc.putSettings('u1', 'helmet_001', { volume: 80 });
        await jest.advanceTimersByTimeAsync(5_000);
        await expect(p).resolves.toEqual({
          commandId: 'cmd1',
          status: 'pending',
        });
        expect(prisma.deviceCommand.updateMany).not.toHaveBeenCalled();
        puback();
        await jest.advanceTimersByTimeAsync(0);
        expect(prisma.deviceCommand.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'cmd1', status: 'pending' },
          }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('参数不合法：400，不建命令、不下发', async () => {
      await expect(
        svc.putSettings('u1', 'helmet_001', { volume: 101 }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.deviceCommand.create).not.toHaveBeenCalled();
      expect(gateway.pushToUser).not.toHaveBeenCalled();
    });

    it('设备不归本人：404，不校验参数也不建命令', async () => {
      prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u2' });
      await expect(
        svc.putSettings('u1', 'helmet_001', { volume: 80 }),
      ).rejects.toMatchObject({ status: 404 });
      expect(prisma.deviceCommand.create).not.toHaveBeenCalled();
    });
  });

  describe('handleAck → applyAck', () => {
    const ack = (o: Record<string, unknown>) =>
      JSON.stringify({ commandId: 'cmd1', ...o });

    it('success：条件更新终态化，先拿设备设置锁，再把参数合入生效设置', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(
        cmd({ status: 'delivered' }),
      );
      await svc.handleAck(
        'helmet_001',
        ack({ result: 'success', executedAt: '2026-10-16T00:00:05Z' }),
      );
      expect(tx.deviceCommand.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'cmd1',
          status: { in: ['pending', 'delivered', 'offline'] },
        },
        data: {
          status: 'success',
          ackResult: 'success',
          errorCode: null,
          executedAt: new Date('2026-10-16T00:00:05Z'),
          ackedAt: expect.any(Date),
        },
      });
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect((tx.$executeRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([
        'device-settings:helmet_001',
      ]);
      expect(tx.device.update).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001' },
        data: { settings: { volume: 50, buzzer: true, light: 2 } },
      });
      expect(logSpy).toHaveBeenCalledWith('命令回执已处理：cmd1 → success');
    });

    it('failed：只终态化、记错误码，绝不写生效设置', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(cmd());
      await svc.handleAck(
        'helmet_001',
        ack({ result: 'failed', errorCode: 'ERR_PARAM_VALUE' }),
      );
      expect(tx.deviceCommand.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            errorCode: 'ERR_PARAM_VALUE',
          }),
        }),
      );
      expect(tx.device.update).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        '命令回执已处理：cmd1 → failed（ERR_PARAM_VALUE）',
      );
    });

    it('设备时间戳非法 / 存不下（0000 年）：executedAt 用服务器时间兜底；errorCode 不是字符串按 null', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(cmd());
      const before = Date.now();
      await svc.handleAck(
        'helmet_001',
        ack({
          result: 'failed',
          executedAt: '0000-01-01T00:00:00Z',
          errorCode: 42,
        }),
      );
      const data = (
        tx.deviceCommand.updateMany.mock.calls[0] as [
          { data: { executedAt: Date; errorCode: unknown } },
        ]
      )[0].data;
      expect(data.executedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(data.errorCode).toBeNull();
    });

    it('迟到回执（已判 offline）：如实覆盖并告警', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(
        cmd({ status: 'offline' }),
      );
      await svc.handleAck('helmet_001', ack({ result: 'success' }));
      expect(warnSpy).toHaveBeenCalledWith(
        '迟到回执（已判 offline）如实覆盖：cmd1 → success',
      );
      expect(tx.device.update).toHaveBeenCalled();
    });

    it('条件更新没抢到（另一份回执 / 扫描先到）：不写生效设置', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(cmd());
      tx.deviceCommand.updateMany.mockResolvedValue({ count: 0 });
      await svc.handleAck('helmet_001', ack({ result: 'success' }));
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.device.update).not.toHaveBeenCalled();
    });

    it('迟到回执不把更新命令已生效的键盖回旧值：只合入没被覆盖的键', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(cmd());
      tx.deviceCommand.findMany.mockResolvedValue([{ params: { volume: 90 } }]);
      tx.device.findUnique.mockResolvedValue({ settings: { volume: 90 } });
      await svc.handleAck('helmet_001', ack({ result: 'success' }));
      expect(tx.deviceCommand.findMany).toHaveBeenCalledWith({
        where: {
          deviceId: 'helmet_001',
          type: 'set_config',
          status: 'success',
          issuedAt: { gt: ISSUED },
          id: { not: 'cmd1' },
        },
        select: { params: true },
      });
      expect(tx.device.update).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001' },
        data: { settings: { volume: 90, light: 2 } },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '迟到回执 cmd1：键 volume 已被更新命令覆盖，不回写',
      );
    });

    it('设备当前没有任何生效设置（null）：从空对象合入', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(cmd());
      tx.device.findUnique.mockResolvedValue({ settings: null });
      await svc.handleAck('helmet_001', ack({ result: 'success' }));
      expect(tx.device.update).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001' },
        data: { settings: { volume: 50, light: 2 } },
      });
    });

    it('非 set_config 类型的命令 success：只终态化，不碰设置', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(
        cmd({ type: 'reboot', params: {} }),
      );
      await svc.handleAck('helmet_001', ack({ result: 'success' }));
      expect(tx.deviceCommand.updateMany).toHaveBeenCalled();
      expect(tx.device.update).not.toHaveBeenCalled();
    });
  });

  describe('relayAck（BLE 下行回执）', () => {
    beforeEach(() => {
      prisma.deviceCommand.findUnique.mockResolvedValue(cmd());
      prisma.deviceCommand.findUniqueOrThrow.mockResolvedValue({
        status: 'delivered',
      });
      prisma.deviceCommand.updateMany.mockResolvedValue({ count: 1 });
    });

    it('不是本人下发的命令（换绑前前主人下发的）：404，不推进、不让它的设置生效（观察项 12 / R4-2）', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(
        cmd({ issuedBy: 'previous-owner' }),
      );
      await expect(
        svc.relayAck('u1', 'helmet_001', 'cmd1', {
          stage: 'executed',
          result: 'success',
        } as never),
      ).rejects.toMatchObject({ status: 404 });
      expect(prisma.deviceCommand.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('stage=delivered：只从 pending 前进到 delivered，返回当前状态', async () => {
      await expect(
        svc.relayAck('u1', 'helmet_001', 'cmd1', {
          stage: 'delivered',
        } as never),
      ).resolves.toEqual({ commandId: 'cmd1', status: 'delivered' });
      expect(prisma.deviceCommand.updateMany).toHaveBeenCalledWith({
        where: { id: 'cmd1', status: 'pending' },
        data: { status: 'delivered', deliveredAt: expect.any(Date) },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('stage=executed：走同一套回执终态化；executedAt 非法按服务器时间', async () => {
      prisma.deviceCommand.findUniqueOrThrow.mockResolvedValue({
        status: 'success',
      });
      await expect(
        svc.relayAck('u1', 'helmet_001', 'cmd1', {
          stage: 'executed',
          result: 'success',
          executedAt: 'garbage',
        } as never),
      ).resolves.toEqual({ commandId: 'cmd1', status: 'success' });
      const data = (
        tx.deviceCommand.updateMany.mock.calls[0] as [
          { data: { executedAt: Date; errorCode: unknown } },
        ]
      )[0].data;
      expect(data.errorCode).toBeNull();
      expect(data.executedAt).toBeInstanceOf(Date);
      expect(tx.device.update).toHaveBeenCalled();
    });

    it('已终态的命令再收 executed：幂等返回现状，不报错', async () => {
      prisma.deviceCommand.findUnique.mockResolvedValue(
        cmd({ status: 'failed' }),
      );
      prisma.deviceCommand.findUniqueOrThrow.mockResolvedValue({
        status: 'failed',
      });
      await expect(
        svc.relayAck('u1', 'helmet_001', 'cmd1', {
          stage: 'executed',
          result: 'success',
        } as never),
      ).resolves.toEqual({ commandId: 'cmd1', status: 'failed' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['命令不存在', null],
      ['命令属于别的设备', cmd({ deviceId: 'helmet_999' })],
    ])('%s：404', async (_n, found) => {
      prisma.deviceCommand.findUnique.mockResolvedValue(found);
      await expect(
        svc.relayAck('u1', 'helmet_001', 'cmd1', {
          stage: 'delivered',
        } as never),
      ).rejects.toMatchObject({
        status: 404,
        response: { message: '命令不存在' },
      });
    });
  });

  describe('reportSettings（头盔实际设置上报）', () => {
    beforeEach(() => {
      tx.device.findUniqueOrThrow.mockResolvedValue({
        settings: { volume: 10, light: 1 },
      });
    });

    it('合法键写入、校正差异记日志；非法键单独跳过（invalid），不让整批作废', async () => {
      const res = await svc.reportSettings('u1', 'helmet_001', {
        volume: 30,
        light: 1,
        bogus: 1,
        radarDistance: 4,
      });
      expect(res.applied).toEqual(['volume', 'light']);
      expect(res.settings).toEqual({ volume: 30, light: 1 });
      expect(res.skipped).toEqual([
        expect.objectContaining({ key: 'bogus', reason: 'invalid' }),
        expect.objectContaining({ key: 'radarDistance', reason: 'invalid' }),
      ]);
      expect(tx.device.update).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001' },
        data: { settings: { volume: 30, light: 1 } },
      });
      expect(logSpy).toHaveBeenCalledWith(
        '头盔实际设置与记录不符，已按上报校正（helmet_001）：volume 10→30',
      );
    });

    it('有未完成或 30 秒内刚成功的命令碰过的键：跳过（recent_command），以命令为准', async () => {
      tx.deviceCommand.findMany.mockResolvedValue([{ params: { volume: 80 } }]);
      const res = await svc.reportSettings('u1', 'helmet_001', {
        volume: 10,
        light: 3,
      });
      expect(res.applied).toEqual(['light']);
      expect(res.skipped).toEqual([
        {
          key: 'volume',
          reason: 'recent_command',
          message: '设置项 volume 有未完成或刚成功的下发命令，以命令为准',
        },
      ]);
      const where = (
        tx.deviceCommand.findMany.mock.calls[0] as [
          { where: { OR: unknown[] } },
        ]
      )[0].where;
      expect(where.OR).toEqual([
        { status: { in: ['pending', 'delivered'] } },
        { status: 'success', ackedAt: { gt: expect.any(Date) } },
      ]);
      expect((tx.$executeRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([
        'device-settings:helmet_001',
      ]);
    });

    it('全部被跳过：不写库；与记录一致的值不算校正', async () => {
      const res = await svc.reportSettings('u1', 'helmet_001', { bogus: true });
      expect(res.applied).toEqual([]);
      expect(tx.device.update).not.toHaveBeenCalled();
      tx.device.update.mockClear();
      logSpy.mockClear();
      await svc.reportSettings('u1', 'helmet_001', { volume: 10 });
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('settings 为空对象：400', async () => {
      await expect(
        svc.reportSettings('u1', 'helmet_001', {}),
      ).rejects.toMatchObject({
        response: { message: 'settings 不能为空' },
      });
    });

    it('设备原本没有生效设置（null）：从空对象开始', async () => {
      tx.device.findUniqueOrThrow.mockResolvedValue({ settings: null });
      const res = await svc.reportSettings('u1', 'helmet_001', { volume: 5 });
      expect(res.settings).toEqual({ volume: 5 });
    });
  });

  describe('getSettings / listCommands', () => {
    it('getSettings：生效设置 + 本人最近一次下发；都没有时 settings={}、lastCommand=null', async () => {
      prisma.device.findUniqueOrThrow.mockResolvedValue({ settings: null });
      prisma.deviceCommand.findFirst.mockResolvedValue(null);
      await expect(svc.getSettings('u1', 'helmet_001')).resolves.toEqual({
        settings: {},
        lastCommand: null,
      });
      expect(prisma.deviceCommand.findFirst).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001', issuedBy: 'u1' },
        orderBy: { issuedAt: 'desc' },
      });
      prisma.device.findUniqueOrThrow.mockResolvedValue({
        settings: { volume: 3 },
      });
      prisma.deviceCommand.findFirst.mockResolvedValue(
        cmd({ status: 'success', deliveredAt: ISSUED, executedAt: ISSUED }),
      );
      await expect(svc.getSettings('u1', 'helmet_001')).resolves.toMatchObject({
        settings: { volume: 3 },
        lastCommand: {
          commandId: 'cmd1',
          status: 'success',
          deliveredAt: ISSUED.toISOString(),
          executedAt: ISSUED.toISOString(),
        },
      });
    });

    it('listCommands：只含本人下发的，最新在前 + id 兜底，按页跳过', async () => {
      prisma.deviceCommand.count.mockResolvedValue(3);
      prisma.deviceCommand.findMany.mockResolvedValue([cmd()]);
      const r = await svc.listCommands('u1', 'helmet_001', 2, 2);
      expect(r).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(r.items[0]).toMatchObject({
        commandId: 'cmd1',
        deliveredAt: null,
      });
      expect(prisma.deviceCommand.findMany).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001', issuedBy: 'u1' },
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        skip: 2,
        take: 2,
      });
    });
  });
});
