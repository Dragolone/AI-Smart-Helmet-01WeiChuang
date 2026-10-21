// 10-06 并发评审 #1：倒计时中收到实体键 manual_sos → 升级立即通知；若升级那一刻那一单刚被本人取消，
// 这次明确的人为求救不能被静默吞掉——按终态后的新事件建新单。另钉住建单推送的重试节奏。
import { Test } from '@nestjs/testing';
import { BindingScopeService } from '../devices/binding-scope.service';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_PROVIDER } from '../providers/push.provider';
import { RealtimePushService } from '../realtime/realtime-push.service';
import type { ValidEnvelope } from '../ingest/envelope';
import { SosNotifierService } from './sos-notifier.service';
import { SosTriggerService } from './sos-trigger.service';

const NOW = new Date('2026-10-06T04:00:00Z');
const pendingCase = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  deviceId: 'helmet_001',
  userId: 'u1',
  triggerEventId: 'fall-1',
  triggerType: 'possible_fall',
  status: 'pending',
  deadline: new Date(NOW.getTime() + 60_000),
  createdAt: NOW,
  updatedAt: NOW,
  finalizedAt: null,
  latitude: null,
  longitude: null,
  coordinateSystem: null,
  accuracy: null,
  locationSource: null,
  ...over,
});
const manualSos = (eventId: string): ValidEnvelope => ({
  schemaVersion: 1,
  eventId,
  deviceId: 'helmet_001',
  eventType: 'manual_sos',
  timestamp: NOW,
  firmwareVersion: '1.0.0',
  payload: {},
});

