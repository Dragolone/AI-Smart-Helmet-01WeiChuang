// SOS 终态化与通知投递的单测分支：Prisma / 短信 / 推送 / WS 全部 mock，绝不真发。
// 重点钉：短信在飞时本人 Push 先不发、占位抢输不发、Push 正文按短信真实结果、短信昵称回落、失败落 failed 且日志脱敏。
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimePushService } from '../realtime/realtime-push.service';
import { PUSH_TITLE, SosNotifierService } from './sos-notifier.service';

const sosCase = (over: Record<string, unknown> = {}) => ({
  id: 'sos1',
  userId: 'u1',
  deviceId: 'helmet_0000000001',
  triggerEventId: 'e1',
  triggerType: 'possible_fall',
  status: 'notified',
  deadline: new Date('2026-10-16T01:01:00Z'),
  createdAt: new Date('2026-10-16T01:00:00Z'),
  updatedAt: new Date('2026-10-16T01:01:00Z'),
  finalizedAt: new Date('2026-10-16T01:01:00Z'), // 北京时间 09:01
  triggeredAt: null,
  latitude: 22.543101,
  longitude: 114.057899,
  ...over,
});

const row = (
  channel: 'sms' | 'push',
  over: Record<string, unknown> = {},
  sos = sosCase(),
) => ({
  id: `${channel}-row`,
  sosId: 'sos1',
  channel,
  target: channel === 'sms' ? '13800001111' : 'user:u1',
  attempts: 0,
  status: 'pending',
  sos,
  ...over,
});

