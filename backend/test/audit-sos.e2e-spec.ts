// 2026-09-13 全面审计 §4：SOS 状态机全链路逐层查实、语义、竞态、交叉操作、旧报告复验。
// 确定性优先：扫描间隔调到 10 分钟、全部到期转换由 scheduler.tick() 手动驱动；
// 倒计时按用例在建单前切换（countdownMs 每次建单时读取）：'600' 稳定 pending，'1' 走到期。
// 真实默认 60s 链路与真实扫描定时器见 audit-sos-realtime.e2e-spec.ts；真实进程重启见 evidence/sos/scripts。
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
  histogram,
  provisionDevice,
  relay,
  type Http,
  type TestUser,
  envelope,
} from './helpers/hardening';
import {
  activeOf,
  addContact,
  auditLocation,
  auth,
  buildSosApp,
  cancelSos,
  confirmSos,
  createAdmin,
  fallEnvelope,
  makeProviderMocks,
  manualEnvelope,
  notificationsOf,
  pushCallsTitled,
  resetMocks,
  sleep,
  sosByEvent,
  sosSmsCalls,
  waitForPushTitled,
  WsCollector,
} from './helpers/audit-sos';

jest.setTimeout(60000);

const mocks = makeProviderMocks();
const setCountdown = (s: string) => {
  process.env.SOS_COUNTDOWN_SECONDS = s;
};

