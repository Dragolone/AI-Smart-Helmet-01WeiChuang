// SOS 后台扫描的调度骨架：启动接管、两阶段互不阻塞、各自防重入、关停等在飞投递（有上界）、对账翻页与跳过规则。
// Prisma / 通知器 / 触发器全部 mock，时钟用 fake timers。
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { SosNotifierService } from './sos-notifier.service';
import { SosSchedulerService } from './sos-scheduler.service';
import type { SosTriggerService } from './sos-trigger.service';

const SOS_ENV = [
  'SOS_SCAN_INTERVAL_MS',
  'SOS_NOTIFY_TIMEOUT_MS',
  'SOS_RECONCILE_INTERVAL_SECONDS',
  'SOS_RECONCILE_WINDOW_MINUTES',
  'SOS_RECONCILE_GRACE_MS',
  'SOS_RECONCILE_STARTUP_WINDOW_HOURS',
];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const rawRow = (
  id: string,
  over: Partial<{
    eventId: string;
    deviceId: string;
    eventType: string;
    payload: unknown;
  }> = {},
) => ({
  id,
  eventId: over.eventId ?? `e-${id}`,
  deviceId: over.deviceId ?? 'helmet_001',
  eventType: over.eventType ?? 'possible_fall',
  timestamp: new Date('2026-10-16T00:00:00Z'),
  receivedAt: new Date('2026-10-16T00:00:01Z'),
  schemaVersion: 1,
  firmwareVersion: '1.0.0',
  payload: 'payload' in over ? over.payload : { confidence: 0.9 },
});

