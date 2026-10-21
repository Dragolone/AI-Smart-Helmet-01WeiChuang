// 10-17 第二轮评审 r4：事故详情 notifications[] 原来只按 createdAt 排序。短信行与本人 Push 行在同一事务创建、createdAt 完全相同，
// 次序取决于行在堆里的物理位置——某条短信重试成功（行被更新）后，它在详情里从第一位跳到最后，Push 夹在短信中间。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
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
  auth,
  buildSosApp,
  confirmSos,
  fallEnvelope,
  makeProviderMocks,
  sosByEvent,
  waitForPushTitled,
  settleSosDelivery,
} from './helpers/audit-sos';

jest.setTimeout(60_000);

describe('事故详情通知记录次序稳定 (e2e)', () => {
  const mocks = makeProviderMocks();
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let notifier: SosNotifierService;
  let owner: TestUser;
  const deviceId = `accorder1017_${Date.now()}`;
  const PHONE_A = '19100000081';
  const PHONE_B = '19100000082';

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
    await addContact(http, owner.token, '甲', PHONE_A);
    await addContact(http, owner.token, '乙', PHONE_B);
  });

  afterEach(() => settleSosDelivery(app));
  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId]);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  it('R4-B1 一条短信重试成功后，详情里的通知次序不能变（联系人甲不能跳到乙后面）', async () => {
    const seen: string[] = [];
    // 次序取决于行在堆里的位置与规划器选的扫描方式，单张单时红时绿；连做 6 张单，任何一张次序乱了即复现
    for (let round = 0; round < 6; round += 1) {
      const e = fallEnvelope(deviceId);
      await ingest.ingestRaw(JSON.stringify(e), deviceId, 'mqtt');
      const c = (await sosByEvent(prisma, e.eventId as string))!;
      await waitForPushTitled(mocks, 'SOS 倒计时已开始');

      // 甲第一次发失败，其余成功
      let failedOnce = false;
      mocks.sms.send.mockImplementation((phone: string) => {
        if (phone === PHONE_A && !failedOnce) {
          failedOnce = true;
          return Promise.reject(new Error('injected transient sms failure'));
        }
        return Promise.resolve();
      });
      await confirmSos(http, owner.token, c.id).expect(200);
      await settleSosDelivery(app);

      const order = async () => {
        const res = await request(http)
          .get(`/api/v1/accidents/${c.id}`)
          .set(auth(owner.token))
          .expect(200);
        return (
          res.body.notifications as Array<{
            channel: string;
            contactName: string | null;
          }>
        )
          .map((n) => `${n.channel}:${n.contactName ?? '-'}`)
          .join(',');
      };
      const before = await order();
      // 重试轮次（SOS_NOTIFY_RETRY_DELAYS_SECONDS=0）：甲这次成功
      await notifier.deliverPending(c.id);
      const after = await order();
      seen.push(`#${round} 重试前 ${before} → 重试后 ${after}`);
      mocks.push.send.mockClear();
    }
    // 同一张单、同一组通知行，次序应稳定且为「短信按联系人先后、Push 在后」
    const expected = 'sms:甲,sms:乙,push:-';
    expect(seen).toEqual(
      seen.map((_, i) => `#${i} 重试前 ${expected} → 重试后 ${expected}`),
    );
  });
});