describe('SosTriggerService：升级与取消撞车 / 建单推送重试', () => {
  const prismaMock = {
    sosCase: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    locationPoint: { findFirst: jest.fn() },
    deviceBinding: { findMany: jest.fn() },
    // 建单事务：先给用户行加共享锁（账号还在），再 create
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const notifierMock = { finalizeNotified: jest.fn() };
  const realtimeMock = { pushSosUpdate: jest.fn() };
  const pushMock = { send: jest.fn() };
  let service: SosTriggerService;
  const savedDelays = process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS;

  beforeEach(async () => {
    jest.resetAllMocks();
    process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = '';
    prismaMock.locationPoint.findFirst.mockResolvedValue(null);
    prismaMock.deviceBinding.findMany.mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(
      (fn: (tx: typeof prismaMock) => Promise<unknown>) => fn(prismaMock),
    );
    prismaMock.$queryRaw.mockResolvedValue([{ deleted_at: null }]);
    pushMock.send.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        SosTriggerService,
        BindingScopeService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: SosNotifierService, useValue: notifierMock },
        { provide: RealtimePushService, useValue: realtimeMock },
        { provide: PUSH_PROVIDER, useValue: pushMock },
      ],
    }).compile();
    service = moduleRef.get(SosTriggerService);
  });
  afterAll(() => {
    if (savedDelays === undefined)
      delete process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS;
    else process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = savedDelays;
  });

  it('倒计时中来 manual_sos，升级那一刻那一单刚被本人取消 → 按终态后的新事件建新单（不丢这次求救）', async () => {
    prismaMock.sosCase.findFirst
      .mockResolvedValueOnce(pendingCase()) // 读到 pending 的 c1
      .mockResolvedValueOnce(null); // 取消后重跑：没有进行中的单
    notifierMock.finalizeNotified.mockResolvedValue(false); // 条件更新落空：被 cancel 抢先
    prismaMock.sosCase.findUnique.mockResolvedValue({ status: 'cancelled' });
    prismaMock.sosCase.create.mockResolvedValue(
      pendingCase({
        id: 'c2',
        triggerEventId: 'manual-2',
        triggerType: 'manual_sos',
      }),
    );
    await service.handleTrigger(manualSos('manual-2'), 'u1');
    expect(notifierMock.finalizeNotified).toHaveBeenCalledWith('c1');
    expect(prismaMock.sosCase.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.sosCase.create.mock.calls[0][0]).toMatchObject({
      data: {
        triggerEventId: 'manual-2',
        triggerType: 'manual_sos',
        userId: 'u1',
      },
    });
    expect(realtimeMock.pushSosUpdate).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ sosId: 'c2', status: 'pending' }),
    );
  });

  it('升级那一刻那一单已被到期扫描抢先 notified → 联系人已在通知，不再建第二单', async () => {
    prismaMock.sosCase.findFirst.mockResolvedValueOnce(pendingCase());
    notifierMock.finalizeNotified.mockResolvedValue(false);
    prismaMock.sosCase.findUnique.mockResolvedValue({ status: 'notified' });
    await service.handleTrigger(manualSos('manual-3'), 'u1');
    expect(prismaMock.sosCase.create).not.toHaveBeenCalled();
  });

  it('升级成功（finalizeNotified 赢）→ 不建单、不查状态', async () => {
    prismaMock.sosCase.findFirst.mockResolvedValueOnce(pendingCase());
    notifierMock.finalizeNotified.mockResolvedValue(true);
    await service.handleTrigger(manualSos('manual-4'), 'u1');
    expect(prismaMock.sosCase.create).not.toHaveBeenCalled();
    expect(prismaMock.sosCase.findUnique).not.toHaveBeenCalled();
  });

  describe('建单推送「SOS 倒计时已开始」', () => {
    const flush = () => new Promise((r) => setTimeout(r, 30));
    // 只睡固定 30 ms 再数次数会抖：事件循环停顿超过 30 ms（并行 worker、慢 runner）时，第二次重试的定时器排在 flush 之后，
    // 期望 3 次只数到 2 次（CI 与本机都出现过）。要数到几次就轮询等到几次，超时 2 s 才算失败
    const waitForCalls = async (fn: jest.Mock, n: number) => {
      const until = Date.now() + 2_000;
      while (fn.mock.calls.length < n && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    // 正文秒数按 deadline 现算、已到期不发：这里的单必须相对真实时钟还在倒计时
    const inOneMinute = () => new Date(Date.now() + 60_000);

    it('首投失败按节奏再试；单仍 pending 才发', async () => {
      process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = '0,0';
      prismaMock.sosCase.findFirst.mockResolvedValue(null);
      prismaMock.sosCase.create.mockResolvedValue(
        pendingCase({
          id: 'c9',
          triggerEventId: 'fall-9',
          deadline: inOneMinute(),
        }),
      );
      prismaMock.sosCase.findUnique.mockResolvedValue({ status: 'pending' });
      pushMock.send
        .mockRejectedValueOnce(new Error('jpush 502'))
        .mockRejectedValueOnce(new Error('jpush 502'))
        .mockResolvedValueOnce(undefined);
      await service.handleTrigger(manualSos('fall-9'), 'u1');
      await waitForCalls(pushMock.send, 3);
      expect(pushMock.send).toHaveBeenCalledTimes(3);
      expect(pushMock.send.mock.calls[2][4]).toEqual({
        category: 'sos',
        timeSensitive: true,
      });
    });

    it('重试前这单已被取消 → 不再发', async () => {
      process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = '0';
      prismaMock.sosCase.findFirst.mockResolvedValue(null);
      prismaMock.sosCase.create.mockResolvedValue(
        pendingCase({
          id: 'c10',
          triggerEventId: 'fall-10',
          deadline: inOneMinute(),
        }),
      );
      prismaMock.sosCase.findUnique.mockResolvedValue({ status: 'cancelled' });
      pushMock.send.mockRejectedValue(new Error('jpush 502'));
      await service.handleTrigger(manualSos('fall-10'), 'u1');
      // 等重试前那次查库发生，再留一点时间看它会不会还发
      await waitForCalls(prismaMock.sosCase.findUnique, 1);
      await flush();
      expect(pushMock.send).toHaveBeenCalledTimes(1);
    });

    it('重试次数用尽后停止；推送失败从不影响建单与 WS 推送', async () => {
      process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = '0';
      prismaMock.sosCase.findFirst.mockResolvedValue(null);
      prismaMock.sosCase.create.mockResolvedValue(
        pendingCase({
          id: 'c11',
          triggerEventId: 'fall-11',
          deadline: inOneMinute(),
        }),
      );
      prismaMock.sosCase.findUnique.mockResolvedValue({ status: 'pending' });
      pushMock.send.mockRejectedValue(new Error('jpush 502'));
      await service.handleTrigger(manualSos('fall-11'), 'u1');
      await waitForCalls(pushMock.send, 2);
      await flush();
      expect(pushMock.send).toHaveBeenCalledTimes(2);
      expect(realtimeMock.pushSosUpdate).toHaveBeenCalledTimes(1);
    });

    it('推送通道挂住（send 一直不回）：按应用层超时记失败、照节奏重试，不一直等到倒计时结束（10-17 评审）', async () => {
      process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = '0';
      process.env.SOS_NOTIFY_TIMEOUT_MS = '50';
      try {
        prismaMock.sosCase.findFirst.mockResolvedValue(null);
        prismaMock.sosCase.create.mockResolvedValue(
          pendingCase({
            id: 'c13',
            triggerEventId: 'fall-13',
            deadline: inOneMinute(),
          }),
        );
        prismaMock.sosCase.findUnique.mockResolvedValue({ status: 'pending' });
        pushMock.send
          .mockReturnValueOnce(new Promise(() => undefined))
          .mockResolvedValueOnce(undefined);
        await service.handleTrigger(manualSos('fall-13'), 'u1');
        await waitForCalls(pushMock.send, 2);
        expect(pushMock.send).toHaveBeenCalledTimes(2);
      } finally {
        delete process.env.SOS_NOTIFY_TIMEOUT_MS;
      }
    });

    it('不在 ingest 路径里等推送：push.send 挂起时 handleTrigger 照样立刻返回', async () => {
      prismaMock.sosCase.findFirst.mockResolvedValue(null);
      prismaMock.sosCase.create.mockResolvedValue(
        pendingCase({
          id: 'c12',
          triggerEventId: 'fall-12',
          deadline: inOneMinute(),
        }),
      );
      pushMock.send.mockReturnValue(new Promise(() => undefined));
      const started = Date.now();
      await service.handleTrigger(manualSos('fall-12'), 'u1');
      expect(Date.now() - started).toBeLessThan(500);
      expect(pushMock.send).toHaveBeenCalledTimes(1);
    });
  });
});
