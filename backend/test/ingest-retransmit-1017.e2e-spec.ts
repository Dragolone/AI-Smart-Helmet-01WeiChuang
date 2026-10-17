// 10-17 第二轮评审：同一次事件的重传被当成「撞号」另存并照常分发。
// ① 截短帧 → 完整帧：头盔对没 ACK 的高危帧 1.5 s 重发、重连后补传（DEVICE_PROTOCOL §1.2），同一 Event_Seq 派生同一 eventId；
//    第一次是 MTU 没协商上去的短帧，App 只填解得出的字段照样上云，补传的是完整帧，多出 pressDurationMs / location 等。
// ② MQTT 原文里的 -0.0：进 jsonb 读回是 0，原文直比判「内容不同」。
// 两种都让手动求救跳过本人的 60 秒取消窗口直接通知联系人，或在本人取消摔倒后再起一单。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bindDevice,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  relay,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  addContact,
  auth,
  buildSosApp,
  cancelSos,
  makeProviderMocks,
  sosSmsCalls,
} from './helpers/audit-sos';

jest.setTimeout(90_000);

const mocks = makeProviderMocks();
const LOCATION = {
  latitude: 31.2,
  longitude: 121.5,
  coordinateSystem: 'wgs84',
};

describe('同一次事件的重传不另存、不再分发 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  const run = Date.now();
  let seq = 0;

  const setup = async (): Promise<{ u: TestUser; d: string }> => {
    const u = await createUser(app, http);
    users.push(u);
    seq += 1;
    const d = `retx1017_${run}_${seq}`;
    devices.push(d);
    await provisionDevice(prisma, d);
    await bindDevice(http, u.token, d);
    return { u, d };
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
    ingest = app.get(IngestService);
  });
  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('手动求救先到截短帧、再到完整帧：按重复处理，倒计时还在、联系人没被通知', async () => {
    const { u, d } = await setup();
    await addContact(http, u.token, '联系人', '13800000001');
    const eventId = randomUUID();
    const short = envelope(
      d,
      'manual_sos',
      { triggerMode: 'long_press' },
      { eventId },
    );
    expect((await relay(http, u.token, d, [short]).expect(202)).body).toEqual({
      accepted: 1,
      duplicate: 0,
      invalid: 0,
    });
    const created = await prisma.sosCase.findFirstOrThrow({
      where: { deviceId: d },
    });
    const full = envelope(
      d,
      'manual_sos',
      { triggerMode: 'long_press', pressDurationMs: 3200, location: LOCATION },
      { eventId },
    );
    const second = await relay(http, u.token, d, [full]).expect(202);
    const after = await prisma.sosCase.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect({
      response: second.body,
      status: after.status,
      smsSent: sosSmsCalls(mocks).length,
      rows: await prisma.rawEvent.count({ where: { deviceId: d } }),
    }).toEqual({
      response: { accepted: 0, duplicate: 1, invalid: 0 },
      status: 'pending',
      smsSent: 0,
      rows: 1,
    });
  });

  it('先到完整帧、再到截短帧（反过来）同样按重复处理', async () => {
    const { u, d } = await setup();
    const eventId = randomUUID();
    const full = envelope(
      d,
      'possible_fall',
      { confidence: 0.92, impactG: 3.1, location: LOCATION },
      { eventId },
    );
    await relay(http, u.token, d, [full]).expect(202);
    const short = envelope(
      d,
      'possible_fall',
      { confidence: 0.92 },
      { eventId },
    );
    expect((await relay(http, u.token, d, [short]).expect(202)).body).toEqual({
      accepted: 0,
      duplicate: 1,
      invalid: 0,
    });
    expect(await prisma.sosCase.count({ where: { deviceId: d } })).toBe(1);
  });

  it('摔倒先到截短帧，本人取消后完整帧补传：不再起第二张单', async () => {
    const { u, d } = await setup();
    const eventId = randomUUID();
    await relay(http, u.token, d, [
      envelope(d, 'possible_fall', { confidence: 0.92 }, { eventId }),
    ]).expect(202);
    const created = await prisma.sosCase.findFirstOrThrow({
      where: { deviceId: d },
    });
    await cancelSos(http, u.token, created.id).expect(200);
    const full = envelope(
      d,
      'possible_fall',
      { confidence: 0.92, impactG: 3.1, tiltDeg: 85, location: LOCATION },
      { eventId },
    );
    const res = await relay(http, u.token, d, [full]).expect(202);
    const cases = await prisma.sosCase.findMany({
      where: { deviceId: d },
      select: { status: true, triggerEventId: true },
    });
    expect({ response: res.body, cases }).toEqual({
      response: { accepted: 0, duplicate: 1, invalid: 0 },
      cases: [{ status: 'cancelled', triggerEventId: eventId }],
    });
  });

  it('MQTT 原文带 -0.0 的同一字节串重投：判重复，不另存为 eventId~摘要', async () => {
    const { u, d } = await setup();
    const eventId = randomUUID();
    const raw = `{"schemaVersion":1,"eventId":"${eventId}","deviceId":"${d}","eventType":"collision_risk","timestamp":"${new Date().toISOString()}","firmwareVersion":"1.0.0","payload":{"riskLevel":"high","direction":"rear","objectType":"vehicle","distance":12.5,"relativeSpeed":-0.0}}`;
    expect(await ingest.ingestRaw(raw, d, 'mqtt')).toBe('stored');
    expect(await ingest.ingestRaw(raw, d, 'mqtt')).toBe('duplicate');
    const list = await request(http)
      .get(`/api/v1/devices/${d}/events`)
      .set(auth(u.token))
      .expect(200);
    expect({
      rows: (
        await prisma.rawEvent.findMany({
          where: { deviceId: d },
          select: { eventId: true },
        })
      ).map((r) => r.eventId),
      listTotal: list.body.total,
    }).toEqual({ rows: [eventId], listTotal: 1 });
  });

  it('摔倒原文带 -0.0：取消后 broker 重投同一报文，不再建单', async () => {
    const { u, d } = await setup();
    const eventId = randomUUID();
    const raw = `{"schemaVersion":1,"eventId":"${eventId}","deviceId":"${d}","eventType":"possible_fall","timestamp":"${new Date().toISOString()}","firmwareVersion":"1.0.0","payload":{"confidence":0.9,"tiltAngle":-0.0}}`;
    expect(await ingest.ingestRaw(raw, d, 'mqtt')).toBe('stored');
    const first = await prisma.sosCase.findFirstOrThrow({
      where: { deviceId: d, triggerEventId: eventId },
    });
    await cancelSos(http, u.token, first.id).expect(200);
    expect(await ingest.ingestRaw(raw, d, 'mqtt')).toBe('duplicate');
    expect(
      await prisma.sosCase.findMany({
        where: { deviceId: d },
        select: { triggerEventId: true, status: true },
      }),
    ).toEqual([{ triggerEventId: eventId, status: 'cancelled' }]);
  });

  it('对照：共有字段取值不同（序号回退撞号）仍是另一件事——另存为 eventId~摘要并建新单', async () => {
    const { u, d } = await setup();
    const eventId = randomUUID();
    await relay(http, u.token, d, [
      envelope(
        d,
        'possible_fall',
        { confidence: 0.92, impactG: 3.1 },
        { eventId },
      ),
    ]).expect(202);
    const first = await prisma.sosCase.findFirstOrThrow({
      where: { deviceId: d },
    });
    await cancelSos(http, u.token, first.id).expect(200);
    const res = await relay(http, u.token, d, [
      envelope(
        d,
        'possible_fall',
        { confidence: 0.92, impactG: 5.4 },
        { eventId },
      ),
    ]).expect(202);
    expect(res.body).toEqual({ accepted: 1, duplicate: 0, invalid: 0 });
    const cases = await prisma.sosCase.findMany({
      where: { deviceId: d },
      select: { status: true, triggerEventId: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(cases).toHaveLength(2);
    expect(cases[1].status).toBe('pending');
    expect(cases[1].triggerEventId.startsWith(`${eventId}~`)).toBe(true);
  });
});