describe('SosSchedulerService', () => {
  const saved: Record<string, string | undefined> = {};
  const prisma = {
    sosCase: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    rawEvent: { findMany: jest.fn() },
    deviceBinding: { findFirst: jest.fn() },
  };
  const notifier = {
    finalizeNotified: jest.fn(),
    failInterrupted: jest.fn(),
    deliverPending: jest.fn(),
    backgroundDelivery: jest.fn(),
  };
  const trigger = { handleTrigger: jest.fn() };
  let svc: SosSchedulerService;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    for (const k of SOS_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    for (const group of [prisma.sosCase, prisma.rawEvent, prisma.deviceBinding])
      for (const fn of Object.values(group)) fn.mockReset();
    for (const fn of [...Object.values(notifier), trigger.handleTrigger])
      fn.mockReset();
    prisma.sosCase.count.mockResolvedValue(0);
    prisma.sosCase.findMany.mockResolvedValue([]);
    prisma.sosCase.findFirst.mockResolvedValue(null);
    prisma.rawEvent.findMany.mockResolvedValue([]);
    prisma.deviceBinding.findFirst.mockResolvedValue(null);
    notifier.finalizeNotified.mockResolvedValue(undefined);
    notifier.failInterrupted.mockResolvedValue(undefined);
    notifier.deliverPending.mockResolvedValue(undefined);
    notifier.backgroundDelivery.mockReturnValue(null);
    trigger.handleTrigger.mockResolvedValue(undefined);
    svc = new SosSchedulerService(
      prisma as unknown as PrismaService,
      notifier as unknown as SosNotifierService,
      trigger as unknown as SosTriggerService,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(async () => {
    await svc.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const k of SOS_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('启动与定时器', () => {
    it('库里有进行中的单：启动时告警接管数量', async () => {
      prisma.sosCase.count.mockResolvedValue(3);
      await svc.onModuleInit();
      expect(prisma.sosCase.count).toHaveBeenCalledWith({
        where: { status: 'pending' },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '启动接管：3 个进行中 SOS 重新纳入调度',
      );
    });

    it('没有进行中的单：不告警', async () => {
      await svc.onModuleInit();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('启动接管'),
      );
    });

    it('启动立即对账一次（回看 48 小时），之后扫描按 5 秒、对账按 60 秒周期跑', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-16T12:00:00Z') });
      await svc.onModuleInit();
      await flush();
      expect(prisma.rawEvent.findMany).toHaveBeenCalledTimes(1);
      const where = (
        prisma.rawEvent.findMany.mock.calls[0] as [
          { where: { receivedAt: { gte: Date; lte: Date } } },
        ]
      )[0].where;
      expect(where.receivedAt.gte).toEqual(new Date('2026-10-14T12:00:00Z'));
      expect(where.receivedAt.lte).toEqual(new Date('2026-10-16T11:59:57Z'));

      await jest.advanceTimersByTimeAsync(5_000);
      expect(notifier.failInterrupted).toHaveBeenCalledTimes(1);
      expect(notifier.deliverPending).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(55_000);
      expect(notifier.deliverPending).toHaveBeenCalledTimes(12);
      // 周期对账回看 15 分钟
      expect(prisma.rawEvent.findMany).toHaveBeenCalledTimes(2);
      const periodic = (
        prisma.rawEvent.findMany.mock.calls[1] as [
          { where: { receivedAt: { gte: Date } } },
        ]
      )[0].where;
      expect(periodic.receivedAt.gte).toEqual(new Date('2026-10-16T11:46:00Z'));
    });

    it('关停后定时器全部停掉', async () => {
      jest.useFakeTimers();
      await svc.onModuleInit();
      await svc.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(notifier.deliverPending).not.toHaveBeenCalled();
      expect(prisma.rawEvent.findMany).toHaveBeenCalledTimes(1); // 只有启动那一次
    });

    it('从没启动过也能安全关停', async () => {
      await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('关停时等在飞投递', () => {
    it('投递还在跑：关停等它写完结果再返回', async () => {
      const d = deferred<void>();
      notifier.deliverPending.mockReturnValue(d.promise);
      const tick = svc.tick();
      await flush();
      let closed = false;
      const closing = svc.onModuleDestroy().then(() => {
        closed = true;
      });
      await flush();
      expect(closed).toBe(false);
      d.resolve();
      await closing;
      await tick;
      expect(closed).toBe(true);
    });

    it('「立即求救」放到后台的首投还在跑：关停也等它写完结果', async () => {
      const d = deferred<void>();
      notifier.backgroundDelivery.mockReturnValue(d.promise);
      let closed = false;
      const closing = svc.onModuleDestroy().then(() => {
        closed = true;
      });
      await flush();
      expect(closed).toBe(false);
      d.resolve();
      await closing;
      expect(closed).toBe(true);
    });

    it('投递一直挂着：最多等 SOS_NOTIFY_TIMEOUT_MS 就放手（不无限拖住关停）', async () => {
      jest.useFakeTimers();
      process.env.SOS_NOTIFY_TIMEOUT_MS = '2000';
      notifier.deliverPending.mockReturnValue(new Promise(() => {}));
      void svc.tick();
      await flush();
      let closed = false;
      const closing = svc.onModuleDestroy().then(() => {
        closed = true;
      });
      await jest.advanceTimersByTimeAsync(1_999);
      expect(closed).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await closing;
      expect(closed).toBe(true);
      // 那一轮投递永远不会结束：换个干净实例给 afterEach 关停，免得再等一次
      svc = new SosSchedulerService(
        prisma as unknown as PrismaService,
        notifier as unknown as SosNotifierService,
        trigger as unknown as SosTriggerService,
      );
    });
  });

  describe('tick：两阶段各自防重入、失败不连坐', () => {
    it('到期扫描：逐个终态化（不在扫描里等投递），按 deadline 升序最多 50 条', async () => {
      prisma.sosCase.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      await svc.tick();
      expect(prisma.sosCase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'pending' }),
          orderBy: { deadline: 'asc' },
          take: 50,
        }),
      );
      expect(notifier.finalizeNotified.mock.calls).toEqual([
        ['s1', { deliverInline: false }],
        ['s2', { deliverInline: false }],
      ]);
    });

    it('到期扫描查库失败：记 error，投递阶段照常进行', async () => {
      prisma.sosCase.findMany.mockRejectedValue(new Error('db gone'));
      await svc.tick();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'SOS 到期扫描失败（下一轮继续）：Error: db gone',
        ),
      );
      expect(notifier.deliverPending).toHaveBeenCalledTimes(1);
    });

    it('投递阶段失败：记 error，下一轮还能再进（防重入标记被复位）', async () => {
      notifier.failInterrupted.mockRejectedValueOnce(new Error('lock'));
      await svc.tick();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'SOS 通知投递轮次失败（下一轮继续）：Error: lock',
        ),
      );
      expect(notifier.deliverPending).not.toHaveBeenCalled();
      await svc.tick();
      expect(notifier.deliverPending).toHaveBeenCalledTimes(1);
    });

    it('投递被一条慢短信拖住：下一轮的到期终态化照常跑，投递不重入', async () => {
      const d = deferred<void>();
      notifier.deliverPending.mockReturnValueOnce(d.promise);
      prisma.sosCase.findMany.mockResolvedValue([{ id: 's1' }]);
      const first = svc.tick();
      await flush();
      await svc.tick();
      expect(notifier.finalizeNotified).toHaveBeenCalledTimes(2);
      expect(notifier.deliverPending).toHaveBeenCalledTimes(1);
      d.resolve();
      await first;
    });

    it('到期扫描本身卡住：并发的第二轮跳过扫描', async () => {
      const d = deferred<Array<{ id: string }>>();
      prisma.sosCase.findMany.mockReturnValueOnce(d.promise);
      const first = svc.tick();
      await flush();
      await svc.tick();
      expect(prisma.sosCase.findMany).toHaveBeenCalledTimes(1);
      d.resolve([]);
      await first;
    });
  });

  describe('对账调度', () => {
    it('上一轮对账没跑完：周期触发直接跳过（不并发翻 raw_events）', async () => {
      jest.useFakeTimers();
      const d = deferred<unknown[]>();
      prisma.rawEvent.findMany.mockReturnValueOnce(d.promise);
      await svc.onModuleInit();
      await jest.advanceTimersByTimeAsync(180_000);
      expect(prisma.rawEvent.findMany).toHaveBeenCalledTimes(1);
      d.resolve([]);
      await flush();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(prisma.rawEvent.findMany).toHaveBeenCalledTimes(2);
    });

    it('对账失败：只记 error，点名是启动还是周期那一轮', async () => {
      jest.useFakeTimers();
      prisma.rawEvent.findMany.mockRejectedValue(new Error('timeout'));
      await svc.onModuleInit();
      await flush();
      expect(errorSpy).toHaveBeenCalledWith(
        '启动对账失败（不影响调度，下一轮继续）：timeout',
      );
      await jest.advanceTimersByTimeAsync(60_000);
      expect(errorSpy).toHaveBeenCalledWith(
        '周期对账失败（不影响调度，下一轮继续）：timeout',
      );
    });
  });

  describe('reconcileLostTriggers', () => {
    it('已有 SOS 单的跳过；当时无绑定的跳过；已并入进行中单的跳过；其余按当时绑定用户补建', async () => {
      const rows = [
        rawRow('r1'), // 已建单
        rawRow('r2'), // 无绑定
        rawRow('r3'), // 并入
        rawRow('r4', { payload: null }), // 丢单，payload 为空
      ];
      prisma.rawEvent.findMany.mockResolvedValueOnce(rows);
      prisma.sosCase.findMany.mockResolvedValueOnce([
        { deviceId: 'helmet_001', triggerEventId: 'e-r1' },
      ]);
      prisma.deviceBinding.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ userId: 'u1' })
        .mockResolvedValueOnce({ userId: 'u1' });
      prisma.sosCase.findFirst
        .mockResolvedValueOnce({ id: 'merged' })
        .mockResolvedValueOnce(null);

      await expect(svc.reconcileLostTriggers(60_000)).resolves.toBe(1);
      expect(trigger.handleTrigger).toHaveBeenCalledTimes(1);
      expect(trigger.handleTrigger).toHaveBeenCalledWith(
        {
          schemaVersion: 1,
          eventId: 'e-r4',
          deviceId: 'helmet_001',
          eventType: 'possible_fall',
          timestamp: new Date('2026-10-16T00:00:00Z'),
          firmwareVersion: '1.0.0',
          payload: {},
        },
        'u1',
      );
      expect(warnSpy).toHaveBeenCalledWith('SOS 对账补建 1 单');
    });

    it('同一 eventId 在别的设备上已有单：不算本设备已建单（按 deviceId + eventId 成对比对）', async () => {
      prisma.rawEvent.findMany.mockResolvedValueOnce([
        rawRow('r1', { eventId: 'seq-7', deviceId: 'helmet_A' }),
      ]);
      prisma.sosCase.findMany.mockResolvedValueOnce([
        { deviceId: 'helmet_B', triggerEventId: 'seq-7' },
      ]);
      prisma.deviceBinding.findFirst.mockResolvedValueOnce({ userId: 'u9' });
      await expect(svc.reconcileLostTriggers(60_000)).resolves.toBe(1);
      expect(trigger.handleTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'helmet_A', eventId: 'seq-7' }),
        'u9',
      );
    });

    it('manual_sos 查并入对象时排除已取消的单；possible_fall 不排除', async () => {
      prisma.rawEvent.findMany.mockResolvedValueOnce([
        rawRow('m1', { eventType: 'manual_sos' }),
        rawRow('f1', { eventType: 'possible_fall' }),
      ]);
      prisma.sosCase.findMany.mockResolvedValueOnce([]);
      prisma.deviceBinding.findFirst.mockResolvedValue({ userId: 'u1' });
      prisma.sosCase.findFirst.mockResolvedValue({ id: 'x' });
      await expect(svc.reconcileLostTriggers()).resolves.toBe(0);
      // 「事件到达时已在倒数」那一支：manual_sos 排除已取消的单，possible_fall 不排除
      const before = prisma.sosCase.findFirst.mock.calls.map(
        (c) =>
          (c as [{ where: { OR: Array<Record<string, unknown>> } }])[0].where
            .OR[0],
      );
      expect(before[0].status).toEqual({ not: 'cancelled' });
      expect(before[1]).not.toHaveProperty('status');
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('对账补建'),
      );
    });

    it('事件到达后一个倒计时之内建的单也算这次事故（不论状态）：E1 丢了分发、E2 建了单，E1 不再补建第二单（10-17 评审 SOS-1）', async () => {
      process.env.SOS_COUNTDOWN_SECONDS = '60';
      try {
        prisma.rawEvent.findMany.mockResolvedValueOnce([rawRow('m1')]);
        prisma.sosCase.findMany.mockResolvedValueOnce([]);
        prisma.deviceBinding.findFirst.mockResolvedValue({ userId: 'u1' });
        prisma.sosCase.findFirst.mockResolvedValue({ id: 'c2' });
        await svc.reconcileLostTriggers();
        const where = (
          prisma.sosCase.findFirst.mock.calls[0] as [
            { where: { OR: Array<Record<string, unknown>> } },
          ]
        )[0].where;
        expect(where.OR[1]).toEqual({
          createdAt: {
            gt: new Date('2026-10-16T00:00:01Z'),
            lte: new Date('2026-10-16T00:01:01Z'),
          },
        });
        expect(where.OR[1]).not.toHaveProperty('status');
      } finally {
        delete process.env.SOS_COUNTDOWN_SECONDS;
      }
    });

    it('满页（200 条）时按游标翻下一页，翻到不足一页为止', async () => {
      const page1 = Array.from({ length: 200 }, (_, i) => rawRow(`p1-${i}`));
      const page2 = [rawRow('p2-0')];
      prisma.rawEvent.findMany
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2);
      prisma.sosCase.findMany.mockResolvedValue([]);
      await svc.reconcileLostTriggers();
      expect(prisma.rawEvent.findMany).toHaveBeenCalledTimes(2);
      const second = (
        prisma.rawEvent.findMany.mock.calls[1] as [Record<string, unknown>]
      )[0];
      expect(second.cursor).toEqual({ id: 'p1-199' });
      expect(second.skip).toBe(1);
      const first = (
        prisma.rawEvent.findMany.mock.calls[0] as [Record<string, unknown>]
      )[0];
      expect(first).not.toHaveProperty('cursor');
    });

    it('一直满页：最多翻 50 页就停（洪水不拖住扫描循环）', async () => {
      const full = Array.from({ length: 200 }, (_, i) => rawRow(`x${i}`));
      prisma.rawEvent.findMany.mockResolvedValue(full);
      prisma.sosCase.findMany.mockResolvedValue(
        full.map((r) => ({ deviceId: r.deviceId, triggerEventId: r.eventId })),
      );
      await expect(svc.reconcileLostTriggers()).resolves.toBe(0);
      expect(prisma.rawEvent.findMany).toHaveBeenCalledTimes(50);
    });
  });
});
