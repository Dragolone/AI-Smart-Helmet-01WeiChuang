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
      await flush();
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
      await flush();
      expect(pushMock.send).toHaveBeenCalledTimes(2);
      expect(realtimeMock.pushSosUpdate).toHaveBeenCalledTimes(1);
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
