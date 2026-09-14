// 2026-09-13 全面审计 §4：真实默认 60 秒倒计时 + 真实扫描定时器（不手动 tick）。
// 不设置 SOS_COUNTDOWN_SECONDS（产品默认 60s），扫描间隔缩到 1s。这是「至少一条链路用真实默认 60s 走完」的证据。
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
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
  activeOf,
  addContact,
  auditLocation,
  buildSosApp,
  fallEnvelope,
  makeProviderMocks,
  notificationsOf,
  pushCallsTitled,
  sleep,
  sosByEvent,
  sosSmsCalls,
  waitUntil,
  WsCollector,
} from './helpers/audit-sos';

jest.setTimeout(120000);

const mocks = makeProviderMocks();

describe('审计 §4 SOS 真实默认 60s 倒计时 + 真实扫描定时器 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const run = Date.now();
  const device = `audit_sos_rt_${run}`;
  let owner: TestUser;
  let ws: WsCollector;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: null, scanIntervalMs: '1000' },
      mocks,
    ));
    expect(process.env.SOS_COUNTDOWN_SECONDS).toBeUndefined();
    owner = await createUser(app, http);
    await provisionDevice(prisma, device);
    await bindDevice(http, owner.token, device);
    await addContact(http, owner.token, '家人', '19100000021');
    ws = await WsCollector.connect(app, owner.token);
  });

  afterAll(async () => {
    ws?.close();
    await cleanupDevices(prisma, [device]);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  it('app-relay possible_fall → deadline = 接收时间 + 60s → 55s 时仍 pending → 60–63s 内由定时扫描自动 notified → 通知各恰一次', async () => {
    const e = fallEnvelope(device, { location: auditLocation(3) });
    const t0 = Date.now();
    await relay(http, owner.token, device, [e]).expect(202);
    const c = (await sosByEvent(prisma, e.eventId as string))!;
    expect(c.status).toBe('pending');
    const countdown = c.deadline.getTime() - c.createdAt.getTime();
    expect(countdown).toBeGreaterThanOrEqual(59_500);
    expect(countdown).toBeLessThanOrEqual(60_500);
    expect(c.deadline.getTime() - t0).toBeGreaterThanOrEqual(59_000);
    expect(c.deadline.getTime() - t0).toBeLessThanOrEqual(61_500);
    await ws.waitForSos(c.id, 'pending');
    expect(
      (await activeOf(http, owner.token, device).expect(200)).body.sos.deadline,
    ).toBe(c.deadline.toISOString());

    await sleep(55_000);
    expect(
      (await prisma.sosCase.findUnique({ where: { id: c.id } }))!.status,
    ).toBe('pending');
    expect(sosSmsCalls(mocks)).toHaveLength(0);

    const finalRow = await waitUntil(
      () => prisma.sosCase.findUniqueOrThrow({ where: { id: c.id } }),
      (row) => row.status !== 'pending',
      15_000,
      250,
    );
    const elapsed = Date.now() - t0;
    expect(finalRow.status).toBe('notified');
    expect(finalRow.finalizedAt!.getTime()).toBeGreaterThanOrEqual(
      c.deadline.getTime(),
    );
    expect(elapsed).toBeGreaterThanOrEqual(60_000);
    expect(elapsed).toBeLessThanOrEqual(64_000);

    await ws.waitForSos(c.id, 'notified', 5000);
    await sleep(2500); // 再跑两轮定时扫描，确认不重复投递
    const rows = await notificationsOf(prisma, c.id);
    expect(rows.map((r) => [r.channel, r.status, r.attempts])).toEqual([
      ['sms', 'sent', 1],
      ['push', 'sent', 1],
    ]);
    expect(sosSmsCalls(mocks)).toHaveLength(1);
    expect(pushCallsTitled(mocks, 'SOS 倒计时已开始')).toHaveLength(1);
    expect(pushCallsTitled(mocks, 'SOS 已通知紧急联系人')).toHaveLength(1);
    expect(
      (await activeOf(http, owner.token, device).expect(200)).body.sos,
    ).toBeNull();
  });
});
