// SOS 通知投递顺序：本人 Push 的标题/正文按「此刻短信的真实结果」生成（sos-notifier.pushText），
// 所以同一单必须先投 sms 再投 push。两行在同一事务创建 → Postgres now() 取事务时间 → createdAt
// 完全相同，只按 createdAt 排序区分不了先后（同 DBOPS-01 那类缺少唯一次序键的问题）。
// 顺序一旦颠倒，用户会在求救最关键的时刻收到「短信全部失败，请直接拨打电话求助」——而短信其实马上就发成功了。
import { INestApplication } from '@nestjs/common';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { PUSH_TITLE } from '../src/sos/sos-notifier.service';
import { SosNotifierService } from '../src/sos/sos-notifier.service';
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
  resetMocks,
  sosByEvent,
} from './helpers/audit-sos';

jest.setTimeout(60_000);

describe('SOS 通知投递顺序（push 正文依赖短信结果）', () => {
  const mocks = makeProviderMocks();
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let notifier: SosNotifierService;
  let owner: TestUser;
  const deviceId = `sos_order_${Date.now()}`;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
    ingest = app.get(IngestService);
    notifier = app.get(SosNotifierService);
    owner = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, owner.token, deviceId);
    await addContact(http, owner.token, '家人', '19100000077');
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId]);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  /** 建一单并终态化，然后把两行通知重置成待投递，按参数摆布 createdAt 先后 */
  const arm = async (pushOlderBy: number): Promise<string> => {
    const e = fallEnvelope(deviceId);
    await ingest.ingestRaw(JSON.stringify(e), deviceId, 'mqtt');
    const c = (await sosByEvent(prisma, e.eventId as string))!;
    await confirmSos(http, owner.token, c.id);
    const base = new Date();
    for (const channel of ['sms', 'push'] as const) {
      await prisma.sosNotification.updateMany({
        where: { sosId: c.id, channel },
        data: {
          status: 'pending',
          attempts: 0,
          sentAt: null,
          lastError: null,
          createdAt:
            channel === 'push' ? new Date(base.getTime() - pushOlderBy) : base,
        },
      });
    }
    resetMocks(mocks);
    return c.id;
  };

  const pushCalls = () => mocks.push.send.mock.calls;

  it('createdAt 相同（真实情况）时先投短信，Push 如实报「1/1 已发出」', async () => {
    const sosId = await arm(0);
    await notifier.deliverPending(sosId);
    expect(pushCalls()).toHaveLength(1);
    const [, title, body] = pushCalls()[0] as [string, string, string];
    expect(title).toBe(PUSH_TITLE.contactsNotified);
    expect(body).toContain('1/1');
    const rows = await prisma.sosNotification.findMany({
      where: { sosId },
      select: { channel: true, status: true, sentAt: true },
    });
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    const sms = rows.find((r) => r.channel === 'sms')!;
    const push = rows.find((r) => r.channel === 'push')!;
    expect(sms.sentAt!.getTime()).toBeLessThanOrEqual(push.sentAt!.getTime());
  });

  it('即使 push 行的 createdAt 更早，也不会抢在短信前面发出「全部失败」', async () => {
    const sosId = await arm(5000);
    await notifier.deliverPending(sosId);
    expect(pushCalls()).toHaveLength(1);
    const [, title, body] = pushCalls()[0] as [string, string, string];
    expect(title).toBe(PUSH_TITLE.contactsNotified);
    expect(title).not.toBe(PUSH_TITLE.contactsFailed);
    expect(body).toContain('1/1');
  });
});
