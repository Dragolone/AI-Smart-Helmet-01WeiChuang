// SOS 终态化与通知投递的单测分支：Prisma / 短信 / 推送 / WS 全部 mock，绝不真发。
// 重点钉：短信在飞时本人 Push 先不发、占位抢输不发、Push 正文按短信真实结果、短信昵称回落、失败落 failed 且日志脱敏；
// 状态推送说了「全部失败」、之后短信重试成功时只补推一条（O17）。
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
  const notificationRows = {
    findMany: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  };
  // 事务客户端与 prisma 共用通知行的读写替身：写「已发送」在事务里（锁单 + 判断要不要补推），断言照样看同一个 updateMany
  const tx = {
    $queryRaw: jest.fn(),
    sosCase: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    emergencyContact: { findMany: jest.fn() },
    sosNotification: { ...notificationRows, create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    sosNotification: notificationRows,
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
      prisma.device,
      prisma.user,
    ])
      for (const fn of Object.values(group)) fn.mockReset();
    tx.$queryRaw.mockReset();
    prisma.$transaction.mockClear();
    for (const fn of [realtime.pushSosUpdate, sms.send, push.send])
      fn.mockReset();
    prisma.sosNotification.findMany.mockResolvedValue([]);
    prisma.sosNotification.count.mockResolvedValue(0);
    prisma.sosNotification.updateMany.mockResolvedValue({ count: 1 });
    prisma.sosNotification.update.mockResolvedValue({});
    prisma.device.findUnique.mockResolvedValue({
      name: '通勤盔',
      bindUserId: 'u1',
    });
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
      // 只有占位那一次 updateMany，没有写结果
      expect(prisma.sosNotification.updateMany).toHaveBeenCalledTimes(1);
    });

    it('同一行本进程还在发（内联首投挂着、扫描又到了重试时刻）：不再占第二次、不再发（10-17 评审 SOS-2）', async () => {
      let release!: () => void;
      sms.send.mockImplementationOnce(
        () => new Promise<void>((r) => (release = r)),
      );
      queueRows([row('sms')]);
      const first = svc.deliverPending('sos1');
      await new Promise((r) => setImmediate(r));
      expect(sms.send).toHaveBeenCalledTimes(1);
      prisma.sosNotification.findMany.mockReset();
      queueRows([row('sms', { attempts: 1 })]);
      await svc.deliverPending();
      expect(sms.send).toHaveBeenCalledTimes(1);
      release();
      await first;
    });

    it('占位已提交、还没回到本进程时另一路查到这一行（attempts 已 +1、到了重试时刻）：不再占第二次、不多发', async () => {
      let claimDone!: (v: { count: number }) => void;
      prisma.sosNotification.updateMany.mockImplementationOnce(
        () => new Promise((r) => (claimDone = r)),
      );
      queueRows([row('sms')]);
      const first = svc.deliverPending('sos1');
      await new Promise((r) => setImmediate(r));
      prisma.sosNotification.findMany.mockReset();
      queueRows([row('sms', { attempts: 1 })]);
      await svc.deliverPending();
      expect(prisma.sosNotification.updateMany).toHaveBeenCalledTimes(1);
      claimDone({ count: 1 });
      await first;
      expect(sms.send).toHaveBeenCalledTimes(1);
    });

    it('结果只写到这次占位的那一行（attempts 未被后来的重试改过）：迟到的旧结果不盖新的', async () => {
      queueRows([row('sms', { attempts: 2 })]);
      await svc.deliverPending();
      expect(prisma.sosNotification.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'sms-row', attempts: 3 },
        data: { status: 'sent', sentAt: expect.any(Date), lastError: null },
      });
    });

    it('已发出、写 sent 时数据库瞬断：再试几次写成 sent，不落进发送失败分支（那会到点再发一条）', async () => {
      queueRows([row('sms')]);
      prisma.sosNotification.updateMany
        .mockResolvedValueOnce({ count: 1 }) // 占位
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockResolvedValueOnce({ count: 1 });
      await svc.deliverPending();
      expect(sms.send).toHaveBeenCalledTimes(1);
      const writes = (
        prisma.sosNotification.updateMany.mock.calls as Array<
          [{ data: { status?: string } }]
        >
      ).map((c) => c[0].data.status);
      expect(writes).toEqual([undefined, 'sent', 'sent']);
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
      expect(prisma.sosNotification.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'sms-row', attempts: 1 },
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
      expect(prisma.sosNotification.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'sms-row', attempts: 3 },
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

    it('没有联系人：标题「未设置紧急联系人」，头盔写用户起的名字；没报时区时写明北京时间（O13）', async () => {
      queueRows([row('push')], []);
      await svc.deliverPending();
      const [userId, title, body, data, opts] = pushed();
      expect(userId).toBe('u1');
      expect(title).toBe(PUSH_TITLE.noContacts);
      expect(body).toBe(
        '头盔 通勤盔 的求救已于北京时间 09:01 确认，但你尚未设置紧急联系人，无人会收到短信，请直接拨打电话求助',
      );
      expect(data).toEqual({ sosId: 'sos1', deviceId: 'helmet_0000000001' });
      expect(opts).toEqual({ timeSensitive: true });
    });

    it('用户报过手机时区：时间按当地写、不加说明（O13）；查时区出错照发、写北京时间', async () => {
      prisma.user.findUnique.mockResolvedValue({
        timeZone: 'Australia/Sydney',
      });
      queueRows([row('push')], ['sent']);
      await svc.deliverPending();
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { timeZone: true },
      });
      expect(pushed()[2]).toBe(
        '头盔 通勤盔 的求救已于 12:01 向 1/1 位紧急联系人发出短信通知',
      );
      push.send.mockClear();
      prisma.user.findUnique.mockRejectedValue(new Error('db'));
      queueRows([row('push')], ['sent']);
      await svc.deliverPending();
      expect(pushed()[2]).toContain('已于北京时间 09:01 ');
    });

    it('头盔已转给别人（当前绑定的不是这单的主人）：写设备编号，不把新主人起的名字推给前主人', async () => {
      prisma.device.findUnique.mockResolvedValue({
        name: '老王的头盔',
        bindUserId: 'someone-else',
      });
      queueRows([row('push')], []);
      await svc.deliverPending();
      expect(pushed()[2]).toContain('头盔 helmet_0000000001 的求救');
      expect(pushed()[2]).not.toContain('老王');
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
        '头盔 通勤盔 的求救已于北京时间 09:01 向 2/3 位紧急联系人发出短信通知（其余失败，系统会自动重试）',
      );
      push.send.mockClear();
      queueRows([row('push')], ['sent']);
      await svc.deliverPending();
      expect(pushed()[2]).toBe(
        '头盔 通勤盔 的求救已于北京时间 09:01 向 1/1 位紧急联系人发出短信通知',
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

  describe('重试后补推（O17）', () => {
    const lastWrite = () =>
      (
        prisma.sosNotification.updateMany.mock.calls.at(-1) as [
          { data: Record<string, unknown> },
        ]
      )[0].data;

    it('状态推送记下实际用的标题；不是「全部失败」的直接写，不锁单', async () => {
      queueRows([row('push')], ['sent']);
      await svc.deliverPending();
      expect(lastWrite()).toEqual({
        status: 'sent',
        sentAt: expect.any(Date),
        lastError: null,
        pushTitle: PUSH_TITLE.contactsNotified,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.sosNotification.create).not.toHaveBeenCalled();
    });

    it('短信重试成功，状态推送已以「全部失败」发出、还没补过：锁单后建一条补推行', async () => {
      prisma.sosNotification.findMany
        .mockResolvedValueOnce([row('sms', { attempts: 1, status: 'failed' })])
        .mockResolvedValueOnce([
          { pushTitle: PUSH_TITLE.contactsFailed, status: 'sent' },
        ]);
      prisma.sosNotification.count.mockResolvedValue(1);
      await svc.deliverPending();
      expect(lastWrite()).toEqual({
        status: 'sent',
        sentAt: expect.any(Date),
        lastError: null,
      });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(
        (tx.$queryRaw.mock.calls[0] as [TemplateStringsArray])[0].join('?'),
      ).toContain('FOR NO KEY UPDATE');
      expect(tx.sosNotification.create).toHaveBeenCalledWith({
        data: {
          sosId: 'sos1',
          channel: 'push',
          target: 'user:u1',
          pushTitle: PUSH_TITLE.retryNotified,
        },
      });
    });

    it.each([
      [
        '补推行已经建过（每单最多一条）',
        [
          { pushTitle: PUSH_TITLE.contactsFailed, status: 'sent' },
          { pushTitle: PUSH_TITLE.retryNotified, status: 'pending' },
        ],
      ],
      ['状态推送说的不是「全部失败」（部分成功 / 已通知）', []],
      [
        '「全部失败」那条还没发出去（本人根本没收到）',
        [{ pushTitle: PUSH_TITLE.contactsFailed, status: 'failed' }],
      ],
    ])('短信重试成功但%s：不补', async (_n, pushes) => {
      prisma.sosNotification.findMany
        .mockResolvedValueOnce([row('sms', { attempts: 1, status: 'failed' })])
        .mockResolvedValueOnce(pushes);
      prisma.sosNotification.count.mockResolvedValue(1);
      await svc.deliverPending();
      expect(tx.sosNotification.create).not.toHaveBeenCalled();
    });

    it('状态推送以「全部失败」发出、写「已发送」时已有短信成功（文案生成之后、写库之前成功的那条）：同一事务里补建', async () => {
      prisma.sosNotification.findMany
        .mockResolvedValueOnce([row('push')])
        .mockResolvedValueOnce([{ status: 'failed' }]) // 生成文案时：全部失败
        .mockResolvedValueOnce([
          { pushTitle: PUSH_TITLE.contactsFailed, status: 'sent' },
        ]);
      prisma.sosNotification.count
        .mockResolvedValueOnce(0) // 没有短信在飞，可以发本人推送
        .mockResolvedValueOnce(1); // 锁单后：已有一条短信成功
      await svc.deliverPending();
      expect(push.send.mock.calls[0][1]).toBe(PUSH_TITLE.contactsFailed);
      expect(lastWrite()).toMatchObject({
        pushTitle: PUSH_TITLE.contactsFailed,
      });
      expect(tx.sosNotification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pushTitle: PUSH_TITLE.retryNotified,
        }),
      });
    });

    it('状态推送以「全部失败」发出、短信仍一条没成：不补（等短信成功那一刻再判断）', async () => {
      prisma.sosNotification.findMany
        .mockResolvedValueOnce([row('push')])
        .mockResolvedValueOnce([{ status: 'failed' }])
        .mockResolvedValueOnce([
          { pushTitle: PUSH_TITLE.contactsFailed, status: 'sent' },
        ]);
      prisma.sosNotification.count.mockResolvedValue(0);
      await svc.deliverPending();
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.sosNotification.create).not.toHaveBeenCalled();
    });

    it.each([
      [
        '还有能再试的',
        [
          { status: 'sent', attempts: 2 },
          { status: 'failed', attempts: 2 },
          { status: 'sent', attempts: 3 },
        ],
        '头盔 通勤盔 的求救短信已在重试后发给 2/3 位紧急联系人（其余仍在重试）',
      ],
      [
        '其余次数已用完',
        [
          { status: 'sent', attempts: 2 },
          { status: 'failed', attempts: 5 },
        ],
        '头盔 通勤盔 的求救短信已在重试后发给 1/2 位紧急联系人（其余发送失败）',
      ],
      [
        '全部发出',
        [
          { status: 'sent', attempts: 2 },
          { status: 'sent', attempts: 1 },
        ],
        '头盔 通勤盔 的求救短信已在重试后发给 2/2 位紧急联系人',
      ],
    ])(
      '补推行的文案按此刻短信结果现算（%s）；结果推送不带 kind',
      async (_n, sms, body) => {
        queueRows([row('push', { pushTitle: PUSH_TITLE.retryNotified })]);
        prisma.sosNotification.findMany.mockResolvedValueOnce(sms);
        await svc.deliverPending();
        expect(push.send).toHaveBeenCalledWith(
          'u1',
          PUSH_TITLE.retryNotified,
          body,
          { sosId: 'sos1', deviceId: 'helmet_0000000001' },
          { timeSensitive: true },
        );
        // 补推本身发出后直接写，不再判断补推
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(lastWrite()).toMatchObject({
          status: 'sent',
          pushTitle: PUSH_TITLE.retryNotified,
        });
      },
    );
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
    it("deliverInline='background'：不等首投就返回 true，首投在后台照常开始；首投异常只记 error（「立即求救」的响应不被慢短信拖过 App 超时）", async () => {
      tx.emergencyContact.findMany.mockResolvedValue([]);
      let release: (rows: unknown[]) => void = () => undefined;
      prisma.sosNotification.findMany.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      await expect(
        svc.finalizeNotified('sos1', { deliverInline: 'background' }),
      ).resolves.toBe(true);
      expect(prisma.sosNotification.findMany).toHaveBeenCalledTimes(1);
      release([]);
      await Promise.resolve();

      prisma.sosNotification.findMany.mockRejectedValue(new Error('db flap'));
      await expect(
        svc.finalizeNotified('sos1', { deliverInline: 'background' }),
      ).resolves.toBe(true);
      await new Promise((r) => setImmediate(r));
      expect(errorSpy).toHaveBeenCalledWith(
        'SOS sos1 终态化后首轮投递异常（状态已 notified，由扫描续投）：db flap',
      );
    });

    it('backgroundDelivery：没有后台首投时为 null；有就等它结束（出错也 resolve），结束后回到 null', async () => {
      expect(svc.backgroundDelivery()).toBeNull();
      tx.emergencyContact.findMany.mockResolvedValue([]);
      let release!: (rows: unknown[]) => void;
      prisma.sosNotification.findMany.mockReturnValueOnce(
        new Promise((resolve) => (release = resolve)),
      );
      prisma.sosNotification.findMany.mockRejectedValueOnce(
        new Error('db flap'),
      );
      await svc.finalizeNotified('sos1', { deliverInline: 'background' });
      await svc.finalizeNotified('sos2', { deliverInline: 'background' });
      let settled = false;
      const all = svc.backgroundDelivery()!.then(() => (settled = true));
      await new Promise((r) => setImmediate(r));
      expect(settled).toBe(false);
      release([]);
      await all;
      expect(svc.backgroundDelivery()).toBeNull();
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
