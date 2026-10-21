// SOS 对外接口的服务层（API.md §7）：进行中查询、取消 / SOS Now 的终态竞态、事故列表与详情的归属。
// 状态机的条件更新只在这里断言「没抢到就 409」——真实竞态在 e2e（sos-delivery-race 等）。
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimePushService } from '../realtime/realtime-push.service';
import type { SosNotifierService } from './sos-notifier.service';
import { SosService } from './sos.service';

const sosRow = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  deviceId: 'helmet_001',
  userId: 'u1',
  triggerEventId: 'e1',
  triggerType: 'possible_fall',
  status: 'pending',
  deadline: new Date('2026-10-16T00:01:00Z'),
  createdAt: new Date('2026-10-16T00:00:00Z'),
  updatedAt: new Date('2026-10-16T00:00:00Z'),
  finalizedAt: null,
  triggeredAt: null,
  latitude: null,
  longitude: null,
  coordinateSystem: null,
  accuracy: null,
  locationSource: null,
  ...over,
});

describe('SosService', () => {
  const prisma = {
    device: { findUnique: jest.fn(), findMany: jest.fn() },
    sosCase: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    rawEvent: { findUnique: jest.fn() },
    sosNotification: { findMany: jest.fn() },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const notifier = { finalizeNotified: jest.fn() };
  const realtime = { pushSosUpdate: jest.fn() };
  let svc: SosService;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const g of [
      prisma.device,
      prisma.sosCase,
      prisma.rawEvent,
      prisma.sosNotification,
    ])
      for (const fn of Object.values(g)) fn.mockReset();
    prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u1' });
    svc = new SosService(
      prisma as unknown as PrismaService,
      notifier as unknown as SosNotifierService,
      realtime as unknown as RealtimePushService,
    );
  });

  describe('active', () => {
    it('有进行中的单：返回线上格式；没有：sos=null（200）', async () => {
      prisma.sosCase.findFirst.mockResolvedValueOnce(sosRow());
      await expect(svc.active('u1', 'helmet_001')).resolves.toMatchObject({
        sos: { sosId: 's1', status: 'pending' },
      });
      expect(prisma.sosCase.findFirst).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001', userId: 'u1', status: 'pending' },
      });
      prisma.sosCase.findFirst.mockResolvedValueOnce(null);
      await expect(svc.active('u1', 'helmet_001')).resolves.toEqual({
        sos: null,
      });
    });

    it('设备不归本人：404，不查 SOS', async () => {
      prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u2' });
      await expect(svc.active('u1', 'helmet_001')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.sosCase.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('activeForUser（账号级进行中列表，B 线第 12 项）', () => {
    it('按本人 + pending 查（不按设备归属，解绑后的单照样列），按到期先后、单号兜底排序，统一分页', async () => {
      prisma.sosCase.count.mockResolvedValue(3);
      prisma.sosCase.findMany.mockResolvedValue([
        sosRow({ id: 's1', deviceId: 'h1' }),
        sosRow({ id: 's2', deviceId: 'h2' }),
      ]);
      prisma.device.findMany.mockResolvedValue([
        { deviceId: 'h1', name: '通勤' },
      ]);
      const res = await svc.activeForUser('u1', 2, 2);
      const where = { userId: 'u1', status: 'pending' };
      expect(prisma.sosCase.count).toHaveBeenCalledWith({ where });
      expect(prisma.sosCase.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
        skip: 2,
        take: 2,
      });
      expect(prisma.device.findUnique).not.toHaveBeenCalled();
      expect(res).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(res.items.map((i) => [i.sosId, i.deviceName])).toEqual([
        ['s1', '通勤'],
        ['s2', null],
      ]);
      expect(res.items[0]).toMatchObject({
        status: 'pending',
        deadline: '2026-10-16T00:01:00.000Z',
      });
    });

    it('头盔名只取仍绑在本人名下的（转手后新主人起的名字不给前主人）；同一顶只查一次；名字整理后为空给 null', async () => {
      prisma.sosCase.count.mockResolvedValue(2);
      prisma.sosCase.findMany.mockResolvedValue([
        sosRow({ id: 's1', deviceId: 'h1' }),
        sosRow({ id: 's2', deviceId: 'h1' }),
      ]);
      prisma.device.findMany.mockResolvedValue([
        { deviceId: 'h1', name: '\u200b\n' },
      ]);
      const res = await svc.activeForUser('u1', 1, 100);
      expect(prisma.device.findMany).toHaveBeenCalledWith({
        where: { deviceId: { in: ['h1'] }, bindUserId: 'u1' },
        select: { deviceId: true, name: true },
      });
      expect(res.items.map((i) => i.deviceName)).toEqual([null, null]);
    });

    it('一单都没有：items 为空数组，不查头盔名', async () => {
      prisma.sosCase.count.mockResolvedValue(0);
      prisma.sosCase.findMany.mockResolvedValue([]);
      await expect(svc.activeForUser('u1', 1, 100)).resolves.toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 100,
      });
      expect(prisma.device.findMany).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('pending → cancelled：条件更新抢到后推 WS 并返回最新状态', async () => {
      prisma.sosCase.findUnique.mockResolvedValue(sosRow());
      prisma.sosCase.updateMany.mockResolvedValue({ count: 1 });
      prisma.sosCase.findUniqueOrThrow.mockResolvedValue(
        sosRow({ status: 'cancelled' }),
      );
      await expect(svc.cancel('u1', 's1')).resolves.toMatchObject({
        status: 'cancelled',
      });
      expect(prisma.sosCase.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', status: 'pending' },
        data: { status: 'cancelled', finalizedAt: expect.any(Date) },
      });
      expect(realtime.pushSosUpdate).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ status: 'cancelled' }),
      );
    });

    it('读到已是终态：409 SOS_ALREADY_FINALIZED，不写库', async () => {
      prisma.sosCase.findUnique.mockResolvedValue(
        sosRow({ status: 'notified' }),
      );
      const err = await svc.cancel('u1', 's1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'SOS_ALREADY_FINALIZED',
      });
      expect(prisma.sosCase.updateMany).not.toHaveBeenCalled();
    });

    it('读到 pending 但条件更新没抢到（扫描刚通知）：409，不推 WS', async () => {
      prisma.sosCase.findUnique.mockResolvedValue(sosRow());
      prisma.sosCase.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.cancel('u1', 's1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(realtime.pushSosUpdate).not.toHaveBeenCalled();
    });

    it.each([
      ['单不存在', null],
      ['不是本人的单（换绑后的新主）', sosRow({ userId: 'u2' })],
    ])('%s：404', async (_n, row) => {
      prisma.sosCase.findUnique.mockResolvedValue(row);
      await expect(svc.cancel('u1', 's1')).rejects.toMatchObject({
        status: 404,
        response: { code: 'NOT_FOUND', message: 'SOS 不存在' },
      });
    });
  });

  describe('confirm（SOS Now）', () => {
    it('pending：交给通知器终态化，抢到后返回 notified', async () => {
      prisma.sosCase.findUnique.mockResolvedValue(sosRow());
      notifier.finalizeNotified.mockResolvedValue(true);
      prisma.sosCase.findUniqueOrThrow.mockResolvedValue(
        sosRow({ status: 'notified' }),
      );
      await expect(svc.confirm('u1', 's1')).resolves.toMatchObject({
        status: 'notified',
      });
      expect(notifier.finalizeNotified).toHaveBeenCalledWith('s1', {
        deliverInline: 'background',
      });
    });

    it('通知器没抢到（被取消或到期扫描抢先）：409', async () => {
      prisma.sosCase.findUnique.mockResolvedValue(sosRow());
      notifier.finalizeNotified.mockResolvedValue(false);
      await expect(svc.confirm('u1', 's1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('已取消的单：409，不进通知器', async () => {
      prisma.sosCase.findUnique.mockResolvedValue(
        sosRow({ status: 'cancelled' }),
      );
      await expect(svc.confirm('u1', 's1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(notifier.finalizeNotified).not.toHaveBeenCalled();
    });
  });

  describe('accidents / accidentDetail', () => {
    it('列表：按设备 + 用户双过滤、最新在前、按页跳过', async () => {
      prisma.sosCase.count.mockResolvedValue(25);
      prisma.sosCase.findMany.mockResolvedValue([sosRow()]);
      const res = await svc.accidents('u1', 'helmet_001', 3, 10);
      expect(res).toMatchObject({ total: 25, page: 3, pageSize: 10 });
      expect(res.items[0]).toMatchObject({ sosId: 's1', location: null });
      expect(prisma.sosCase.findMany).toHaveBeenCalledWith({
        where: { deviceId: 'helmet_001', userId: 'u1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 10,
      });
    });

    it('详情：带触发事件原始 payload 与通知记录（手机号打码）', async () => {
      prisma.sosCase.findUnique.mockResolvedValue(sosRow());
      prisma.rawEvent.findUnique.mockResolvedValue({
        payload: { confidence: 0.92 },
      });
      prisma.sosNotification.findMany.mockResolvedValue([
        {
          id: 'n1',
          channel: 'sms',
          target: '13800001111',
          contactName: '妈',
          status: 'sent',
          attempts: 1,
          lastError: null,
          sentAt: new Date('2026-10-16T00:02:00Z'),
          createdAt: new Date('2026-10-16T00:01:00Z'),
        },
      ]);
      const d = await svc.accidentDetail('u1', 's1');
      expect(d.triggerPayload).toEqual({ confidence: 0.92 });
      expect(d.notifications[0].target).toBe('138****1111');
      expect(prisma.rawEvent.findUnique).toHaveBeenCalledWith({
        where: {
          deviceId_eventId: { deviceId: 'helmet_001', eventId: 'e1' },
        },
        select: { payload: true },
      });
    });

    it('详情：原始事件已不在（被清理）→ triggerPayload=null', async () => {
      prisma.sosCase.findUnique.mockResolvedValue(sosRow());
      prisma.rawEvent.findUnique.mockResolvedValue(null);
      prisma.sosNotification.findMany.mockResolvedValue([]);
      await expect(svc.accidentDetail('u1', 's1')).resolves.toMatchObject({
        triggerPayload: null,
        notifications: [],
      });
    });

    it('详情：不是本人的 / 不存在：404「事故记录不存在」', async () => {
      prisma.sosCase.findUnique.mockResolvedValue(sosRow({ userId: 'u9' }));
      await expect(svc.accidentDetail('u1', 's1')).rejects.toMatchObject({
        response: { message: '事故记录不存在' },
      });
      prisma.sosCase.findUnique.mockResolvedValue(null);
      await expect(svc.accidentDetail('u1', 's1')).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
