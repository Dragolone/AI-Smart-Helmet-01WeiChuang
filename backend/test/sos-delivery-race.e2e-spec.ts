// 10-06 并发评审 #3 / 不变式 F-12：
// ① confirm 的内联投递与扫描任务并发：短信还在飞（已占位、未写结果）时扫描不能占走本人 Push，
//    否则正文按半截结果生成——「短信全部失败，请直接拨打电话求助」，而短信随即就成功了；
// ② 最后一次投递中途进程退出的通知行会永远停在 pending：扫描要把它收尾成 failed，让失败可见。
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
  confirmSos,
  fallEnvelope,
  makeProviderMocks,
  notificationsOf,
  pushCallsTitled,
  resetMocks,
  sosByEvent,
  sosSmsCalls,
} from './helpers/audit-sos';

jest.setTimeout(60000);

const mocks = makeProviderMocks();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SOS 通知投递：内联与扫描并发 / 中断行收尾 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let scheduler: SosSchedulerService;
  let owner: TestUser;
  const run = Date.now();
  const devRace = `sos_race_${run}`;
  const devStuck = `sos_stuck_${run}`;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
    scheduler = app.get(SosSchedulerService);
    owner = await createUser(app, http);
    for (const d of [devRace, devStuck]) {
      await provisionDevice(prisma, d);
      await bindDevice(http, owner.token, d);
    }
    await addContact(http, owner.token, '家人', '19100000031');
  });

  beforeEach(() => resetMocks(mocks));

  afterAll(async () => {
    await cleanupDevices(prisma, [devRace, devStuck]);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  it('confirm 内联投递短信还在飞时撞上扫描：本人 Push 等短信有结果再发，标题是「已通知」而不是「发送失败」', async () => {
    const e = fallEnvelope(devRace);
    await relay(http, owner.token, devRace, [e]).expect(202);
    const c = (await sosByEvent(prisma, e.eventId as string))!;
    // 短信服务商要 400 ms 才受理
    mocks.sms.send.mockImplementation(async () => {
      await sleep(400);
    });
    // .then 让请求现在就发出去：supertest 的 Test 是惰性的，原来要等到下面 await 才发，扫描根本没撞上（10-17 评审）
    const confirming = confirmSos(http, owner.token, c.id).then((r) => r);
    await sleep(80); // 内联投递已占位短信行、正在等服务商
    await scheduler.tick(); // 扫描撞进来：此刻短信行 pending/attempts=1
    expect((await confirming).status).toBe(200);
    await sleep(600);
    await scheduler.tick(); // 下一轮：短信已 sent，Push 这才发
    const rows = await notificationsOf(prisma, c.id);
    expect(rows.map((r) => [r.channel, r.status, r.attempts])).toEqual([
      ['sms', 'sent', 1],
      ['push', 'sent', 1],
    ]);
    expect(sosSmsCalls(mocks)).toHaveLength(1);
    expect(pushCallsTitled(mocks, 'SOS 紧急联系人通知发送失败')).toHaveLength(
      0,
    );
    expect(pushCallsTitled(mocks, 'SOS 已通知紧急联系人')).toHaveLength(1);
  });

  it('最后一次投递中途进程退出（attempts 已到上限仍 pending）：下一轮扫描记为 failed，详情里不再永远「待发送」', async () => {
    const e = fallEnvelope(devStuck);
    await relay(http, owner.token, devStuck, [e]).expect(202);
    const c = (await sosByEvent(prisma, e.eventId as string))!;
    await confirmSos(http, owner.token, c.id).expect(200);
    // 直接写出「占位后进程倒下」留下的行：attempts = 上限（3），status 仍 pending
    const stuck = await prisma.sosNotification.create({
      data: {
        sosId: c.id,
        channel: 'sms',
        target: '19100000032',
        contactName: '朋友',
        attempts: 3,
      },
    });
    resetMocks(mocks);
    await scheduler.tick();
    const row = await prisma.sosNotification.findUniqueOrThrow({
      where: { id: stuck.id },
    });
    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('interrupted');
    expect(row.attempts).toBe(3);
    expect(sosSmsCalls(mocks)).toHaveLength(0); // 没有再多发一条
  });
});