describe('审计 §4 SOS 全链路与状态机 (e2e, 手动 tick)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let scheduler: SosSchedulerService;

  const run = Date.now();
  const devChain = `audit_sos_chain_${run}`;
  const devCancel = `audit_sos_cancel_${run}`;
  const devMerge = `audit_sos_merge_${run}`;
  const devEmpty = `audit_sos_empty_${run}`; // userC：零联系人、无昵称
  const devPartial = `audit_sos_partial_${run}`;
  const devSnap = `audit_sos_snap_${run}`;
  const devRace = `audit_sos_race_${run}`;
  const devRace2 = `audit_sos_race2_${run}`;
  const devContacts = `audit_sos_contacts_${run}`;
  const devRebind = `audit_sos_rebind_${run}`;
  const devRebind2 = `audit_sos_rebind2_${run}`;
  const devDelete = `audit_sos_delete_${run}`; // userD：注销账号
  const devMulti = `audit_sos_multi_${run}`;
  const devices = [
    devChain,
    devCancel,
    devMerge,
    devEmpty,
    devPartial,
    devSnap,
    devRace,
    devRace2,
    devContacts,
    devRebind,
    devRebind2,
    devDelete,
    devMulti,
  ];
  let owner: TestUser;
  let other: TestUser;
  let userC: TestUser;
  let userD: TestUser;
  let admin: { username: string; token: string };
  let ownerWs: WsCollector;

  const ownerContacts = [
    { name: '妈妈', phone: '19100000001' },
    { name: '爸爸', phone: '19100000002' },
    { name: '妈妈备用', phone: '19100000001' }, // 同号：通知去重
  ];

  const ingestFall = (deviceId: string, payload = {}, overrides = {}) => {
    const e = fallEnvelope(deviceId, payload, overrides);
    return ingest
      .ingestRaw(JSON.stringify(e), deviceId, 'mqtt')
      .then((outcome) => ({ outcome, eventId: e.eventId as string }));
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
    ingest = app.get(IngestService);
    scheduler = app.get(SosSchedulerService);
    owner = await createUser(app, http);
    other = await createUser(app, http);
    userC = await createUser(app, http);
    userD = await createUser(app, http);
    admin = await createAdmin(prisma, http, String(run));
    for (const d of devices) await provisionDevice(prisma, d);
    for (const d of devices.filter((d) => ![devEmpty, devDelete].includes(d)))
      await bindDevice(http, owner.token, d);
    await bindDevice(http, userC.token, devEmpty);
    await bindDevice(http, userD.token, devDelete);
    for (const c of ownerContacts)
      await addContact(http, owner.token, c.name, c.phone);
    await addContact(http, userD.token, '家人', '19100000009');
    ownerWs = await WsCollector.connect(app, owner.token);
  });

  beforeEach(() => {
    resetMocks(mocks);
    setCountdown('600');
  });

  afterAll(async () => {
    ownerWs?.close();
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, [owner, other, userC, userD]);
    await prisma.adminUser
      .delete({ where: { username: admin.username } })
      .catch(() => undefined);
    await app.close();
  });

  // ============ 1. 全链路逐层查实（蓝牙版 app-relay 入口 → raw → sos_cases → 通知行 → Provider → App/Admin） ============

  it('全链路：app-relay possible_fall → raw_events → sos_cases(deadline=服务器时间+倒计时) → WS/REST/Admin → 到期 → 通知行 → Provider 次数 → 详情脱敏', async () => {
    setCountdown('1');
    const skewed = new Date(Date.now() - 3600_000).toISOString(); // 设备时钟慢 1h
    const e = fallEnvelope(
      devChain,
      { location: auditLocation(1) },
      { timestamp: skewed },
    );
    const eventId = e.eventId as string;
    const before = Date.now();
    const res = await relay(http, owner.token, devChain, [e]).expect(202);
    const after = Date.now();
    expect(res.body).toEqual({ accepted: 1, duplicate: 0, invalid: 0 });

    // 层 1：raw_events
    const raw = await prisma.rawEvent.findFirstOrThrow({ where: { eventId } });
    expect(raw).toMatchObject({
      deviceId: devChain,
      eventType: 'possible_fall',
      source: 'app_relay',
      clockSkew: true,
    });

    // 层 2：sos_cases——deadline 以服务器接收时间为准（设备慢 1h 不影响）
    const c = await sosByEvent(prisma, eventId);
    expect(c).not.toBeNull();
    expect(c!.status).toBe('pending');
    expect(c!.userId).toBe(owner.id);
    expect(c!.triggerType).toBe('possible_fall');
    expect(c!.deadline.getTime()).toBeGreaterThanOrEqual(before + 1000 - 5);
    expect(c!.deadline.getTime()).toBeLessThanOrEqual(after + 1000 + 5);
    expect(
      c!.deadline.getTime() - c!.createdAt.getTime(),
    ).toBeGreaterThanOrEqual(900);
    expect(c!).toMatchObject({
      latitude: 30.501,
      longitude: 114.301,
      coordinateSystem: 'gcj02',
      accuracy: 8,
      locationSource: 'event',
    });
    // 层 3：建单阶段无通知行；本人倒计时 Push 恰 1 次
    expect(await notificationsOf(prisma, c!.id)).toHaveLength(0);
    // 倒计时 Push 是建单后的后台任务：等它发出再数，不能入口一返回就查 mock
    await waitForPushTitled(mocks, 'SOS 倒计时已开始');
    expect(pushCallsTitled(mocks, 'SOS 倒计时已开始')).toHaveLength(1);
    // iOS：带 App 注册的 "sos" 类别（远程推送上才有「取消」按钮）与时效性（穿透专注模式）
    expect(pushCallsTitled(mocks, 'SOS 倒计时已开始')[0][4]).toEqual({
      category: 'sos',
      timeSensitive: true,
    });
    expect(sosSmsCalls(mocks)).toHaveLength(0);
    // 层 4：App 展示面——WS sos_update(pending) / REST active / accidents 列表；Admin 列表
    const wsPending = await ownerWs.waitForSos(c!.id, 'pending');
    expect(wsPending.data.deadline).toBe(c!.deadline.toISOString());
    const active = await activeOf(http, owner.token, devChain).expect(200);
    expect(active.body.sos).toMatchObject({
      sosId: c!.id,
      status: 'pending',
      deadline: c!.deadline.toISOString(),
    });
    const list = await request(http)
      .get(`/api/v1/devices/${devChain}/accidents`)
      .set(auth(owner.token))
      .expect(200);
    expect(list.body.items[0]).toMatchObject({
      sosId: c!.id,
      status: 'pending',
      location: { source: 'event' },
    });
    const adminList = await request(http)
      .get('/api/v1/admin/accidents')
      .query({ deviceId: devChain })
      .set(auth(admin.token))
      .expect(200);
    expect(adminList.body.items[0]).toMatchObject({
      sosId: c!.id,
      status: 'pending',
      user: { id: owner.id },
    });

    // 到期：扫描 tick 前状态仍 pending（无内存 timer 抢跑）
    await sleep(1100);
    expect((await sosByEvent(prisma, eventId))!.status).toBe('pending');
    await scheduler.tick();
    const notified = (await sosByEvent(prisma, eventId))!;
    expect(notified.status).toBe('notified');
    expect(notified.finalizedAt).not.toBeNull();
    // 层 5：通知任务行——同号去重后 sms×2 + push×1，全部 sent、attempts=1
    const rows = await notificationsOf(prisma, notified.id);
    expect(rows.map((r) => [r.channel, r.status, r.attempts])).toEqual([
      ['sms', 'sent', 1],
      ['sms', 'sent', 1],
      ['push', 'sent', 1],
    ]);
    expect(
      rows
        .filter((r) => r.channel === 'sms')
        .map((r) => r.target)
        .sort(),
    ).toEqual(['19100000001', '19100000002']);
    // 层 6：Provider 调用次数（Mock 接收 ≠ 联系人真实收到）
    const smsCalls = sosSmsCalls(mocks);
    expect(smsCalls).toHaveLength(2);
    expect(smsCalls.map(([to]) => to).sort()).toEqual([
      '19100000001',
      '19100000002',
    ]);
    expect(smsCalls[0][1]).toMatchObject({
      template: 'sos_alert',
      params: { locationText: '30.50100,114.30100' },
    });
    expect(pushCallsTitled(mocks, 'SOS 已通知紧急联系人')).toHaveLength(1);
    // 已终态：只要时效性，不带 "sos" 类别（那上面的「取消」对已通知的单没有意义）
    expect(pushCallsTitled(mocks, 'SOS 已通知紧急联系人')[0][4]).toEqual({
      timeSensitive: true,
    });
    expect(mocks.push.send).toHaveBeenCalledTimes(2);
    // 层 7：App/Admin 终态展示——WS notified、active 为 null、详情通知记录脱敏、Admin 状态更新
    await ownerWs.waitForSos(notified.id, 'notified');
    expect(
      (await activeOf(http, owner.token, devChain).expect(200)).body.sos,
    ).toBeNull();
    const detail = await request(http)
      .get(`/api/v1/accidents/${notified.id}`)
      .set(auth(owner.token))
      .expect(200);
    expect(detail.body.status).toBe('notified');
    expect(detail.body.triggerPayload).toMatchObject({ confidence: 0.9 });
    const smsPublic = (
      detail.body.notifications as Array<{
        channel: string;
        target: string;
        status: string;
      }>
    ).filter((n) => n.channel === 'sms');
    expect(smsPublic.map((n) => n.target).sort()).toEqual([
      '191****0001',
      '191****0002',
    ]);
    expect(JSON.stringify(detail.body)).not.toContain('19100000001');
    const adminAfter = await request(http)
      .get('/api/v1/admin/accidents')
      .query({ deviceId: devChain, status: 'notified' })
      .set(auth(admin.token))
      .expect(200);
    expect(adminAfter.body.total).toBe(1);
  });

  // ============ 3. 取消 / SOS Now / 重复触发 / 升级 / 终态后新单 ============

  it('取消：pending → cancelled；0 通知行、0 Provider 调用；再取消/确认 409；WS cancelled；active 为 null', async () => {
    const { eventId } = await ingestFall(devCancel);
    const c = (await sosByEvent(prisma, eventId))!;
    const res = await cancelSos(http, owner.token, c.id).expect(200);
    expect(res.body.status).toBe('cancelled');
    await ownerWs.waitForSos(c.id, 'cancelled');
    expect(await notificationsOf(prisma, c.id)).toHaveLength(0);
    expect(sosSmsCalls(mocks)).toHaveLength(0);
    expect(pushCallsTitled(mocks, 'SOS 已通知紧急联系人')).toHaveLength(0);
    expect(
      (await cancelSos(http, owner.token, c.id).expect(409)).body.code,
    ).toBe('SOS_ALREADY_FINALIZED');
    expect(
      (await confirmSos(http, owner.token, c.id).expect(409)).body.code,
    ).toBe('SOS_ALREADY_FINALIZED');
    expect(
      (await activeOf(http, owner.token, devCancel).expect(200)).body.sos,
    ).toBeNull();
    // 到期扫描不会复活已取消单
    await scheduler.tick();
    expect((await sosByEvent(prisma, eventId))!.status).toBe('cancelled');
  });

  it('重复触发/升级/终态后新单：重复 possible_fall 只留档；同 eventId 重放 duplicate；pending 中 manual_sos 立即通知；终态后新事件建新单，旧单处置不污染新单', async () => {
    const first = await ingestFall(devMerge);
    const c1 = (await sosByEvent(prisma, first.eventId))!;
    // 重复 possible_fall（新 eventId）：留档不建单
    const second = await ingestFall(devMerge);
    expect(second.outcome).toBe('stored');
    expect(await sosByEvent(prisma, second.eventId)).toBeNull();
    expect(await prisma.sosCase.count({ where: { deviceId: devMerge } })).toBe(
      1,
    );
    // 同 eventId 重放：幂等
    const replay = await ingest.ingestRaw(
      JSON.stringify(fallEnvelope(devMerge, {}, { eventId: first.eventId })),
      devMerge,
      'mqtt',
    );
    expect(replay).toBe('duplicate');
    expect(await prisma.rawEvent.count({ where: { deviceId: devMerge } })).toBe(
      2,
    );
    // pending 中设备 manual_sos → 不建单、立即 notified
    const m = manualEnvelope(devMerge);
    expect(await ingest.ingestRaw(JSON.stringify(m), devMerge, 'mqtt')).toBe(
      'stored',
    );
    expect(await sosByEvent(prisma, m.eventId as string)).toBeNull();
    const afterManual = (await sosByEvent(prisma, first.eventId))!;
    expect(afterManual.status).toBe('notified');
    expect(await notificationsOf(prisma, c1.id)).toHaveLength(3);
    expect(sosSmsCalls(mocks)).toHaveLength(2);
    // 终态后新事件 → 新单 pending
    const third = await ingestFall(devMerge);
    const c2 = (await sosByEvent(prisma, third.eventId))!;
    expect(c2.status).toBe('pending');
    expect(c2.id).not.toBe(c1.id);
    expect(await prisma.sosCase.count({ where: { deviceId: devMerge } })).toBe(
      2,
    );
    // 旧单处置不污染新单
    expect(
      (await cancelSos(http, owner.token, c1.id).expect(409)).body.code,
    ).toBe('SOS_ALREADY_FINALIZED');
    expect(
      (await activeOf(http, owner.token, devMerge).expect(200)).body.sos.sosId,
    ).toBe(c2.id);
    resetMocks(mocks);
    await confirmSos(http, owner.token, c2.id).expect(200);
    expect(await notificationsOf(prisma, c1.id)).toHaveLength(3);
    expect(await notificationsOf(prisma, c2.id)).toHaveLength(3);
    expect(sosSmsCalls(mocks)).toHaveLength(2);
    await scheduler.tick();
    expect(
      (await notificationsOf(prisma, c1.id)).every((r) => r.attempts === 1),
    ).toBe(true);
  });

  // ============ 7. 语义核对：notified / 任务创建 / Provider 接收 / 联系人实际收到 ============

  it('无联系人：notified 只有本人 push 行；Push 明确告知「未设置紧急联系人」而非宣称已通知（SOS-04 修复验证）', async () => {
    const e = fallEnvelope(devEmpty);
    expect(await ingest.ingestRaw(JSON.stringify(e), devEmpty, 'mqtt')).toBe(
      'stored',
    );
    const c = (await sosByEvent(prisma, e.eventId as string))!;
    await confirmSos(http, userC.token, c.id).expect(200);
    const rows = await notificationsOf(prisma, c.id);
    expect(rows.map((r) => r.channel)).toEqual(['push']);
    expect(sosSmsCalls(mocks)).toHaveLength(0);
    // 0 个联系人：标题不得宣称已通知；改为引导用户直接求助
    expect(pushCallsTitled(mocks, 'SOS 已通知紧急联系人')).toHaveLength(0);
    expect(pushCallsTitled(mocks, 'SOS 未设置紧急联系人')).toHaveLength(1);
  });

  it('联系人短信全部失败时，本人 Push 不宣称「已通知紧急联系人」而是提示发送失败【SOS-04 修复验证】', async () => {
    mocks.sms.send.mockImplementation((_to, msg) =>
      msg.template === 'sos_alert'
        ? Promise.reject(new Error('audit: 运营商拒发'))
        : Promise.resolve(),
    );
    const { eventId } = await ingestFall(devPartial);
    const c = (await sosByEvent(prisma, eventId))!;
    await confirmSos(http, owner.token, c.id).expect(200);
    const rows = await notificationsOf(prisma, c.id);
    expect(
      rows
        .filter((r) => r.channel === 'sms')
        .every((r) => r.status === 'failed'),
    ).toBe(true);
    // 此时 sos.status 已是 notified（= 任务已创建），联系人 0 人收到；本人 Push 文案却断言已通知
    const claim = pushCallsTitled(mocks, 'SOS 已通知紧急联系人');
    expect((await sosByEvent(prisma, eventId))!.status).toBe('notified');
    // 期望：全部失败时不应向用户宣称联系人已被通知（至少文案/状态需区分「已下发任务」与「已送达」）
    expect(claim).toHaveLength(0);
  });

  it('通知部分失败 → 只重试失败行；达 SOS_NOTIFY_MAX_ATTEMPTS=3 后终态 failed 不再投递；成功行不重发', async () => {
    // 排干上一用例（SOS-04 缺陷断言）留下的 failed 行：mock 已恢复成功，两轮 tick 后它们终态 sent，
    // 不再混入本用例的 Provider 调用计数（sms mock 无法按 sosId 区分）
    await scheduler.tick();
    await scheduler.tick();
    resetMocks(mocks);
    mocks.sms.send.mockImplementation((to, msg) =>
      msg.template === 'sos_alert' && to === '19100000002'
        ? Promise.reject(new Error('audit: 目标号码失败'))
        : Promise.resolve(),
    );
    const { eventId } = await ingestFall(devPartial);
    const c = (await sosByEvent(prisma, eventId))!;
    await confirmSos(http, owner.token, c.id).expect(200);
    const byTarget = async () =>
      Object.fromEntries(
        (await notificationsOf(prisma, c.id)).map((r) => [
          r.target,
          [r.status, r.attempts, r.lastError],
        ]),
      );
    expect(await byTarget()).toEqual({
      '19100000001': ['sent', 1, null],
      '19100000002': ['failed', 1, 'audit: 目标号码失败'],
      [`user:${owner.id}`]: ['sent', 1, null],
    });
    await scheduler.tick();
    await scheduler.tick();
    expect((await byTarget())['19100000002']).toEqual([
      'failed',
      3,
      'audit: 目标号码失败',
    ]);
    await scheduler.tick();
    await scheduler.tick();
    expect((await byTarget())['19100000002']).toEqual([
      'failed',
      3,
      'audit: 目标号码失败',
    ]);
    expect(
      sosSmsCalls(mocks).filter(([to]) => to === '19100000002'),
    ).toHaveLength(3);
    expect(
      sosSmsCalls(mocks).filter(([to]) => to === '19100000001'),
    ).toHaveLength(1);
    // 详情如实暴露 failed（App 可据此区分，但 sos-active 页只看 sos.status）
    const detail = await request(http)
      .get(`/api/v1/accidents/${c.id}`)
      .set(auth(owner.token))
      .expect(200);
    expect(
      (
        detail.body.notifications as Array<{
          target: string;
          status: string;
          attempts: number;
        }>
      ).find((n) => n.target === '191****0002'),
    ).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('旧报告 #16 复验：无昵称用户短信 {1} 回落为脱敏手机号（不再是 deviceId 前缀）', async () => {
    const e = fallEnvelope(devEmpty);
    await ingest.ingestRaw(JSON.stringify(e), devEmpty, 'mqtt');
    const c = (await sosByEvent(prisma, e.eventId as string))!;
    // userC 无联系人 → 借 devPartial（owner，有联系人）看模板参数；owner 注册时也无昵称
    await cancelSos(http, userC.token, c.id).expect(200);
    const { eventId } = await ingestFall(devPartial);
    const oc = (await sosByEvent(prisma, eventId))!;
    await confirmSos(http, owner.token, oc.id).expect(200);
    const [, msg] = sosSmsCalls(mocks)[0];
    expect(msg.template).toBe('sos_alert');
    if (msg.template === 'sos_alert') {
      expect(msg.params.nickname).toBe(
        `${owner.phone.slice(0, 3)}****${owner.phone.slice(-4)}`,
      );
      expect(msg.params.nickname).not.toContain('audit_sos');
      expect(msg.params.nickname.length).toBeLessThanOrEqual(12);
    }
  });

  // ============ 位置快照 ============

  it('事件坐标非法（lat=91 / 缺 coordinateSystem）→ 回落最新轨迹点；无轨迹 → 空快照照建单；SMS 位置文本「暂不可用」', async () => {
    const noPoint = await ingestFall(devSnap, {
      location: { latitude: 91, longitude: 114.3, coordinateSystem: 'gcj02' },
    });
    const c0 = (await sosByEvent(prisma, noPoint.eventId))!;
    expect(c0).toMatchObject({
      latitude: null,
      longitude: null,
      locationSource: null,
    });
    await confirmSos(http, owner.token, c0.id).expect(200);
    expect(sosSmsCalls(mocks)[0][1]).toMatchObject({
      params: { locationText: '暂不可用' },
    });
    // 预置轨迹点后：非法坐标回落 last_point
    await ingest.ingestRaw(
      JSON.stringify(
        envelope(devSnap, 'location_update', {
          latitude: 30.7,
          longitude: 114.7,
          coordinateSystem: 'wgs84',
          accuracy: 5,
          speed: 1,
          heading: 10,
        }),
      ),
      devSnap,
      'mqtt',
    );
    const fb = await ingestFall(devSnap, {
      location: { latitude: 30.7, longitude: 114.7 },
    });
    const c1 = (await sosByEvent(prisma, fb.eventId))!;
    expect(c1).toMatchObject({
      latitude: 30.7,
      longitude: 114.7,
      coordinateSystem: 'wgs84',
      locationSource: 'last_point',
    });
    await cancelSos(http, owner.token, c1.id).expect(200);
  });

  // ============ 4. 竞态 ============

  it('复验：同设备 25 个并发 possible_fall 恰 1 单；同 eventId 并发重放 10 次仅 1 次 stored', async () => {
    const events = Array.from({ length: 25 }, () => fallEnvelope(devRace));
    const outcomes = await Promise.all(
      events.map((e) => ingest.ingestRaw(JSON.stringify(e), devRace, 'mqtt')),
    );
    expect(outcomes.every((o) => o === 'stored')).toBe(true);
    expect(await prisma.sosCase.count({ where: { deviceId: devRace } })).toBe(
      1,
    );
    expect(
      await prisma.rawEvent.count({
        where: { deviceId: devRace, eventType: 'possible_fall' },
      }),
    ).toBe(25);
    const same = fallEnvelope(devRace);
    const replay = await Promise.all(
      Array.from({ length: 10 }, () =>
        ingest.ingestRaw(JSON.stringify(same), devRace, 'mqtt'),
      ),
    );
    expect(histogram(replay.map((o) => (o === 'stored' ? 1 : 0)))).toEqual({
      '0': 9,
      '1': 1,
    });
    expect(await prisma.sosCase.count({ where: { deviceId: devRace } })).toBe(
      1,
    );
    await waitForPushTitled(mocks, 'SOS 倒计时已开始');
    expect(pushCallsTitled(mocks, 'SOS 倒计时已开始')).toHaveLength(1);
  });

  it('复验：cancel×5 + confirm×5 并发（含同账号第二台 App 的 token）恰 1 个 200，其余 409；通知最多一轮', async () => {
    const c = (await sosByEvent(prisma, (await ingestFall(devRace2)).eventId))!;
    // 同账号第二台 App：再登录一次拿另一个 access token
    const login = await request(http)
      .post('/api/v1/auth/login')
      .send({ phone: owner.phone, password: owner.password })
      .expect(200);
    const token2 = login.body.accessToken as string;
    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => cancelSos(http, owner.token, c.id)),
      ...Array.from({ length: 2 }, () => cancelSos(http, token2, c.id)),
      ...Array.from({ length: 3 }, () => confirmSos(http, owner.token, c.id)),
      ...Array.from({ length: 2 }, () => confirmSos(http, token2, c.id)),
    ]);
    expect(histogram(results.map((r) => r.status))).toEqual({
      '200': 1,
      '409': 9,
    });
    const final = (await sosByEvent(prisma, c.triggerEventId))!;
    expect(['cancelled', 'notified']).toContain(final.status);
    const rows = await notificationsOf(prisma, c.id);
    if (final.status === 'cancelled') {
      expect(rows).toHaveLength(0);
      expect(sosSmsCalls(mocks)).toHaveLength(0);
    } else {
      expect(rows).toHaveLength(3);
      expect(sosSmsCalls(mocks)).toHaveLength(2);
    }
    await scheduler.tick();
    expect(sosSmsCalls(mocks).length).toBeLessThanOrEqual(2);
  });

  it('cancel 与 到期扫描 tick 同刻（5 轮）：终态唯一；cancelled → 0 通知，notified → 恰一轮通知且 cancel 得 409', async () => {
    for (let round = 0; round < 5; round += 1) {
      resetMocks(mocks);
      setCountdown('1');
      const c = (await sosByEvent(
        prisma,
        (await ingestFall(devRace2)).eventId,
      ))!;
      await sleep(1050);
      const [cancelRes] = await Promise.all([
        cancelSos(http, owner.token, c.id),
        scheduler.tick(),
      ]);
      const final = (await sosByEvent(prisma, c.triggerEventId))!;
      const rows = await notificationsOf(prisma, c.id);
      if (cancelRes.status === 200) {
        expect(final.status).toBe('cancelled');
        expect(rows).toHaveLength(0);
        expect(sosSmsCalls(mocks)).toHaveLength(0);
      } else {
        expect(cancelRes.status).toBe(409);
        expect(final.status).toBe('notified');
        expect(rows.map((r) => r.attempts)).toEqual([1, 1, 1]);
        expect(sosSmsCalls(mocks)).toHaveLength(2);
      }
      await scheduler.tick();
      expect(sosSmsCalls(mocks).length).toBeLessThanOrEqual(2);
    }
  });

  it('confirm 与 到期扫描 tick 同刻（5 轮）：通知恰好一轮（sms=2 去重后、push=1），attempts 均为 1', async () => {
    for (let round = 0; round < 5; round += 1) {
      resetMocks(mocks);
      setCountdown('1');
      const c = (await sosByEvent(
        prisma,
        (await ingestFall(devRace2)).eventId,
      ))!;
      await sleep(1050);
      const [confirmRes] = await Promise.all([
        confirmSos(http, owner.token, c.id),
        scheduler.tick(),
        scheduler.tick(),
      ]);
      expect([200, 409]).toContain(confirmRes.status);
      expect((await sosByEvent(prisma, c.triggerEventId))!.status).toBe(
        'notified',
      );
      await scheduler.tick();
      const rows = await notificationsOf(prisma, c.id);
      expect(rows.map((r) => [r.status, r.attempts])).toEqual([
        ['sent', 1],
        ['sent', 1],
        ['sent', 1],
      ]);
      expect(sosSmsCalls(mocks)).toHaveLength(2);
      expect(pushCallsTitled(mocks, 'SOS 已通知紧急联系人')).toHaveLength(1);
    }
  });

  // ============ 8. 交叉操作 ============

  it('联系人在 pending 期间增删改：finalize 时点读取——新增的收到、删除的不收、改号后按新号发', async () => {
    const c = (await sosByEvent(
      prisma,
      (await ingestFall(devContacts)).eventId,
    ))!;
    const added = await addContact(http, owner.token, '新人', '19100000003');
    const list = await request(http)
      .get('/api/v1/users/me/emergency-contacts')
      .set(auth(owner.token))
      .expect(200);
    const dad = (list.body as Array<{ id: string; name: string }>).find(
      (x) => x.name === '爸爸',
    )!;
    const mom = (list.body as Array<{ id: string; name: string }>).find(
      (x) => x.name === '妈妈',
    )!;
    await request(http)
      .delete(`/api/v1/users/me/emergency-contacts/${dad.id}`)
      .set(auth(owner.token))
      .expect(204);
    await request(http)
      .patch(`/api/v1/users/me/emergency-contacts/${mom.id}`)
      .set(auth(owner.token))
      .send({ phone: '19100000004' })
      .expect(200);
    await confirmSos(http, owner.token, c.id).expect(200);
    const targets = (await notificationsOf(prisma, c.id))
      .filter((r) => r.channel === 'sms')
      .map((r) => r.target)
      .sort();
    // 妈妈改号 → 19100000004；妈妈备用仍 19100000001；新人 19100000003；爸爸已删
    expect(targets).toEqual(['19100000001', '19100000003', '19100000004']);
    expect(
      sosSmsCalls(mocks)
        .map(([to]) => to)
        .sort(),
    ).toEqual(targets);
    // 复原联系人集合供后续用例
    await request(http)
      .delete(`/api/v1/users/me/emergency-contacts/${added.body.id as string}`)
      .set(auth(owner.token))
      .expect(204);
    await request(http)
      .patch(`/api/v1/users/me/emergency-contacts/${mom.id}`)
      .set(auth(owner.token))
      .send({ phone: '19100000001' })
      .expect(200);
    await addContact(http, owner.token, '爸爸', '19100000002');
  });

  it('pending 中换绑：原主可处置、新主 active 为 null 且不能取消；到期通知原主联系人（不通知新主）', async () => {
    setCountdown('1');
    const c = (await sosByEvent(
      prisma,
      (await ingestFall(devRebind)).eventId,
    ))!;
    await request(http)
      .delete(`/api/v1/devices/${devRebind}/binding`)
      .set(auth(owner.token))
      .expect(204);
    await bindDevice(http, other.token, devRebind);
    await addContact(http, other.token, '新主家人', '19100000008');
    expect(
      (await activeOf(http, other.token, devRebind).expect(200)).body.sos,
    ).toBeNull();
    await cancelSos(http, other.token, c.id).expect(404);
    await sleep(1050);
    await scheduler.tick();
    const rows = await notificationsOf(prisma, c.id);
    expect((await sosByEvent(prisma, c.triggerEventId))!.status).toBe(
      'notified',
    );
    expect(
      rows
        .filter((r) => r.channel === 'sms')
        .map((r) => r.target)
        .sort(),
    ).toEqual(['19100000001', '19100000002']);
    expect(rows.find((r) => r.channel === 'push')!.target).toBe(
      `user:${owner.id}`,
    );
    expect(sosSmsCalls(mocks).map(([to]) => to)).not.toContain('19100000008');
  });

  it('换绑后旧主 SOS 仍 pending 时，新主头盔的 possible_fall 为新主建单，不并入旧主的单【SOS-03 修复验证，决策 #40】', async () => {
    const c = (await sosByEvent(
      prisma,
      (await ingestFall(devRebind2)).eventId,
    ))!;
    await request(http)
      .delete(`/api/v1/devices/${devRebind2}/binding`)
      .set(auth(owner.token))
      .expect(204);
    await bindDevice(http, other.token, devRebind2);
    const e = fallEnvelope(devRebind2, { location: auditLocation(2) });
    // 新主的 App 经 app-relay 中转自己头盔的摔倒事件
    const res = await relay(http, other.token, devRebind2, [e]).expect(202);
    expect(res.body.accepted).toBe(1);
    expect((await sosByEvent(prisma, c.triggerEventId))!.userId).toBe(owner.id);
    const mine = await activeOf(http, other.token, devRebind2).expect(200);
    // 期望：新主有自己的进行中 SOS；实际：合并规则只看 deviceId+pending，不看 userId → 新主事件被吞
    expect(mine.body.sos).not.toBeNull();
    expect(mine.body.sos.userId ?? other.id).toBe(other.id);
  });

  it('换绑后新主头盔的 manual_sos 不把旧主的 pending 单升级、不通知旧主联系人【SOS-03 修复验证，决策 #40】', async () => {
    // 前一用例留下：devRebind2 上 owner 的 pending 单（若前一用例已失败，单仍 pending）
    // 上一用例之后该设备上有两张 pending（旧主的 + 新主的，决策 #40 两单并存）：按旧主筛，
    // 不加 userId 时 findFirst 无排序、取到哪张由执行计划决定（10-16 全量跑偶发取到新主那张）
    const pending = await prisma.sosCase.findFirst({
      where: { deviceId: devRebind2, status: 'pending', userId: owner.id },
    });
    expect(pending).not.toBeNull();
    expect(pending!.userId).toBe(owner.id);
    const m = manualEnvelope(devRebind2);
    await relay(http, other.token, devRebind2, [m]).expect(202);
    const after = (await prisma.sosCase.findUnique({
      where: { id: pending!.id },
    }))!;
    const smsTargets = sosSmsCalls(mocks).map(([to]) => to);
    // 期望：旧主的单不受新主事件影响（仍 pending）且旧主联系人未被通知；新主自己应有单
    expect(smsTargets).not.toContain('19100000001');
    expect(after.status).toBe('pending');
    // 清场：把残留 pending 单取消，避免污染 afterAll 前的其他用例
    await cancelSos(http, owner.token, pending!.id).catch(() => undefined);
  });

  it('pending 中注销账号：旧 token 全 401（无人可取消）；到期照终态化 notified，联系人已软删 → 0 条 SMS，push 行仍写给已注销用户', async () => {
    setCountdown('1');
    const e = fallEnvelope(devDelete);
    await relay(http, userD.token, devDelete, [e]).expect(202);
    const c = (await sosByEvent(prisma, e.eventId as string))!;
    await request(http)
      .delete('/api/v1/users/me')
      .set(auth(userD.token))
      .send({ password: userD.password })
      .expect(204);
    expect((await cancelSos(http, userD.token, c.id)).status).toBe(401);
    expect((await confirmSos(http, userD.token, c.id)).status).toBe(401);
    expect(
      (await prisma.device.findUnique({ where: { deviceId: devDelete } }))!
        .bindUserId,
    ).toBeNull();
    await sleep(1050);
    await scheduler.tick();
    const final = (await sosByEvent(prisma, c.triggerEventId))!;
    expect(final.status).toBe('notified');
    const rows = await notificationsOf(prisma, c.id);
    expect(rows.map((r) => r.channel)).toEqual(['push']);
    expect(sosSmsCalls(mocks)).toHaveLength(0);
    // 联系人已随注销软删 → 0 条短信：Push 按 SOS-04 口径提示「未设置紧急联系人」，不宣称已通知
    expect(pushCallsTitled(mocks, 'SOS 未设置紧急联系人')).toHaveLength(1);
    // Admin 仍可见（归属为已注销用户，phone 已改写）
    const adminList = await request(http)
      .get('/api/v1/admin/accidents')
      .query({ deviceId: devDelete })
      .set(auth(admin.token))
      .expect(200);
    expect(adminList.body.items[0].user.phone).toBe(`deleted:${userD.id}`);
  });

  it('同账号多台 App：两台各自 WS 都收到 sos_update；一台取消后另一台 REST active 为 null', async () => {
    const login = await request(http)
      .post('/api/v1/auth/login')
      .send({ phone: owner.phone, password: owner.password })
      .expect(200);
    const token2 = login.body.accessToken as string;
    const ws2 = await WsCollector.connect(app, token2);
    try {
      const c = (await sosByEvent(
        prisma,
        (await ingestFall(devMulti)).eventId,
      ))!;
      await ownerWs.waitForSos(c.id, 'pending');
      await ws2.waitForSos(c.id, 'pending');
      await cancelSos(http, token2, c.id).expect(200);
      await ownerWs.waitForSos(c.id, 'cancelled');
      await ws2.waitForSos(c.id, 'cancelled');
      expect(
        (await activeOf(http, owner.token, devMulti).expect(200)).body.sos,
      ).toBeNull();
    } finally {
      ws2.close();
    }
  });
});
