// 事件查询服务（API.md §6）：类型白名单、时间窗、_invalid 隔离、绑定区间（决策 #39）、详情归属与关联媒体。
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EVENT_TYPES } from '@helmet/shared';
import { BindingScopeService } from '../devices/binding-scope.service';
import type { PrismaService } from '../prisma/prisma.service';
import { EventsService } from './events.service';

const ev = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  eventId: 'e1',
  deviceId: 'helmet_001',
  eventType: 'collision_risk',
  schemaVersion: 1,
  timestamp: new Date('2026-10-16T00:00:00Z'),
  receivedAt: new Date('2026-10-16T00:00:01Z'),
  businessTime: new Date('2026-10-16T00:00:00Z'),
  payload: { riskLevel: 'high' },
  ...over,
});

describe('EventsService', () => {
  const prisma = {
    device: { findUnique: jest.fn(), findMany: jest.fn() },
    deviceBinding: { findMany: jest.fn() },
    rawEvent: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    media: { findMany: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const scope = new BindingScopeService(prisma as unknown as PrismaService);
  const svc = new EventsService(prisma as unknown as PrismaService, scope);
  const bound = [
    { boundAt: new Date('2026-10-01T00:00:00Z'), unboundAt: null },
  ];

  beforeEach(() => {
    for (const g of [
      prisma.device,
      prisma.deviceBinding,
      prisma.rawEvent,
      prisma.media,
    ])
      for (const fn of Object.values(g)) fn.mockReset();
    prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u1' });
    prisma.deviceBinding.findMany.mockResolvedValue(bound);
    prisma.rawEvent.count.mockResolvedValue(0);
    prisma.rawEvent.findMany.mockResolvedValue([]);
  });

  const listWhere = () =>
    (
      prisma.rawEvent.findMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ]
    )[0].where;

  describe('list', () => {
    it('不带筛选：只列已知类型（也就排除了 _invalid）与受支持的结构版本，按绑定区间过滤，不带时间条件；最新在前 + id 兜底排序', async () => {
      prisma.rawEvent.count.mockResolvedValue(1);
      prisma.rawEvent.findMany.mockResolvedValue([ev()]);
      const res = await svc.list('u1', 'helmet_001', { page: 2, pageSize: 5 });
      expect(res).toMatchObject({ total: 1, page: 2, pageSize: 5 });
      expect(res.items[0]).toMatchObject({
        eventId: 'e1',
        summary: '碰撞风险 high',
      });
      expect(listWhere()).toEqual({
        deviceId: 'helmet_001',
        eventType: { in: [...EVENT_TYPES] },
        schemaVersion: { in: [1] },
        AND: [{ OR: [{ receivedAt: { gte: bound[0].boundAt } }] }],
      });
      expect(prisma.rawEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ businessTime: 'desc' }, { id: 'desc' }],
          skip: 5,
          take: 5,
        }),
      );
    });

    it('type 多值逗号分隔（容忍空格和空项）', async () => {
      await svc.list('u1', 'helmet_001', {
        type: ' possible_fall , ,manual_sos,',
        page: 1,
        pageSize: 20,
      });
      expect(listWhere().eventType).toEqual({
        in: ['possible_fall', 'manual_sos'],
      });
    });

    it.each([['   '], [',,']])('type=%p 等于没筛', async (type) => {
      await svc.list('u1', 'helmet_001', { type, page: 1, pageSize: 20 });
      expect(listWhere().eventType).toEqual({ in: [...EVENT_TYPES] });
    });

    it('type 含未知值（含 _invalid）：400 并点名', async () => {
      const err = await svc
        .list('u1', 'helmet_001', {
          type: 'possible_fall,_invalid,bogus',
          page: 1,
          pageSize: 20,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        code: 'VALIDATION_FAILED',
        message: '未知事件类型：_invalid, bogus',
      });
    });

    it('只给 from / 只给 to：单边时间条件', async () => {
      await svc.list('u1', 'helmet_001', {
        from: '2026-10-15T00:00:00Z',
        page: 1,
        pageSize: 20,
      });
      // 时间窗按业务时间（决策 #59），不按设备自报时间
      expect(listWhere().businessTime).toEqual({
        gte: new Date('2026-10-15T00:00:00Z'),
      });
      expect(listWhere().timestamp).toBeUndefined();
      prisma.rawEvent.findMany.mockClear();
      await svc.list('u1', 'helmet_001', {
        to: '2026-10-16T00:00:00Z',
        page: 1,
        pageSize: 20,
      });
      expect(listWhere().businessTime).toEqual({
        lte: new Date('2026-10-16T00:00:00Z'),
      });
    });

    it('from ≥ to：400「from 必须早于 to」', async () => {
      await expect(
        svc.list('u1', 'helmet_001', {
          from: '2026-10-16T00:00:00Z',
          to: '2026-10-16T00:00:00Z',
          page: 1,
          pageSize: 20,
        }),
      ).rejects.toMatchObject({ response: { message: 'from 必须早于 to' } });
    });

    it('没有绑定区间（数据异常）：where 片段匹配不到任何行', async () => {
      prisma.deviceBinding.findMany.mockResolvedValue([]);
      await svc.list('u1', 'helmet_001', { page: 1, pageSize: 20 });
      expect(listWhere().AND).toEqual([
        { OR: [{ receivedAt: { lt: new Date(0) } }] },
      ]);
    });

    it('设备不归本人：404，不查事件', async () => {
      prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u2' });
      await expect(
        svc.list('u1', 'helmet_001', { page: 1, pageSize: 20 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.rawEvent.count).not.toHaveBeenCalled();
    });
  });

  describe('detail', () => {
    beforeEach(() => {
      prisma.device.findMany.mockResolvedValue([{ deviceId: 'helmet_001' }]);
      prisma.media.findMany.mockResolvedValue([]);
    });

    it('名下没有设备：直接 404，不查事件', async () => {
      prisma.device.findMany.mockResolvedValue([]);
      await expect(svc.detail('u1', 'e1')).rejects.toMatchObject({
        response: { code: 'NOT_FOUND', message: '事件不存在' },
      });
      expect(prisma.rawEvent.findFirst).not.toHaveBeenCalled();
    });

    it('只在本人当前绑定的设备里按 eventId 找（eventId 只在设备内唯一）；已知类型 + 受支持版本在查询里过滤；最近到达的在前', async () => {
      prisma.device.findMany.mockResolvedValue([
        { deviceId: 'helmet_001' },
        { deviceId: 'helmet_002' },
      ]);
      prisma.rawEvent.findMany.mockResolvedValue([ev()]);
      await svc.detail('u1', 'e1');
      expect(prisma.rawEvent.findMany).toHaveBeenCalledWith({
        where: {
          eventId: 'e1',
          deviceId: { in: ['helmet_001', 'helmet_002'] },
          eventType: { in: [...EVENT_TYPES] },
          schemaVersion: { in: [1] },
        },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      });
    });

    it('找不到（含 _invalid / 未知类型 / 未知版本，已在查询里排除）：404', async () => {
      prisma.rawEvent.findMany.mockResolvedValue([]);
      await expect(svc.detail('u1', 'e1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('事件到达时间不在本人绑定区间内（前主期间的事件）：404', async () => {
      prisma.rawEvent.findMany.mockResolvedValue([
        ev({ receivedAt: new Date('2026-09-01T00:00:00Z') }),
      ]);
      await expect(svc.detail('u1', 'e1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.media.findMany).not.toHaveBeenCalled();
    });

    it('两台设备上各有一条同号事件，先查到的那条在前主人期间：接着看下一条，返回本人看得到的（原来 404，10-17 评审 R4-4）', async () => {
      prisma.device.findMany.mockResolvedValue([
        { deviceId: 'helmet_001' },
        { deviceId: 'helmet_002' },
      ]);
      prisma.rawEvent.findMany.mockResolvedValue([
        ev({
          deviceId: 'helmet_002',
          receivedAt: new Date('2026-09-01T00:00:00Z'),
        }),
        ev({ deviceId: 'helmet_001' }),
      ]);
      prisma.media.findMany.mockResolvedValue([]);
      await expect(svc.detail('u1', 'e1')).resolves.toMatchObject({
        eventId: 'e1',
        deviceId: 'helmet_001',
      });
    });

    it('关联媒体：限定同一设备，按 relatedEventId 或自身 eventId 反查，只露 mediaId / status / duration', async () => {
      prisma.rawEvent.findMany.mockResolvedValue([ev()]);
      prisma.media.findMany.mockResolvedValue([
        { id: 'm1', status: 'ready', duration: 12, storageKey: 'secret/key' },
      ]);
      const d = await svc.detail('u1', 'e1');
      expect(prisma.media.findMany).toHaveBeenCalledWith({
        where: {
          deviceId: 'helmet_001',
          OR: [{ relatedEventId: 'e1' }, { eventId: 'e1' }],
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(d.media).toEqual([
        { mediaId: 'm1', status: 'ready', duration: 12 },
      ]);
      expect(d.payload).toEqual({ riskLevel: 'high' });
    });
  });
});