describe('SosNotifierService', () => {
  const tx = {
    sosCase: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    emergencyContact: { findMany: jest.fn() },
    sosNotification: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    sosNotification: {
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    device: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  const realtime = { pushSosUpdate: jest.fn() };
  const sms = { send: jest.fn() };
  const push = { send: jest.fn() };
  let svc: SosNotifierService;
  let errorSpy: jest.SpyInstance;
  const ENV = ['SOS_NOTIFY_MAX_ATTEMPTS', 'SOS_NOTIFY_TIMEOUT_MS'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    for (const group of [
      tx.sosCase,
      tx.emergencyContact,
      tx.sosNotification,
      prisma.sosNotification,
      prisma.device,
      prisma.user,
    ])
      for (const fn of Object.values(group)) fn.mockReset();
    for (const fn of [realtime.pushSosUpdate, sms.send, push.send])
      fn.mockReset();
    prisma.sosNotification.findMany.mockResolvedValue([]);
    prisma.sosNotification.count.mockResolvedValue(0);
    prisma.sosNotification.updateMany.mockResolvedValue({ count: 1 });
    prisma.sosNotification.update.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue({ name: '通勤盔' });
    prisma.user.findUnique.mockResolvedValue({
      nickname: '张三',
      phone: '13911112222',
    });
    sms.send.mockResolvedValue(undefined);
    push.send.mockResolvedValue(undefined);
    svc = new SosNotifierService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimePushService,
      sms,
      push,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** deliverPending 里 pushText 读短信结果用的 findMany 是第二次调用起 */
  const queueRows = (rows: unknown[], smsStatuses: string[] = []) => {
    prisma.sosNotification.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValue(smsStatuses.map((status) => ({ status })));
  };

  describe('deliverPending：占位与跳过', () => {
    it('本人 Push 行：同一单还有短信在飞（pending 且 attempts>0）时这轮先不占、不发', async () => {
      queueRows([row('push')]);
      prisma.sosNotification.count.mockResolvedValue(1);
      await svc.deliverPending('sos1');
      expect(prisma.sosNotification.count).toHaveBeenCalledWith({
        where: {
          sosId: 'sos1',
          channel: 'sms',
          status: 'pending',
          attempts: { gt: 0 },
        },
      });
      expect(prisma.sosNotification.updateMany).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
    });

    it('占位抢输（另一轮扫描已占走这一次）：不发送、不写结果', async () => {
      queueRows([row('sms')]);
      prisma.sosNotification.updateMany.mockResolvedValue({ count: 0 });
      await svc.deliverPending();
      expect(sms.send).not.toHaveBeenCalled();
      expect(prisma.sosNotification.update).not.toHaveBeenCalled();
    });

    it('查询带上 sosId 过滤；不带 sosId 时扫全部到点行', async () => {
      await svc.deliverPending('sos1');
      expect(
        (
          prisma.sosNotification.findMany.mock.calls[0] as [{ where: object }]
        )[0].where,
      ).toHaveProperty('sosId', 'sos1');
      await svc.deliverPending();
      expect(
        (
          prisma.sosNotification.findMany.mock.calls[1] as [{ where: object }]
        )[0].where,
      ).not.toHaveProperty('sosId');
    });
  });

  describe('短信内容（固定文案模板，params 留给后续渠道）', () => {
    const sentParams = () =>
      (
        sms.send.mock.calls[0] as [
          string,
          { template: string; params: Record<string, string> },
        ]
      )[1];

    it('有昵称：截 10 字；时间写北京时间 MM-DD HH:mm；坐标保留 5 位小数', async () => {
      prisma.user.findUnique.mockResolvedValue({
        nickname: '  一二三四五六七八九十十一  ',
        phone: '13911112222',
      });
      queueRows([row('sms')]);
      await svc.deliverPending();
      expect(sms.send).toHaveBeenCalledWith('13800001111', {
        template: 'sos_alert',
        params: {
          nickname: '一二三四五六七八九十',
          triggeredAt: '10-16 09:01',
          locationText: '22.54310,114.05790',
        },
      });
      expect(prisma.sosNotification.update).toHaveBeenCalledWith({
        where: { id: 'sms-row' },
        data: { status: 'sent', sentAt: expect.any(Date), lastError: null },
      });
    });

    it('没有昵称（或全是空格）：回落为脱敏手机号', async () => {
      prisma.user.findUnique.mockResolvedValue({
        nickname: '   ',
        phone: '13911112222',
      });
      queueRows([row('sms')]);
      await svc.deliverPending();
      expect(sentParams().params.nickname).toBe('139****2222');
    });

    it('用户行没了：回落为设备编号前 10 位；无位置写「暂不可用」', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      queueRows([row('sms', {}, sosCase({ latitude: null, longitude: null }))]);
      await svc.deliverPending();
      expect(sentParams().params).toMatchObject({
        nickname: 'helmet_000',
        locationText: '暂不可用',
      });
    });

    it('单子还没有终态时间（内联首投前被读到）：触发时间按当下算', async () => {
      queueRows([row('sms', {}, sosCase({ finalizedAt: null }))]);
      await svc.deliverPending();
      expect(sentParams().params.triggeredAt).toMatch(
        /^\d{2}-\d{2} \d{2}:\d{2}$/,
      );
    });

    it('发送失败：记 failed + lastError，日志里手机号打码', async () => {
      sms.send.mockRejectedValue(new Error('LimitExceeded'));
      queueRows([row('sms', { attempts: 2 })]);
      await svc.deliverPending();
      expect(prisma.sosNotification.update).toHaveBeenCalledWith({
        where: { id: 'sms-row' },
        data: { status: 'failed', lastError: 'LimitExceeded' },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        'SOS 通知投递失败（第 3 次，channel=sms，target=138****1111）：LimitExceeded',
      );
    });
  });

  describe('本人 Push 正文（按此刻短信真实结果）', () => {
    const pushed = () =>
      push.send.mock.calls[0] as [
        string,
        string,
        string,
        Record<string, string>,
        Record<string, unknown>,
      ];

    it('没有联系人：标题「未设置紧急联系人」，头盔写用户起的名字，带北京时间', async () => {
      queueRows([row('push')], []);
      await svc.deliverPending();
      const [userId, title, body, data, opts] = pushed();
      expect(userId).toBe('u1');
      expect(title).toBe(PUSH_TITLE.noContacts);
      expect(body).toBe(
        '头盔 通勤盔 的求救已于 09:01 确认，但你尚未设置紧急联系人，无人会收到短信，请直接拨打电话求助',
      );
      expect(data).toEqual({ sosId: 'sos1', deviceId: 'helmet_0000000001' });
      expect(opts).toEqual({ timeSensitive: true });
    });

    it('短信全部失败：标题「发送失败」，正文带联系人数', async () => {
      queueRows([row('push')], ['failed', 'pending']);
      await svc.deliverPending();
      expect(pushed()[1]).toBe(PUSH_TITLE.contactsFailed);
      expect(pushed()[2]).toContain('向 2 位紧急联系人发送短信全部失败');
    });

    it('部分成功：x/y 并说明其余会重试；全部成功不带那句', async () => {
      queueRows([row('push')], ['sent', 'failed', 'sent']);
      await svc.deliverPending();
      expect(pushed()[1]).toBe(PUSH_TITLE.contactsNotified);
      expect(pushed()[2]).toBe(
        '头盔 通勤盔 的求救已于 09:01 向 2/3 位紧急联系人发出短信通知（其余失败，系统会自动重试）',
      );
      push.send.mockClear();
      queueRows([row('push')], ['sent']);
      await svc.deliverPending();
      expect(pushed()[2]).toBe(
        '头盔 通勤盔 的求救已于 09:01 向 1/1 位紧急联系人发出短信通知',
      );
    });

    it('查设备名失败 / 没起名：退回设备编号；没有终态时间就不写「已于 HH:mm」', async () => {
      prisma.device.findUnique.mockRejectedValue(new Error('db'));
      queueRows([row('push', {}, sosCase({ finalizedAt: null }))], []);
      await svc.deliverPending();
      expect(pushed()[2]).toBe(
        '头盔 helmet_0000000001 的求救确认，但你尚未设置紧急联系人，无人会收到短信，请直接拨打电话求助',
      );
    });
  });

  describe('finalizeNotified', () => {
    beforeEach(() => {
      tx.sosCase.updateMany.mockResolvedValue({ count: 1 });
      tx.sosCase.findUniqueOrThrow.mockResolvedValue(sosCase());
      tx.sosNotification.create.mockResolvedValue({});
    });

    it('没抢到转换（已取消 / 已通知）：返回 false，不铺通知行、不推 WS', async () => {
      tx.sosCase.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.finalizeNotified('sos1')).resolves.toBe(false);
      expect(tx.sosNotification.create).not.toHaveBeenCalled();
      expect(realtime.pushSosUpdate).not.toHaveBeenCalled();
    });

    it('同号联系人只铺一条短信行，外加一条本人 Push 行；deliverInline=false 不在这里投递', async () => {
      tx.emergencyContact.findMany.mockResolvedValue([
        { phone: '13800001111', name: '妈' },
        { phone: '13800001111', name: '妈妈' },
        { phone: '13800003333', name: '爸' },
      ]);
      await expect(
        svc.finalizeNotified('sos1', { deliverInline: false }),
      ).resolves.toBe(true);
      const created = tx.sosNotification.create.mock.calls.map(
        (c) => (c as [{ data: { channel: string; target: string } }])[0].data,
      );
      expect(created).toEqual([
        expect.objectContaining({
          channel: 'sms',
          target: '13800001111',
          contactName: '妈',
        }),
        expect.objectContaining({ channel: 'sms', target: '13800003333' }),
        expect.objectContaining({ channel: 'push', target: 'user:u1' }),
      ]);
      expect(realtime.pushSosUpdate).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ sosId: 'sos1', status: 'notified' }),
      );
      expect(prisma.sosNotification.findMany).not.toHaveBeenCalled();
    });

    it('内联首投抛异常：吞掉只记 error，仍返回 true（终态已提交，由扫描续投）', async () => {
      tx.emergencyContact.findMany.mockResolvedValue([]);
      prisma.sosNotification.findMany.mockRejectedValue(new Error('db flap'));
      await expect(svc.finalizeNotified('sos1')).resolves.toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        'SOS sos1 终态化后首轮投递异常（状态已 notified，由扫描续投）：db flap',
      );
    });
  });

  describe('failInterrupted', () => {
    it('有中断的最后一次投递：收尾成 failed 并告警，返回条数', async () => {
      prisma.sosNotification.updateMany.mockResolvedValue({ count: 2 });
      await expect(svc.failInterrupted()).resolves.toBe(2);
      expect(prisma.sosNotification.updateMany).toHaveBeenCalledWith({
        where: { status: 'pending', attempts: { gte: 5 } },
        data: {
          status: 'failed',
          lastError: 'interrupted: 最后一次投递中途进程退出，结果未知',
        },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        'SOS 通知行 2 条在最后一次投递中途被中断，已记为 failed',
      );
    });

    it('没有：返回 0，不告警', async () => {
      prisma.sosNotification.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.failInterrupted()).resolves.toBe(0);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
