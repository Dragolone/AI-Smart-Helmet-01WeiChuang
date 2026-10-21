// SosTriggerService 剩余分支：建单撞唯一约束后按合并规则处理、升级失败时那单已不见、建单推送重试途中查库失败、
// describeEventAge 的默认时钟。Prisma / 通知器 / 推送全 mock。
import { Logger } from '@nestjs/common';
import { BindingScopeService } from '../devices/binding-scope.service';
import { Prisma } from '../generated/prisma/client';
import type { ValidEnvelope } from '../ingest/envelope';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimePushService } from '../realtime/realtime-push.service';
import type { SosNotifierService } from './sos-notifier.service';
import { SosTriggerService, describeEventAge } from './sos-trigger.service';

const NOW = Date.parse('2026-10-16T04:00:00Z');
const env = (eventType: string, eventId = 'ev-new'): ValidEnvelope => ({
  schemaVersion: 1,
  eventId,
  deviceId: 'helmet_001',
  eventType,
  timestamp: new Date(NOW),
  firmwareVersion: '1.0.0',
  payload: {},
});
const pending = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  deviceId: 'helmet_001',
  userId: 'u1',
  triggerEventId: 'ev-old',
  triggerType: 'possible_fall',
  status: 'pending',
  deadline: new Date(NOW + 60_000),
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  finalizedAt: null,
  triggeredAt: null,
  ...over,
});
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('SosTriggerService：剩余分支', () => {
  const prisma = {
    sosCase: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
    locationPoint: { findFirst: jest.fn() },
    device: { findUnique: jest.fn() },
    deviceBinding: { findMany: jest.fn() },
  };
  const boundAt = new Date(NOW - 3_600_000);
  const notifier = { finalizeNotified: jest.fn() };
  const realtime = { pushSosUpdate: jest.fn() };
  const push = { send: jest.fn() };
  let svc: SosTriggerService;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const saved = process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS;
  const savedCountdown = process.env.SOS_COUNTDOWN_SECONDS;

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.SOS_COUNTDOWN_SECONDS;
    process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = '';
    prisma.locationPoint.findFirst.mockResolvedValue(null);
    prisma.device.findUnique.mockResolvedValue(null);
    prisma.deviceBinding.findMany.mockResolvedValue([
      { boundAt, unboundAt: null },
    ]);
    push.send.mockResolvedValue(undefined);
    svc = new SosTriggerService(
      prisma as unknown as PrismaService,
      notifier as unknown as SosNotifierService,
      realtime as unknown as RealtimePushService,
      push,
      new BindingScopeService(prisma as unknown as PrismaService),
    );
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  afterAll(() => {
    if (saved === undefined)
      delete process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS;
    else process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = saved;
    if (savedCountdown === undefined) delete process.env.SOS_COUNTDOWN_SECONDS;
    else process.env.SOS_COUNTDOWN_SECONDS = savedCountdown;
  });

  it('建单撞唯一约束（并发建单被 partial unique index 拦下），此时已有进行中的单：按合并规则并入（possible_fall 只留档）', async () => {
    prisma.sosCase.findFirst
      .mockResolvedValueOnce(null) // 建单前：没有进行中的单
      .mockResolvedValueOnce(pending()); // 撞车后再查：并发那一路已建好
    prisma.sosCase.create.mockRejectedValue(p2002());
    await svc.handleTrigger(env('possible_fall'), 'u1');
    expect(logSpy).toHaveBeenCalledWith(
      '倒计时中收到重复 possible_fall（ev-new），并入进行中 SOS c1（只留档不建单）',
    );
    expect(notifier.finalizeNotified).not.toHaveBeenCalled();
    expect(realtime.pushSosUpdate).not.toHaveBeenCalled();
  });

  it('建单撞唯一约束，撞车后的那单就是本事件自己（重放）：跳过', async () => {
    prisma.sosCase.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pending({ triggerEventId: 'ev-new' }));
    prisma.sosCase.create.mockRejectedValue(p2002());
    await svc.handleTrigger(env('manual_sos'), 'u1');
    expect(debugSpy).toHaveBeenCalledWith('SOS 重复触发已跳过：ev-new');
    expect(notifier.finalizeNotified).not.toHaveBeenCalled();
  });

  it('建单撞唯一约束，再查却没有进行中的单（同 triggerEventId 重放、那单已终态）：按重复跳过，不抛', async () => {
    prisma.sosCase.findFirst.mockResolvedValue(null);
    prisma.sosCase.create.mockRejectedValue(p2002());
    await expect(
      svc.handleTrigger(env('possible_fall'), 'u1'),
    ).resolves.toBeUndefined();
    expect(debugSpy).toHaveBeenCalledWith('SOS 重复触发已跳过：ev-new');
    expect(prisma.sosCase.create).toHaveBeenCalledTimes(1);
  });

  it('manual_sos 升级没抢到、回查那单已经查不到：记「已是 未知」，不建第二单', async () => {
    prisma.sosCase.findFirst.mockResolvedValueOnce(pending());
    notifier.finalizeNotified.mockResolvedValue(false);
    prisma.sosCase.findUnique.mockResolvedValue(null);
    await svc.handleTrigger(env('manual_sos'), 'u1');
    expect(warnSpy).toHaveBeenCalledWith(
      '升级时 c1 已是 未知，manual_sos ev-new 不再建单',
    );
    expect(prisma.sosCase.create).not.toHaveBeenCalled();
  });

  it('manual_sos 升级没抢到、那单已被到期扫描 notified：不建第二单', async () => {
    prisma.sosCase.findFirst.mockResolvedValueOnce(pending());
    notifier.finalizeNotified.mockResolvedValue(false);
    prisma.sosCase.findUnique.mockResolvedValue({ status: 'notified' });
    await svc.handleTrigger(env('manual_sos'), 'u1');
    expect(warnSpy).toHaveBeenCalledWith(
      '升级时 c1 已是 notified，manual_sos ev-new 不再建单',
    );
    expect(prisma.sosCase.create).not.toHaveBeenCalled();
  });

  it('建单推送首投失败、等待重试后回查单状态时查库失败：只记「重试中断」，不影响状态机', async () => {
    jest.useFakeTimers({ now: NOW });
    process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = '5';
    prisma.sosCase.findFirst.mockResolvedValueOnce(null);
    prisma.sosCase.create.mockResolvedValue(pending({ id: 'c9' }));
    push.send.mockRejectedValueOnce(new Error('jpush 503'));
    prisma.sosCase.findUnique.mockRejectedValue(new Error('db flap'));
    await svc.handleTrigger(env('possible_fall'), 'u1');
    await flush();
    expect(warnSpy).toHaveBeenCalledWith(
      'SOS 创建 Push 失败（第 1 次，不影响状态机），5s 后再试：jpush 503',
    );
    await jest.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(warnSpy).toHaveBeenCalledWith('SOS 创建 Push 重试中断：db flap');
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(realtime.pushSosUpdate).toHaveBeenCalledTimes(1);
  });

  it('建单推送：头盔起了名字就用名字', async () => {
    jest.useFakeTimers({ now: NOW });
    prisma.sosCase.findFirst.mockResolvedValueOnce(null);
    prisma.sosCase.create.mockImplementation(
      ({ data }: { data: { deadline: Date } }) =>
        Promise.resolve(pending({ id: 'c2', deadline: data.deadline })),
    );
    prisma.device.findUnique.mockResolvedValue({
      name: '  红色头盔 ',
      bindUserId: 'u1',
    });
    await svc.handleTrigger(env('manual_sos'), 'u1');
    await flush();
    expect(push.send).toHaveBeenCalledWith(
      'u1',
      'SOS 倒计时已开始',
      '头盔 红色头盔 触发手动求救，未取消将于 60 秒后通知紧急联系人',
      { sosId: 'c2', deviceId: 'helmet_001', kind: 'sos_started' },
      { category: 'sos', timeSensitive: true },
    );
  });

  it('事件位置是 (0,0) 被当缺失；回落查询同样排除 (0,0) 哨兵、只取建单用户绑定区间内到达的点，都没有就空快照（B2 / B3）', async () => {
    prisma.sosCase.findFirst.mockResolvedValueOnce(null);
    prisma.sosCase.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(pending({ id: 'c0', ...data })),
    );
    await svc.handleTrigger(
      {
        ...env('possible_fall'),
        payload: {
          location: { latitude: 0, longitude: 0, coordinateSystem: 'wgs84' },
        },
      },
      'u1',
    );
    expect(prisma.deviceBinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: 'helmet_001', userId: 'u1' },
      }),
    );
    const where = (
      prisma.locationPoint.findFirst.mock.calls[0] as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where).toMatchObject({
      deviceId: 'helmet_001',
      NOT: { latitude: 0, longitude: 0 },
      AND: [{ OR: [{ receivedAt: { gte: boundAt } }] }],
    });
    const data = (
      prisma.sosCase.create.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
    expect(data).not.toHaveProperty('latitude');
  });

  it('位置快照查询失败：按空快照照常建单（不能因为缺位置不建单）', async () => {
    prisma.sosCase.findFirst.mockResolvedValueOnce(null);
    prisma.locationPoint.findFirst.mockRejectedValue(new Error('timeout'));
    prisma.sosCase.create.mockResolvedValue(pending({ id: 'c3' }));
    await svc.handleTrigger(env('possible_fall'), 'u1');
    expect(warnSpy).toHaveBeenCalledWith(
      'SOS 位置快照查询失败，按空快照建单 device=helmet_001：timeout',
    );
    const data = (
      prisma.sosCase.create.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
    expect(data).not.toHaveProperty('latitude');
  });

  it('设备未绑定：只留档不建单（没人可通知、可取消），记 warn', async () => {
    await svc.handleTrigger(env('possible_fall'), null);
    expect(prisma.sosCase.findFirst).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'possible_fall 来自未绑定设备 helmet_001，不建 SOS 单（raw 已留档）：ev-new',
    );
  });

  it('建单瞬时失败：200ms、400ms 两次退避重试，第三次成功', async () => {
    jest.useFakeTimers({ now: NOW });
    prisma.sosCase.findFirst
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(null);
    prisma.sosCase.create.mockResolvedValue(pending({ id: 'c7' }));
    const p = svc.handleTrigger(env('possible_fall'), 'u1');
    await flush();
    expect(warnSpy).toHaveBeenCalledWith(
      'SOS 建单失败（第 1 次），200ms 后重试：connection reset',
    );
    await jest.advanceTimersByTimeAsync(200);
    expect(warnSpy).toHaveBeenCalledWith(
      'SOS 建单失败（第 2 次），400ms 后重试：connection reset',
    );
    await jest.advanceTimersByTimeAsync(400);
    await p;
    expect(prisma.sosCase.create).toHaveBeenCalledTimes(1);
    expect(realtime.pushSosUpdate).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ sosId: 'c7' }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('建单本身（create）遇到非唯一约束错误：不当成重复，抛给外层按瞬时故障重试', async () => {
    jest.useFakeTimers({ now: NOW });
    prisma.sosCase.findFirst.mockResolvedValue(null);
    prisma.sosCase.create
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce(pending({ id: 'c11' }));
    const p = svc.handleTrigger(env('possible_fall'), 'u1');
    await jest.advanceTimersByTimeAsync(200);
    await p;
    expect(prisma.sosCase.create).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      'SOS 建单失败（第 1 次），200ms 后重试：deadlock detected',
    );
    expect(realtime.pushSosUpdate).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ sosId: 'c11' }),
    );
  });

  it('重试耗尽：不向上抛（raw 已落库、重投会被幂等挡掉），记 error 等对账补建', async () => {
    jest.useFakeTimers({ now: NOW });
    prisma.sosCase.findFirst.mockRejectedValue(new Error('db down'));
    const p = svc.handleTrigger(env('manual_sos'), 'u1');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBeUndefined();
    expect(prisma.sosCase.findFirst).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'SOS 触发处理失败（raw 已留档，等待对账补建）event=ev-new device=helmet_001：Error: db down',
      ),
    );
  });

  it('触发事件自带合法位置：快照取事件里的（source=event），不查轨迹表', async () => {
    prisma.sosCase.findFirst.mockResolvedValueOnce(null);
    prisma.sosCase.create.mockResolvedValue(pending({ id: 'c8' }));
    await svc.handleTrigger(
      {
        ...env('possible_fall'),
        payload: {
          location: {
            latitude: 22.5,
            longitude: 114.1,
            coordinateSystem: 'gcj02',
            accuracy: 8,
          },
        },
      },
      'u1',
    );
    expect(prisma.locationPoint.findFirst).not.toHaveBeenCalled();
    expect(
      (
        prisma.sosCase.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0].data,
    ).toMatchObject({
      latitude: 22.5,
      longitude: 114.1,
      coordinateSystem: 'gcj02',
      accuracy: 8,
      locationSource: 'event',
    });
  });

  describe('describeEventAge 默认时钟', () => {
    it('不传 now 时按当前时间算', () => {
      expect(describeEventAge(new Date(Date.now() - 30 * 60_000))).toBe(
        '约 30 分钟前',
      );
      expect(describeEventAge(new Date())).toBeNull();
    });
  });
});
