// 短信重试成功后的补推（O17，负责人 10-21）：本人收到过「SOS 紧急联系人通知发送失败」、之后短信重试成功时，
// 补推一条「SOS 已在重试后通知紧急联系人」，每单最多一条；部分成功的不补。补推是普通通知行，由扫描投递（重启后同样）。
// 重试间隔为 0（applySosEnv），每调一次 deliverPending / tick 就是一轮重试。
import { INestApplication } from '@nestjs/common';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { SmsMessage } from '../src/providers/sms.provider';
import { SosSchedulerService } from '../src/sos/sos-scheduler.service';
import {
  PUSH_TITLE,
  SosNotifierService,
} from '../src/sos/sos-notifier.service';
import {
  bindDevice,
  cleanupDevices,
  cleanupUsers,
  createUser,
  provisionDevice,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  addContact,
  buildSosApp,
  confirmSos,
  fallEnvelope,
  makeProviderMocks,
  pushCallsTitled,
  resetMocks,
  settleSosDelivery,
  sleep,
  sosByEvent,
  waitForPushTitled,
} from './helpers/audit-sos';

jest.setTimeout(60_000);

const CONTACT_A = '19100000081';
const CONTACT_B = '19100000082';

describe('短信重试成功后补推一条（O17）', () => {
  const mocks = makeProviderMocks();
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let notifier: SosNotifierService;
  let scheduler: SosSchedulerService;
  let owner: TestUser;
  const deviceId = `sos_followup_${Date.now()}`;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '5' },
      mocks,
    ));
    ingest = app.get(IngestService);
    notifier = app.get(SosNotifierService);
    scheduler = app.get(SosSchedulerService);
    owner = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, owner.token, deviceId);
    await addContact(http, owner.token, '家人', CONTACT_A);
    await addContact(http, owner.token, '同事', CONTACT_B);
  });

  beforeEach(() => resetMocks(mocks));
  afterEach(() => settleSosDelivery(app));
  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId]);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  /** 求救短信对这些号码失败（注册验证码不受影响） */
  const smsFailsFor = (numbers: string[]) =>
    mocks.sms.send.mockImplementation((to: string, msg: SmsMessage) =>
      msg.template === 'sos_alert' && numbers.includes(to)
        ? Promise.reject(new Error('sms down'))
        : Promise.resolve(),
    );

  /** 建一单、立即求救、首轮投递落定 */
  const fireAndConfirm = async (): Promise<string> => {
    const e = fallEnvelope(deviceId);
    await ingest.ingestRaw(JSON.stringify(e), deviceId, 'mqtt');
    const c = (await sosByEvent(prisma, e.eventId as string))!;
    await waitForPushTitled(mocks, 'SOS 倒计时已开始');
    await confirmSos(http, owner.token, c.id).expect(200);
    await settleSosDelivery(app);
    return c.id;
  };

  const pushRows = (sosId: string) =>
    prisma.sosNotification.findMany({
      where: { sosId, channel: 'push' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  it('第一轮全部失败 → 本人收到「发送失败」；重试成功后补推一条，文案带 N/M；之后再怎么投递都不再补', async () => {
    smsFailsFor([CONTACT_A, CONTACT_B]);
    const sosId = await fireAndConfirm();
    expect(pushCallsTitled(mocks, PUSH_TITLE.contactsFailed)).toHaveLength(1);
    expect((await pushRows(sosId)).map((r) => r.pushTitle)).toEqual([
      PUSH_TITLE.contactsFailed,
    ]);

    // 短信恢复：这一轮两条短信重试成功，同时建好补推行（还没发）
    smsFailsFor([]);
    await notifier.deliverPending(sosId);
    const queued = await pushRows(sosId);
    expect(queued).toHaveLength(2);
    expect(queued[1]).toMatchObject({
      pushTitle: PUSH_TITLE.retryNotified,
      status: 'pending',
      target: `user:${owner.id}`,
    });

    // 补推是普通通知行：由扫描投递（进程重启后第一轮扫描同样会捞起它）
    await scheduler.tick();
    const followups = pushCallsTitled(mocks, PUSH_TITLE.retryNotified);
    expect(followups).toHaveLength(1);
    expect(followups[0][0]).toBe(owner.id);
    expect(followups[0][2]).toBe(
      `头盔 ${deviceId} 的求救短信已在重试后发给 2/2 位紧急联系人`,
    );
    expect(followups[0][3]).toEqual({ sosId, deviceId });

    await scheduler.tick();
    await notifier.deliverPending(sosId);
    expect(pushCallsTitled(mocks, PUSH_TITLE.retryNotified)).toHaveLength(1);
    const final = await pushRows(sosId);
    expect(final.map((r) => [r.pushTitle, r.status])).toEqual([
      [PUSH_TITLE.contactsFailed, 'sent'],
      [PUSH_TITLE.retryNotified, 'sent'],
    ]);
  });

  it('只成功一部分时补推写「其余仍在重试」', async () => {
    smsFailsFor([CONTACT_A, CONTACT_B]);
    const sosId = await fireAndConfirm();
    smsFailsFor([CONTACT_B]);
    await notifier.deliverPending(sosId);
    await notifier.deliverPending(sosId);
    const followups = pushCallsTitled(mocks, PUSH_TITLE.retryNotified);
    expect(followups).toHaveLength(1);
    expect(followups[0][2]).toBe(
      `头盔 ${deviceId} 的求救短信已在重试后发给 1/2 位紧急联系人（其余仍在重试）`,
    );
  });

  it('第一轮就部分成功（本人收到的是「已通知 1/2」）：之后其余重试成功也不补', async () => {
    smsFailsFor([CONTACT_B]);
    const sosId = await fireAndConfirm();
    expect(pushCallsTitled(mocks, PUSH_TITLE.contactsNotified)).toHaveLength(1);
    smsFailsFor([]);
    await notifier.deliverPending(sosId);
    await notifier.deliverPending(sosId);
    expect(pushCallsTitled(mocks, PUSH_TITLE.retryNotified)).toHaveLength(0);
    expect(await pushRows(sosId)).toHaveLength(1);
  });

  it('两条短信的重试在两路投递里同时成功：补推行只建一条', async () => {
    smsFailsFor([CONTACT_A, CONTACT_B]);
    const sosId = await fireAndConfirm();
    // 每条短信慢 200 ms：两路投递各占到一条、几乎同时写「已发送」
    mocks.sms.send.mockImplementation(async (_to: string, msg: SmsMessage) => {
      if (msg.template === 'sos_alert') await sleep(200);
    });
    await Promise.all([
      notifier.deliverPending(sosId),
      notifier.deliverPending(sosId),
    ]);
    const smsRows = await prisma.sosNotification.findMany({
      where: { sosId, channel: 'sms' },
    });
    expect(smsRows.every((r) => r.status === 'sent')).toBe(true);
    const queued = (await pushRows(sosId)).filter(
      (r) => r.pushTitle === PUSH_TITLE.retryNotified,
    );
    expect(queued).toHaveLength(1);
  });
});
