// 管理后台服务（API.md §10）：LIKE 通配符转义、已注销账号默认不列、在线口径、事故归属用户批查、
// 设备详情、概览统计的「今日」= UTC+8 自然日、全量事件查询的类型白名单与 invalid 视图。
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminService } from './admin.service';

const NOW = Date.parse('2026-10-16T02:00:00Z'); // 北京时间 10:00

describe('AdminService', () => {
  const prisma = {
    user: { count: jest.fn(), findMany: jest.fn() },
    device: { count: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
    sosCase: { count: jest.fn(), findMany: jest.fn() },
    rawEvent: { count: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const svc = new AdminService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    for (const g of [
      prisma.user,
      prisma.device,
      prisma.sosCase,
      prisma.rawEvent,
    ])
      for (const fn of Object.values(g)) fn.mockReset();
    prisma.user.count.mockResolvedValue(0);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.device.count.mockResolvedValue(0);
    prisma.device.findMany.mockResolvedValue([]);
    prisma.sosCase.count.mockResolvedValue(0);
    prisma.sosCase.findMany.mockResolvedValue([]);
    prisma.rawEvent.count.mockResolvedValue(0);
    prisma.rawEvent.findMany.mockResolvedValue([]);
  });
  afterEach(() => jest.useRealTimers());

  const whereOf = (fn: jest.Mock) =>
    (fn.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;

  describe('listUsers', () => {
    it('默认排除已注销；关键词去空格并转义 LIKE 通配符（% _ \\），手机号精确包含、昵称不分大小写', async () => {
      await svc.listUsers(1, 20, '  50%_a\\b ');
      expect(whereOf(prisma.user.findMany)).toEqual({
        deletedAt: null,
        OR: [
          { phone: { contains: '50\\%\\_a\\\\b' } },
          { nickname: { contains: '50\\%\\_a\\\\b', mode: 'insensitive' } },
        ],
      });
    });

    it('includeDeleted=true：不加 deletedAt 条件；空白关键词等于不搜；带设备数', async () => {
      prisma.user.count.mockResolvedValue(1);
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'u1',
          phone: 'deleted:u1',
          nickname: null,
          avatarUrl: null,
          createdAt: new Date(NOW),
          deletedAt: new Date(NOW),
          _count: { devices: 2 },
        },
      ]);
      const r = await svc.listUsers(2, 10, '   ', true);
      expect(whereOf(prisma.user.findMany)).toEqual({});
      expect(r).toMatchObject({ total: 1, page: 2, pageSize: 10 });
      expect(r.items[0]).toMatchObject({ id: 'u1', deviceCount: 2 });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
    });
  });

  describe('listDevices', () => {
    it('online=true / false 两种筛选；关键词同时搜设备号与绑定人手机号；在线 = 90 秒内有心跳（ONLINE_WINDOW_MS）', async () => {
      await svc.listDevices(1, 20, 'helmet', true);
      const since = new Date(NOW - 90_000);
      expect(whereOf(prisma.device.findMany)).toEqual({
        AND: [
          {
            OR: [
              { deviceId: { contains: 'helmet', mode: 'insensitive' } },
              { bindUser: { phone: { contains: 'helmet' } } },
            ],
          },
          { lastSeenAt: { gte: since } },
        ],
      });
      prisma.device.findMany.mockClear();
      await svc.listDevices(1, 20, undefined, false);
      expect(whereOf(prisma.device.findMany)).toEqual({
        AND: [{ OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: since } }] }],
      });
      prisma.device.findMany.mockClear();
      await svc.listDevices(1, 20);
      expect(whereOf(prisma.device.findMany)).toEqual({});
    });

    it('行上的 online 按同一口径现算', async () => {
      prisma.device.findMany.mockResolvedValue([
        { deviceId: 'a', lastSeenAt: new Date(NOW - 60_000), bindUser: null },
        {
          deviceId: 'b',
          lastSeenAt: new Date(NOW - 10 * 60_000),
          bindUser: null,
        },
        { deviceId: 'c', lastSeenAt: null, bindUser: null },
      ]);
      const r = await svc.listDevices(1, 20);
      expect(r.items.map((d) => [d.deviceId, d.online])).toEqual([
        ['a', true],
        ['b', false],
        ['c', false],
      ]);
    });
  });

  describe('listAccidents', () => {
    const sos = (id: string, userId: string) => ({
      id,
      deviceId: 'helmet_001',
      userId,
      triggerEventId: 'e',
      triggerType: 'manual_sos',
      status: 'notified',
      deadline: new Date(NOW),
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      triggeredAt: null,
      latitude: null,
      longitude: null,
      coordinateSystem: null,
      accuracy: null,
      locationSource: null,
    });

    it('状态 / 设备筛选；归属用户去重批查；查不到的用户为 null', async () => {
      prisma.sosCase.findMany.mockResolvedValue([
        sos('s1', 'u1'),
        sos('s2', 'u1'),
        sos('s3', 'ghost'),
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u1', phone: '13800001111', nickname: '甲' },
      ]);
      const r = await svc.listAccidents(1, 20, 'notified', ' helmet_001 ');
      expect(whereOf(prisma.sosCase.findMany)).toEqual({
        status: 'notified',
        deviceId: 'helmet_001',
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['u1', 'ghost'] } },
        select: { id: true, phone: true, nickname: true },
      });
      expect(r.items.map((i) => i.user)).toEqual([
        { id: 'u1', phone: '13800001111', nickname: '甲' },
        { id: 'u1', phone: '13800001111', nickname: '甲' },
        null,
      ]);
    });

    it('没有记录：不查用户表；空白 deviceId 等于不筛', async () => {
      const r = await svc.listAccidents(1, 20, undefined, '  ');
      expect(whereOf(prisma.sosCase.findMany)).toEqual({});
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(r.items).toEqual([]);
    });
  });

  describe('getDeviceDetail', () => {
    it('不存在：404', async () => {
      prisma.device.findUnique.mockResolvedValue(null);
      await expect(svc.getDeviceDetail('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('带最近 10 条事件（含 _invalid、按到达时间倒序）与排查字段；没有设置时 settings={}', async () => {
      prisma.device.findUnique.mockResolvedValue({
        deviceId: 'helmet_001',
        lastSeenAt: new Date(NOW - 1000),
        settings: null,
        bindUser: null,
      });
      prisma.rawEvent.findMany.mockResolvedValue([
        {
          eventId: 'bad',
          deviceId: 'helmet_001',
          eventType: '_invalid',
          timestamp: new Date(NOW),
          receivedAt: new Date(NOW),
          payload: { reason: 'invalid_json' },
          source: 'mqtt',
          clockSkew: false,
          schemaVersion: 0,
        },
      ]);
      const d = await svc.getDeviceDetail('helmet_001');
      expect(prisma.rawEvent.findMany).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001' },
        orderBy: { receivedAt: 'desc' },
        take: 10,
      });
      expect(d).toMatchObject({ online: true, settings: {} });
      expect(d.recentEvents[0]).toMatchObject({
        eventType: '_invalid',
        summary: '_invalid',
        source: 'mqtt',
        clockSkew: false,
      });
    });
  });

  describe('statsOverview', () => {
    it('「今日」按 UTC+8 自然日起算（北京时间 00:00 = UTC 前一天 16:00）；事件数不含 _invalid', async () => {
      prisma.device.count.mockResolvedValueOnce(9).mockResolvedValueOnce(3);
      prisma.user.count.mockResolvedValue(4);
      prisma.rawEvent.count.mockResolvedValue(120);
      prisma.sosCase.count.mockResolvedValue(1);
      await expect(svc.statsOverview()).resolves.toEqual({
        deviceTotal: 9,
        deviceOnline: 3,
        userTotal: 4,
        todayEvents: 120,
        activeSos: 1,
        generatedAt: new Date(NOW).toISOString(),
      });
      expect(prisma.rawEvent.count).toHaveBeenCalledWith({
        where: {
          receivedAt: { gte: new Date('2026-10-15T16:00:00Z') },
          eventType: { not: '_invalid' },
        },
      });
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: { deletedAt: null },
      });
    });

    it('UTC 15:59（北京 23:59）与 16:00（北京次日 00:00）分属两天', async () => {
      jest.setSystemTime(Date.parse('2026-10-16T15:59:00Z'));
      await svc.statsOverview();
      expect(whereOf(prisma.rawEvent.count)).toMatchObject({
        receivedAt: { gte: new Date('2026-10-15T16:00:00Z') },
      });
      prisma.rawEvent.count.mockClear();
      jest.setSystemTime(Date.parse('2026-10-16T16:00:00Z'));
      await svc.statsOverview();
      expect(whereOf(prisma.rawEvent.count)).toMatchObject({
        receivedAt: { gte: new Date('2026-10-16T16:00:00Z') },
      });
    });
  });

  describe('listEvents', () => {
    it('默认排除 _invalid；type 白名单；deviceId 去空格；时间单边也生效；按到达时间倒序', async () => {
      await svc.listEvents(1, 20, {
        type: 'possible_fall, manual_sos',
        deviceId: ' helmet_001 ',
        from: '2026-10-16T00:00:00Z',
      });
      expect(whereOf(prisma.rawEvent.findMany)).toEqual({
        deviceId: 'helmet_001',
        eventType: { in: ['possible_fall', 'manual_sos'] },
        timestamp: { gte: new Date('2026-10-16T00:00:00Z') },
      });
      expect(prisma.rawEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('invalid=true：只看 _invalid（type 被忽略）；都不给时排除 _invalid、无时间条件', async () => {
      await svc.listEvents(1, 20, {
        invalid: true,
        type: 'possible_fall',
        to: '2026-10-16T00:00:00Z',
      });
      expect(whereOf(prisma.rawEvent.findMany)).toEqual({
        eventType: '_invalid',
        timestamp: { lte: new Date('2026-10-16T00:00:00Z') },
      });
      prisma.rawEvent.findMany.mockClear();
      await svc.listEvents(1, 20, { type: ' , ' });
      expect(whereOf(prisma.rawEvent.findMany)).toEqual({
        eventType: { not: '_invalid' },
      });
    });

    it('未知类型：400 点名', async () => {
      const err = await svc
        .listEvents(1, 20, { type: 'bogus' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        code: 'VALIDATION_FAILED',
        message: '未知事件类型：bogus',
      });
    });

    it('行上带排查字段（source / clockSkew / schemaVersion）与 summary', async () => {
      prisma.rawEvent.findMany.mockResolvedValue([
        {
          eventId: 'e1',
          deviceId: 'helmet_001',
          eventType: 'manual_sos',
          timestamp: new Date(NOW),
          receivedAt: new Date(NOW),
          payload: {},
          source: 'app_relay',
          clockSkew: true,
          schemaVersion: 1,
        },
      ]);
      const r = await svc.listEvents(1, 20, {});
      expect(r.items[0]).toMatchObject({
        summary: '手动求救',
        source: 'app_relay',
        clockSkew: true,
        schemaVersion: 1,
      });
    });
  });
});
