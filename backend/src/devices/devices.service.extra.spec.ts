// DevicesService 其余路径：绑定码为空、重命名 trim、解绑（自开事务 / 用调用方事务、条件更新防误伤、清名字）、
// 注销时逐台解绑、状态、电量历史（无绑定区间直接空、行映射、charging 非布尔按 null）。
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { BindingScopeService } from './binding-scope.service';
import { DevicesService } from './devices.service';

const NOW = Date.parse('2026-10-16T08:00:00Z');
const device = (over: Record<string, unknown> = {}) => ({
  deviceId: 'helmet_001',
  name: '通勤盔',
  bindCode: '12345678',
  bindUserId: 'u1',
  boundAt: new Date('2026-10-01T00:00:00Z'),
  lastSeenAt: new Date(NOW - 30_000),
  battery: 80,
  charging: false,
  signalLevel: 3,
  sleeping: false,
  firmwareVersion: '1.0.0',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

describe('DevicesService：其余路径', () => {
  const tx = {
    device: { updateMany: jest.fn() },
    deviceBinding: { updateMany: jest.fn() },
  };
  const prisma = {
    device: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    deviceBinding: { findMany: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    $queryRaw: jest.fn(),
  };
  const svc = new DevicesService(
    prisma as unknown as PrismaService,
    new BindingScopeService(prisma as unknown as PrismaService),
  );

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest.clearAllMocks();
    prisma.device.findUnique.mockResolvedValue(device());
    prisma.device.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(device(data)),
    );
    prisma.deviceBinding.findMany.mockResolvedValue([
      { boundAt: new Date('2026-10-01T00:00:00Z'), unboundAt: null },
    ]);
    prisma.$queryRaw.mockResolvedValue([]);
  });
  afterEach(() => jest.useRealTimers());

  it('设备还没生成绑定码（null）：任何码都按错误拒绝', async () => {
    prisma.device.findUnique.mockResolvedValue(
      device({ bindCode: null, bindUserId: null }),
    );
    await expect(svc.bind('u1', 'helmet_001', '')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('listMine：按绑定时间倒序，带在线判定与绑定码', async () => {
    prisma.device.findMany.mockResolvedValue([
      device(),
      device({ deviceId: 'helmet_002', lastSeenAt: null }),
    ]);
    const list = await svc.listMine('u1');
    expect(prisma.device.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bindUserId: 'u1' },
        orderBy: { boundAt: 'desc' },
      }),
    );
    expect(list.map((d) => [d.deviceId, d.online, d.bindCode])).toEqual([
      ['helmet_001', true, '12345678'],
      ['helmet_002', false, '12345678'],
    ]);
    expect(list[0]).not.toHaveProperty('bindUserId');
  });

  describe('rename', () => {
    it.each([
      ['  新名字  ', '新名字'],
      ['   ', null],
      [null, null],
    ])('name=%p → 存 %p（空白 = 清除自定义名）', async (input, stored) => {
      const r = await svc.rename('u1', 'helmet_001', input);
      expect(prisma.device.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: 'helmet_001' },
          data: { name: stored },
        }),
      );
      expect(r.name).toBe(stored);
    });

    it('不是本人的设备：404，不写库', async () => {
      prisma.device.findUnique.mockResolvedValue(device({ bindUserId: 'u2' }));
      await expect(svc.rename('u1', 'helmet_001', 'x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.device.update).not.toHaveBeenCalled();
    });
  });

  describe('unbind / unbindAll', () => {
    it('默认自开事务：带归属条件清绑定与自定义名，关闭当前这段绑定历史', async () => {
      await svc.unbind('u1', 'helmet_001');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.device.updateMany).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001', bindUserId: 'u1' },
        data: { bindUserId: null, boundAt: null, name: null },
      });
      expect(tx.deviceBinding.updateMany).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001', userId: 'u1', unboundAt: null },
        data: { unboundAt: new Date(NOW) },
      });
    });

    it('传了调用方的事务客户端：直接用它，不再嵌套开事务', async () => {
      const outer = {
        device: {
          findUnique: jest.fn().mockResolvedValue(device()),
          updateMany: jest.fn(),
        },
        deviceBinding: { updateMany: jest.fn() },
      };
      await svc.unbind('u1', 'helmet_001', outer as never);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(outer.device.findUnique).toHaveBeenCalled();
      expect(outer.device.updateMany).toHaveBeenCalledTimes(1);
      expect(outer.deviceBinding.updateMany).toHaveBeenCalledTimes(1);
    });

    it('unbindAll：默认用自身 Prisma，逐台走 unbind；没有设备就什么都不做', async () => {
      prisma.device.findMany.mockResolvedValueOnce([
        { deviceId: 'helmet_001' },
        { deviceId: 'helmet_002' },
      ]);
      prisma.device.findUnique.mockImplementation(
        ({ where }: { where: { deviceId: string } }) =>
          Promise.resolve(device({ deviceId: where.deviceId })),
      );
      await svc.unbindAll('u1');
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(
        tx.device.updateMany.mock.calls.map(
          (c) => (c as [{ where: { deviceId: string } }])[0].where.deviceId,
        ),
      ).toEqual(['helmet_001', 'helmet_002']);
      jest.clearAllMocks();
      prisma.device.findMany.mockResolvedValueOnce([]);
      await svc.unbindAll('u1');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  it('status：在线判定服务端算；不归本人 404', async () => {
    await expect(svc.status('u1', 'helmet_001')).resolves.toEqual({
      online: true,
      lastSeenAt: new Date(NOW - 30_000),
      battery: 80,
      charging: false,
      signalLevel: 3,
      sleeping: false,
      firmwareVersion: '1.0.0',
    });
    prisma.device.findUnique.mockResolvedValue(null);
    await expect(svc.status('u1', 'helmet_001')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('batteryHistory', () => {
    it('没有绑定区间（数据异常）：直接返回空，不查库', async () => {
      prisma.deviceBinding.findMany.mockResolvedValue([]);
      await expect(svc.batteryHistory('u1', 'helmet_001', 24)).resolves.toEqual(
        {
          from: new Date(NOW - 24 * 3_600_000).toISOString(),
          to: new Date(NOW).toISOString(),
          points: [],
        },
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('行映射：毫秒转 ISO；charging 不是布尔（缺失 / 数字）按 null', async () => {
      prisma.deviceBinding.findMany.mockResolvedValue([
        {
          boundAt: new Date('2026-09-01T00:00:00Z'),
          unboundAt: new Date('2026-09-10T00:00:00Z'),
        },
        { boundAt: new Date('2026-10-01T00:00:00Z'), unboundAt: null },
      ]);
      prisma.$queryRaw.mockResolvedValue([
        { ts_ms: NOW - 600_000, battery: 81, charging: true },
        { ts_ms: NOW - 300_000, battery: 80, charging: null },
        { ts_ms: NOW, battery: 79, charging: 1 },
      ]);
      const r = await svc.batteryHistory('u1', 'helmet_001', 1);
      expect(r.points).toEqual([
        {
          timestamp: new Date(NOW - 600_000).toISOString(),
          battery: 81,
          charging: true,
        },
        {
          timestamp: new Date(NOW - 300_000).toISOString(),
          battery: 80,
          charging: null,
        },
        { timestamp: new Date(NOW).toISOString(), battery: 79, charging: null },
      ]);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      // 两段区间都进了 SQL 参数（已结束的那段带上下界）
      const params = (prisma.$queryRaw.mock.calls[0] as unknown[]).slice(1);
      const flat = JSON.stringify(params);
      expect(flat).toContain('2026-09-10T00:00:00.000Z');
      expect(flat).toContain('2026-10-01T00:00:00.000Z');
    });
  });
});
