// 2026-09-13 全面审计 §4：SOS 故障注入（in-process）。
// 注入方式：Provider mock 行为 / 对 Prisma 委托方法一次性替换（failOnce），不改业务源码。
// 每个用例对应审计任务 6 ①–⑥；带【SOS-xx 缺陷断言】的用例按期望行为断言，失败即证实缺陷。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SosSchedulerService } from '../src/sos/sos-scheduler.service';
import {
  bindDevice,
  cleanupDevices,
  cleanupUsers,
  createUser,
  provisionDevice,
  relay,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  addContact,
  auth,
  buildSosApp,
  confirmSos,
  failOnce,
  failSosCaseCreate,
  fallEnvelope,
  makeProviderMocks,
  notificationsOf,
  pushCallsTitled,
  resetMocks,
  sleep,
  sosByEvent,
  sosSmsCalls,
  waitForPushTitled,
  settleSosDelivery,
} from './helpers/audit-sos';

jest.setTimeout(60000);

const mocks = makeProviderMocks();
const setCountdown = (s: string) => {
  process.env.SOS_COUNTDOWN_SECONDS = s;
};

describe('审计 §4 SOS 故障注入 (e2e, 手动 tick)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let scheduler: SosSchedulerService;

  const run = Date.now();
  const devCreateFail = `audit_sosf_create_${run}`;
  const devCreateLost = `audit_sosf_lost_${run}`;
  const devSnapFail = `audit_sosf_snap_${run}`;
  const devDeliverFail = `audit_sosf_deliver_${run}`;
  const devHang = `audit_sosf_hang_${run}`;
  const devHangVictim = `audit_sosf_victim_${run}`;
  const devSentFail = `audit_sosf_sent_${run}`;
  const devConfirmTick = `audit_sosf_ctick_${run}`;
  const devices = [
    devCreateFail,
    devCreateLost,
    devSnapFail,
    devDeliverFail,
    devHang,
    devHangVictim,
    devSentFail,
    devConfirmTick,
  ];
  let owner: TestUser;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
    ingest = app.get(IngestService);
    scheduler = app.get(SosSchedulerService);
    owner = await createUser(app, http);
    for (const d of devices) {
      await provisionDevice(prisma, d);
      await bindDevice(http, owner.token, d);
    }
    await addContact(http, owner.token, '家人', '19100000011');
  });

  beforeEach(() => {
    resetMocks(mocks);
    setCountdown('600');
  });

  afterEach(() => settleSosDelivery(app));
  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  it('① raw 落库后 sos_cases.create 瞬断一次：进程内重试补建，入口 202/accepted，App 无需重传【SOS-02 修复验证 a】', async () => {
    const e = fallEnvelope(devCreateFail);
    const eventId = e.eventId as string;
    const fault = failSosCaseCreate(
      prisma,
      new Error('audit: 数据库连接瞬断（模拟）'),
    );
    try {
      const res = await relay(http, owner.token, devCreateFail, [e]).expect(
        202,
      );
      expect(res.body).toEqual({ accepted: 1, duplicate: 0, invalid: 0 });
    } finally {
      fault.restore();
    }
    // 第一次抛错、第二次成功：瞬断被进程内重试吸收
    expect(fault.calls).toBe(2);
    expect(
      await prisma.rawEvent.findFirst({ where: { eventId } }),
    ).not.toBeNull();
    expect(await sosByEvent(prisma, eventId)).not.toBeNull();
    // 倒计时 Push 是建单后的后台任务：等它发出再数
    await waitForPushTitled(mocks, 'SOS 倒计时已开始');
    expect(pushCallsTitled(mocks, 'SOS 倒计时已开始')).toHaveLength(1);
  });

  it('①b raw 落库后建单持续失败（= 进程在分发阶段被杀）：重放 duplicate 不能恢复，启动对账按当时绑定用户补建【SOS-02 修复验证 b】', async () => {
    const e = fallEnvelope(devCreateLost);
    const eventId = e.eventId as string;
    // 持续失败：重试耗尽后 handleTrigger 记 ERROR 放弃（raw 已落库）
    const fault = failSosCaseCreate(
      prisma,
      new Error('audit: 数据库持续不可用（模拟）'),
      Infinity,
    );
    const savedGrace = process.env.SOS_RECONCILE_GRACE_MS;
    try {
      const res = await relay(http, owner.token, devCreateLost, [e]).expect(
        202,
      );
      expect(res.body).toEqual({ accepted: 1, duplicate: 0, invalid: 0 });
      expect(await sosByEvent(prisma, eventId)).toBeNull();
      // 重放同 eventId（App 补传 / MQTT 重投）：幂等挡在 raw 层，不能借此恢复
      const replay = await relay(http, owner.token, devCreateLost, [e]).expect(
        202,
      );
      expect(replay.body).toEqual({ accepted: 0, duplicate: 1, invalid: 0 });
      expect(await sosByEvent(prisma, eventId)).toBeNull();
    } finally {
      fault.restore();
    }
    // 对账（= 进程重启时的启动对账）：宽限设 0 让刚落库的事件立即参与
    process.env.SOS_RECONCILE_GRACE_MS = '1';
    try {
      const recovered = await scheduler.reconcileLostTriggers();
      expect(recovered).toBeGreaterThanOrEqual(1);
    } finally {
      if (savedGrace === undefined) delete process.env.SOS_RECONCILE_GRACE_MS;
      else process.env.SOS_RECONCILE_GRACE_MS = savedGrace;
    }
    const recoveredCase = await sosByEvent(prisma, eventId);
    expect(recoveredCase).not.toBeNull();
    expect(recoveredCase!.userId).toBe(owner.id);
    // 再对账一次不重复建单（已有对应 trigger_event_id）
    process.env.SOS_RECONCILE_GRACE_MS = '1';
    try {
      expect(await scheduler.reconcileLostTriggers()).toBe(0);
    } finally {
      if (savedGrace === undefined) delete process.env.SOS_RECONCILE_GRACE_MS;
      else process.env.SOS_RECONCILE_GRACE_MS = savedGrace;
    }
  });

  it('② 位置快照回落查询（locationPoint.findFirst）抛错：应仍建单（空快照）【SOS-01 缺陷断言】', async () => {
    const e = fallEnvelope(devSnapFail); // 无 payload.location → 走 last_point 回落查询
    const eventId = e.eventId as string;
    const fault = failOnce(
      prisma.locationPoint,
      'findFirst',
      new Error('audit: 轨迹表查询失败（模拟）'),
    );
    try {
      const res = await relay(http, owner.token, devSnapFail, [e]).expect(202);
      expect(res.body.accepted).toBe(1);
    } finally {
      fault.restore();
    }
    expect(fault.calls).toBe(1);
    expect(
      await prisma.rawEvent.findFirst({ where: { eventId } }),
    ).not.toBeNull();
    // 口径（决策 #26 ③）：都无则空快照照建单——副表查询失败不应阻断建单
    const c = await sosByEvent(prisma, eventId);
    expect(c).not.toBeNull();
    expect(c!.latitude).toBeNull();
  });

  it('③ 通知任务行已创建（事务已提交）后投递前中断：confirm 仍 200 notified（终态化已提交即成功，SOS-06）；下一轮扫描续投且恰好一次', async () => {
    const c = (await sosByEvent(
      prisma,
      (
        await (async () => {
          const e = fallEnvelope(devDeliverFail);
          await ingest.ingestRaw(JSON.stringify(e), devDeliverFail, 'mqtt');
          return e;
        })()
      ).eventId as string,
    ))!;
    // deliverPending 的第一步是 sosNotification.findMany：让它抛一次 = 事务提交后、发送前进程中断
    const fault = failOnce(
      prisma.sosNotification,
      'findMany',
      new Error('audit: 投递前中断（模拟）'),
    );
    let confirmRes: request.Response;
    try {
      confirmRes = await confirmSos(http, owner.token, c.id);
      await settleSosDelivery(app);
    } finally {
      fault.restore();
    }
    // 投递阶段的异常不外抛：App 拿到 200 + notified，与库内状态一致；投递由扫描按通知行续投
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe('notified');
    expect(
      (await prisma.sosCase.findUnique({ where: { id: c.id } }))!.status,
    ).toBe('notified');
    const before = await notificationsOf(prisma, c.id);
    expect(before.map((r) => [r.status, r.attempts])).toEqual([
      ['pending', 0],
      ['pending', 0],
    ]);
    expect(sosSmsCalls(mocks)).toHaveLength(0);
    await scheduler.tick();
    const after = await notificationsOf(prisma, c.id);
    expect(after.map((r) => [r.status, r.attempts])).toEqual([
      ['sent', 1],
      ['sent', 1],
    ]);
    expect(sosSmsCalls(mocks)).toHaveLength(1);
    expect(pushCallsTitled(mocks, 'SOS 已通知紧急联系人')).toHaveLength(1);
    await scheduler.tick();
    expect(sosSmsCalls(mocks)).toHaveLength(1);
  });

  it('④ attempts 占位后 Provider 挂起（不 resolve）：投递阶段被占住，但其他到期 SOS 照常终态化【SOS-05 修复验证】', async () => {
    let releaseHang: () => void = () => undefined;
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    mocks.sms.send.mockImplementation((_to, msg) =>
      msg.template === 'sos_alert' ? hang : Promise.resolve(),
    );
    const eHang = fallEnvelope(devHang);
    await ingest.ingestRaw(JSON.stringify(eHang), devHang, 'mqtt');
    const cHang = (await sosByEvent(prisma, eHang.eventId as string))!;
    // 走扫描路径终态化（与真实到期一致）：先让它到期
    await prisma.sosCase.update({
      where: { id: cHang.id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    const tick1 = scheduler.tick(); // 在挂起的 sms.send 上停住
    await sleep(300);
    expect(
      (await prisma.sosCase.findUnique({ where: { id: cHang.id } }))!.status,
    ).toBe('notified');
    const hungRow = (await notificationsOf(prisma, cHang.id)).find(
      (r) => r.channel === 'sms',
    )!;
    expect([hungRow.status, hungRow.attempts]).toEqual(['pending', 1]); // 已占位、未落结果
    // 另一台设备的 SOS 现在到期
    setCountdown('1');
    const eVictim = fallEnvelope(devHangVictim);
    await ingest.ingestRaw(JSON.stringify(eVictim), devHangVictim, 'mqtt');
    await sleep(1100);
    const ticks: Promise<void>[] = [];
    for (let i = 0; i < 5; i += 1) {
      ticks.push(scheduler.tick());
      await sleep(200);
    }
    await Promise.all(ticks);
    const victim = (await sosByEvent(prisma, eVictim.eventId as string))!;
    // 收尾：放开挂起，让 tick1 完成，避免拖住后续用例
    releaseHang();
    await tick1;
    // 期望：一条通知的 Provider 慢/挂起不应让其他用户的到期 SOS 停摆（应 notified）
    expect(victim.status).toBe('notified');
  });

  it('⑤ Provider 已接收、写 sent 时数据库瞬断一次：再试写成 sent，不记 failed、不重发（原来记 failed → 下一轮重发 → 同一联系人收到 2 条，10-17 评审）', async () => {
    // 排干 ④ 留下的到期单（victim 仍 pending 是 SOS-05 的证据）：先让它终态化并投递完，再清零 mock 计数
    await scheduler.tick();
    await scheduler.tick();
    resetMocks(mocks);
    const e = fallEnvelope(devSentFail);
    await ingest.ingestRaw(JSON.stringify(e), devSentFail, 'mqtt');
    const c = (await sosByEvent(prisma, e.eventId as string))!;
    const fault = failOnce(
      prisma.sosNotification,
      'updateMany',
      new Error('audit: sent 落库失败（模拟）'),
      {
        when: (args) =>
          (args as { data?: { status?: string } })?.data?.status === 'sent',
      },
    );
    try {
      await confirmSos(http, owner.token, c.id).expect(200);
      await settleSosDelivery(app);
    } finally {
      fault.restore();
    }
    const rows = await notificationsOf(prisma, c.id);
    const sms = rows.find((r) => r.channel === 'sms')!;
    // 发送成功（Provider 收到 1 次），写 sent 第一次失败、再试成功
    expect(sosSmsCalls(mocks)).toHaveLength(1);
    expect([sms.status, sms.attempts, sms.lastError]).toEqual([
      'sent',
      1,
      null,
    ]);
    await scheduler.tick();
    const smsAfter = (await notificationsOf(prisma, c.id)).find(
      (r) => r.channel === 'sms',
    )!;
    expect([smsAfter.status, smsAfter.attempts]).toEqual(['sent', 1]);
    expect(sosSmsCalls(mocks)).toHaveLength(1);
  });

  it('⑥ 同时 confirm 与 tick（deadline 已过，5 轮）：通知恰好一次，无重复发送', async () => {
    for (let round = 0; round < 5; round += 1) {
      resetMocks(mocks);
      const e = fallEnvelope(devConfirmTick);
      await ingest.ingestRaw(JSON.stringify(e), devConfirmTick, 'mqtt');
      const c = (await sosByEvent(prisma, e.eventId as string))!;
      await prisma.sosCase.update({
        where: { id: c.id },
        data: { deadline: new Date(Date.now() - 10) },
      });
      const [res] = await Promise.all([
        confirmSos(http, owner.token, c.id),
        scheduler.tick(),
      ]);
      expect([200, 409]).toContain(res.status);
      await scheduler.tick();
      // 首投在后台：与上面那轮、这一轮扫描都可能并行（同一联系人两条就是在这里抓到的），落定后再数
      await settleSosDelivery(app);
      const rows = await notificationsOf(prisma, c.id);
      expect(rows.map((r) => [r.channel, r.status, r.attempts])).toEqual([
        ['sms', 'sent', 1],
        ['push', 'sent', 1],
      ]);
      expect(sosSmsCalls(mocks)).toHaveLength(1);
      expect(pushCallsTitled(mocks, 'SOS 已通知紧急联系人')).toHaveLength(1);
      const detail = await request(http)
        .get(`/api/v1/accidents/${c.id}`)
        .set(auth(owner.token))
        .expect(200);
      expect(detail.body.status).toBe('notified');
    }
  });
});
