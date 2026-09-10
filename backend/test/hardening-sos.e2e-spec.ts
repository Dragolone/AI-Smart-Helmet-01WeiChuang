// 上线前加固：SOS 状态机的并发与竞态——保命链路只允许「恰好一次」。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PUSH_PROVIDER } from '../src/providers/push.provider';
import { SMS_PROVIDER } from '../src/providers/sms.provider';
import { SosSchedulerService } from '../src/sos/sos-scheduler.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  histogram,
  provisionDevice,
  relay,
  sleep,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

describe('加固：SOS 并发与竞态 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let scheduler: SosSchedulerService;

  const run = Date.now();
  const devRace = `hard_sos_race_${run}`;
  const devCancel = `hard_sos_cancel_${run}`;
  const devTick = `hard_sos_tick_${run}`;
  const devRebind = `hard_sos_rebind_${run}`;
  const devSnap = `hard_sos_snap_${run}`;
  const devPush = `hard_sos_push_${run}`;
  const devices = [devRace, devCancel, devTick, devRebind, devSnap, devPush];
  let owner: TestUser;
  let other: TestUser;

  const smsMock = { send: jest.fn<Promise<void>, [string, unknown]>() };
  const pushMock = { send: jest.fn<Promise<void>, [string, string, string]>() };

  const fall = (deviceId: string, payload: Record<string, unknown> = {}) =>
    ingest.ingestRaw(
      JSON.stringify(envelope(deviceId, 'possible_fall', payload)),
      deviceId,
      'mqtt',
    );

  const pendingOf = (deviceId: string) =>
    prisma.sosCase.findMany({ where: { deviceId, status: 'pending' } });

  beforeAll(async () => {
    process.env.SOS_COUNTDOWN_SECONDS = '1';
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    process.env.SOS_NOTIFY_MAX_ATTEMPTS = '3';
    ({ app, http, prisma } = await buildApp((b) =>
      b
        .overrideProvider(SMS_PROVIDER)
        .useValue(smsMock)
        .overrideProvider(PUSH_PROVIDER)
        .useValue(pushMock),
    ));
    ingest = app.get(IngestService);
    scheduler = app.get(SosSchedulerService);
    owner = await createUser(app, http);
    other = await createUser(app, http);
    for (const d of devices) {
      await provisionDevice(prisma, d);
      await bindDevice(http, owner.token, d);
    }
    // 3 个联系人，其中两个同号（通知需去重）
    for (const c of [
      { name: '甲', phone: '13900000001' },
      { name: '乙', phone: '13900000002' },
      { name: '丙', phone: '13900000001' },
    ]) {
      await request(http)
        .post('/api/v1/users/me/emergency-contacts')
        .set(auth(owner.token))
        .send(c)
        .expect(201);
    }
  });

  beforeEach(() => {
    smsMock.send.mockReset().mockResolvedValue(undefined);
    pushMock.send.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, [owner, other]);
    await app.close();
  });

  it('同设备 25 个并发 possible_fall（不同 eventId）：恰好 1 个 pending，raw 25 条全留档', async () => {
    const events = Array.from({ length: 25 }, () =>
      envelope(devRace, 'possible_fall', {}),
    );
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
    // 相同 eventId 重放 10 次：不建单、不重复
    const same = envelope(devRace, 'possible_fall', {});
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
  });

  it('cancel 与 confirm 并发各 5 次：恰好 1 个 200，其余 409；终态只有一种，通知只发一轮', async () => {
    await fall(devCancel);
    const [sos] = await pendingOf(devCancel);
    const calls = [
      ...Array.from({ length: 5 }, () =>
        request(http)
          .post(`/api/v1/sos/${sos.id}/cancel`)
          .set(auth(owner.token)),
      ),
      ...Array.from({ length: 5 }, () =>
        request(http)
          .post(`/api/v1/sos/${sos.id}/confirm`)
          .set(auth(owner.token)),
      ),
    ];
    const results = await Promise.all(calls);
    const h = histogram(results.map((r) => r.status));
    console.log('[cancel×5 + confirm×5]', h);
    expect(h['200']).toBe(1);
    expect(h['409']).toBe(9);
    const final = await prisma.sosCase.findUniqueOrThrow({
      where: { id: sos.id },
    });
    expect(['cancelled', 'notified']).toContain(final.status);
    const notifications = await prisma.sosNotification.count({
      where: { sosId: sos.id },
    });
    expect(notifications).toBe(final.status === 'notified' ? 3 : 0);
    // 终态后新事件正常建新单
    await fall(devCancel);
    expect(await prisma.sosCase.count({ where: { deviceId: devCancel } })).toBe(
      2,
    );
  });

  it('到期后 10 个并发 tick：每条通知只投递一次（同号去重后 sms=2、push=1，attempts 均为 1）', async () => {
    await fall(devTick);
    const [sos] = await pendingOf(devTick);
    // 扫描是全局的：先把本套件其他设备遗留的 pending 取消，保证计数只属于本单
    await prisma.sosCase.updateMany({
      where: {
        deviceId: { in: devices },
        status: 'pending',
        id: { not: sos.id },
      },
      data: { status: 'cancelled', finalizedAt: new Date() },
    });
    await sleep(1200);
    await Promise.all(Array.from({ length: 10 }, () => scheduler.tick()));
    // running 互斥会让并发 tick 大多直接返回；再单独补一轮确保处理完
    await scheduler.tick();
    const final = await prisma.sosCase.findUniqueOrThrow({
      where: { id: sos.id },
    });
    expect(final.status).toBe('notified');
    const rows = await prisma.sosNotification.findMany({
      where: { sosId: sos.id },
    });
    expect(rows.filter((r) => r.channel === 'sms')).toHaveLength(2);
    expect(rows.filter((r) => r.channel === 'push')).toHaveLength(1);
    expect(rows.every((r) => r.status === 'sent' && r.attempts === 1)).toBe(
      true,
    );
    expect(smsMock.send).toHaveBeenCalledTimes(2);
    expect(
      pushMock.send.mock.calls.filter((c) => c[1] === 'SOS 已通知紧急联系人'),
    ).toHaveLength(1);
  });

  it('通知失败重试到上限即止：attempts=3 且 failed，再 tick 不再增加', async () => {
    smsMock.send.mockRejectedValue(new Error('网关超时'));
    await fall(devTick);
    const [sos] = await pendingOf(devTick);
    await request(http)
      .post(`/api/v1/sos/${sos.id}/confirm`)
      .set(auth(owner.token))
      .expect(200);
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    const sms = await prisma.sosNotification.findMany({
      where: { sosId: sos.id, channel: 'sms' },
    });
    expect(sms).toHaveLength(2);
    expect(sms.every((r) => r.status === 'failed' && r.attempts === 3)).toBe(
      true,
    );
    expect(smsMock.send).toHaveBeenCalledTimes(6);
    // 事故详情里手机号脱敏
    const detail = await request(http)
      .get(`/api/v1/accidents/${sos.id}`)
      .set(auth(owner.token))
      .expect(200);
    const targets = (
      detail.body.notifications as Array<{ target: string }>
    ).map((n) => n.target);
    expect(targets.some((t) => t.includes('13900000001'))).toBe(false);
  });

  it('他人无法取消/确认/查看；解绑后原主仍可处置；换绑新主看不到旧单，旧单到期仍通知旧主联系人', async () => {
    await fall(devRebind);
    const [sos] = await pendingOf(devRebind);
    await request(http)
      .post(`/api/v1/sos/${sos.id}/cancel`)
      .set(auth(other.token))
      .expect(404);
    await request(http)
      .post(`/api/v1/sos/${sos.id}/confirm`)
      .set(auth(other.token))
      .expect(404);
    await request(http)
      .get(`/api/v1/accidents/${sos.id}`)
      .set(auth(other.token))
      .expect(404);

    await request(http)
      .delete(`/api/v1/devices/${devRebind}/binding`)
      .set(auth(owner.token))
      .expect(204);
    // 解绑后设备接口 404，但进行中的 SOS 处置权仍在原主
    await request(http)
      .get(`/api/v1/devices/${devRebind}/sos/active`)
      .set(auth(owner.token))
      .expect(404);
    await bindDevice(http, other.token, devRebind);
    const activeForNew = await request(http)
      .get(`/api/v1/devices/${devRebind}/sos/active`)
      .set(auth(other.token))
      .expect(200);
    expect(activeForNew.body.sos).toBeNull();

    await sleep(1200);
    await scheduler.tick();
    const final = await prisma.sosCase.findUniqueOrThrow({
      where: { id: sos.id },
    });
    expect(final.status).toBe('notified');
    expect(final.userId).toBe(owner.id);
    expect(smsMock.send).toHaveBeenCalledTimes(2);
    // 原主事故详情仍可见（userId 固化）
    await request(http)
      .get(`/api/v1/accidents/${sos.id}`)
      .set(auth(owner.token))
      .expect(200);
    // 新主设备已被换绑：新主上报的 fall 建新单归新主
    await fall(devRebind);
    const mine = await prisma.sosCase.findFirst({
      where: { deviceId: devRebind, status: 'pending' },
    });
    expect(mine?.userId).toBe(other.id);
  });

  it('位置快照：事件坐标非法（lat=91）→ 回落最新轨迹点；无轨迹点 → 空但照建单', async () => {
    await fall(devSnap, {
      location: { latitude: 91, longitude: 0, coordinateSystem: 'wgs84' },
    });
    const first = await prisma.sosCase.findFirstOrThrow({
      where: { deviceId: devSnap },
    });
    expect(first.latitude).toBeNull();
    expect(first.locationSource).toBeNull();
    await request(http)
      .post(`/api/v1/sos/${first.id}/cancel`)
      .set(auth(owner.token))
      .expect(200);

    await relay(http, owner.token, devSnap, [
      envelope(devSnap, 'location_update', validLocation(3)),
    ]).expect(202);
    await fall(devSnap, { location: { latitude: 'x' } });
    const second = await prisma.sosCase.findFirstOrThrow({
      where: { deviceId: devSnap, status: 'pending' },
    });
    expect(second.locationSource).toBe('last_point');
    expect(second.latitude).toBeCloseTo(31.2003, 4);
  });

  it('创建时 Push 抛错不影响建单；manual_sos 在 pending 中立即终态化', async () => {
    pushMock.send.mockRejectedValue(new Error('APNs down'));
    await fall(devPush);
    const [sos] = await pendingOf(devPush);
    expect(sos).toBeDefined();
    await ingest.ingestRaw(
      JSON.stringify(envelope(devPush, 'manual_sos', {})),
      devPush,
      'mqtt',
    );
    const final = await prisma.sosCase.findUniqueOrThrow({
      where: { id: sos.id },
    });
    expect(final.status).toBe('notified');
    expect(await prisma.sosCase.count({ where: { deviceId: devPush } })).toBe(
      1,
    );
  });

  it('分页极值：page=2147483647 / pageSize=100 不得 5xx', async () => {
    const r = await request(http)
      .get(`/api/v1/devices/${devRace}/accidents?page=2147483647&pageSize=100`)
      .set(auth(owner.token));
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });
});
