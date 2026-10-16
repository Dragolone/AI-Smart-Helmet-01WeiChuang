// 10-17 后端评审 SOS-1：丢了分发的摔倒 / 求救 E1 被对账补建成第二单。
// E1 落库了但建单失败（数据库瞬断超过进程内重试），同一次事故里随后的 E2 建了单 C2；
// 原来对账只认「E1 到达时已在倒数的单」，C2 结束后把 E1 补建成 C3：联系人再收一轮短信，或用户点了「我没事」后又倒计时。
import { INestApplication } from '@nestjs/common';
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
  buildSosApp,
  cancelSos,
  fallEnvelope,
  makeProviderMocks,
  manualEnvelope,
  resetMocks,
  sleep,
  sosByEvent,
  sosSmsCalls,
} from './helpers/audit-sos';

jest.setTimeout(90_000);

const mocks = makeProviderMocks();

describe('对账不把同一次事故补建成第二单（10-17 SOS-1）', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let scheduler: SosSchedulerService;
  let owner: TestUser;
  const run = Date.now();
  const devCancel = `rcm_cancel_${run}`;
  const devManual = `rcm_manual_${run}`;
  const devLate = `rcm_late_${run}`;
  const devices = [devCancel, devManual, devLate];
  const savedGrace = process.env.SOS_RECONCILE_GRACE_MS;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '5' },
      mocks,
    ));
    scheduler = app.get(SosSchedulerService);
    owner = await createUser(app, http);
    for (const d of devices) {
      await provisionDevice(prisma, d);
      await bindDevice(http, owner.token, d);
    }
    await addContact(http, owner.token, '家人一', '19100000041');
    await addContact(http, owner.token, '家人二', '19100000042');
    await addContact(http, owner.token, '家人三', '19100000043');
    process.env.SOS_RECONCILE_GRACE_MS = '1';
  });

  beforeEach(() => resetMocks(mocks));

  afterAll(async () => {
    if (savedGrace === undefined) delete process.env.SOS_RECONCILE_GRACE_MS;
    else process.env.SOS_RECONCILE_GRACE_MS = savedGrace;
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  /** 下一条摔倒 / 求救的建单在分发阶段丢了（数据库瞬断超过进程内 3 次重试），raw 已落库 */
  const loseNextTrigger = () => {
    const spy = jest.spyOn(prisma.sosCase, 'findFirst');
    for (let i = 0; i < 3; i++)
      spy.mockRejectedValueOnce(new Error('injected db blip'));
    return spy;
  };
  const casesOf = (deviceId: string) =>
    prisma.sosCase.findMany({
      where: { deviceId },
      orderBy: { createdAt: 'asc' },
    });

  it('E1 丢了、E2 建了单 C2，用户在 C2 点「我没事」：之后的对账不再给 E1 补一单（原来 1–2 分钟后又开始倒计时）', async () => {
    const e1 = fallEnvelope(devCancel);
    const spy = loseNextTrigger();
    await relay(http, owner.token, devCancel, [e1]).expect(202);
    spy.mockRestore();
    expect(await sosByEvent(prisma, e1.eventId as string)).toBeNull();
    await sleep(20);
    const e2 = fallEnvelope(devCancel);
    await relay(http, owner.token, devCancel, [e2]).expect(202);
    const c2 = (await sosByEvent(prisma, e2.eventId as string))!;
    await scheduler.reconcileLostTriggers();
    await cancelSos(http, owner.token, c2.id).expect(200);
    await scheduler.reconcileLostTriggers();
    expect(await sosByEvent(prisma, e1.eventId as string)).toBeNull();
    expect((await casesOf(devCancel)).map((c) => c.status)).toEqual([
      'cancelled',
    ]);
  });

  it('E1 是手动求救、丢了，E2 摔倒建了 C2：E1 算并进 C2（同正常处理时 E2 并进 E1 的单），C2 照常倒数可取消；到期只通知一轮，不再补建 C3 再发一轮', async () => {
    const e1 = manualEnvelope(devManual);
    const spy = loseNextTrigger();
    await relay(http, owner.token, devManual, [e1]).expect(202);
    spy.mockRestore();
    await sleep(20);
    const e2 = fallEnvelope(devManual);
    await relay(http, owner.token, devManual, [e2]).expect(202);
    const c2 = (await sosByEvent(prisma, e2.eventId as string))!;
    await scheduler.reconcileLostTriggers();
    expect((await casesOf(devManual)).map((c) => c.status)).toEqual([
      'pending',
    ]);
    // C2 到期：通知一轮
    await prisma.sosCase.update({
      where: { id: c2.id },
      data: { deadline: new Date(Date.now() - 1000) },
    });
    await scheduler.tick();
    await scheduler.reconcileLostTriggers();
    await scheduler.tick();
    expect(await sosByEvent(prisma, e1.eventId as string)).toBeNull();
    expect((await casesOf(devManual)).map((c) => c.status)).toEqual([
      'notified',
    ]);
    expect(sosSmsCalls(mocks)).toHaveLength(3);
  });

  it('对照：E2 在 E1 一个倒计时之后才来（不是同一次事故）→ E1 照常补建自己的单', async () => {
    const e1 = fallEnvelope(devLate);
    const spy = loseNextTrigger();
    await relay(http, owner.token, devLate, [e1]).expect(202);
    spy.mockRestore();
    // 把 E1 的到达时间拨到 11 分钟前（倒计时 600 s 之外、对账窗口 15 分钟之内）；绑定也拨早，否则对账判「当时没绑定」
    await prisma.rawEvent.updateMany({
      where: { deviceId: devLate, eventId: e1.eventId as string },
      data: { receivedAt: new Date(Date.now() - 11 * 60_000) },
    });
    await prisma.deviceBinding.updateMany({
      where: { deviceId: devLate },
      data: { boundAt: new Date(Date.now() - 12 * 60_000) },
    });
    const e2 = fallEnvelope(devLate);
    await relay(http, owner.token, devLate, [e2]).expect(202);
    const c2 = (await sosByEvent(prisma, e2.eventId as string))!;
    await cancelSos(http, owner.token, c2.id).expect(200);
    await scheduler.reconcileLostTriggers();
    const c1 = await sosByEvent(prisma, e1.eventId as string);
    expect(c1?.status).toBe('pending');
  });
});
