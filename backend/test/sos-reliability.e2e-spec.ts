// SOS 可靠性三项（2026-10-03，决策 #50–#52）：通知重试退避、周期对账、补传事件的时间说明，
// 外加同一触发事件重入不跳过倒计时。本套件用**默认退避配置**，靠回拨通知行的 createdAt 模拟时间流逝。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { ValidEnvelope } from '../src/ingest/envelope';
import { PrismaService } from '../src/prisma/prisma.service';
import { PUSH_PROVIDER } from '../src/providers/push.provider';
import { SMS_PROVIDER } from '../src/providers/sms.provider';
import { SosSchedulerService } from '../src/sos/sos-scheduler.service';
import { SosTriggerService } from '../src/sos/sos-trigger.service';
import {
  addContact,
  confirmSos,
  makeProviderMocks,
  resetMocks,
  sosByEvent,
} from './helpers/audit-sos';
import {
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  relay,
  sleep,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(60_000);

const mocks = makeProviderMocks();

describe('SOS 可靠性：重试退避 / 周期对账 / 补传说明 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let scheduler: SosSchedulerService;
  let sosTrigger: SosTriggerService;
  let owner: TestUser;

  const run = Date.now();
  const devices = {
    backoff: `sosrel_backoff_${run}`,
    recover: `sosrel_recover_${run}`,
    reconcile: `sosrel_reconcile_${run}`,
    stale: `sosrel_stale_${run}`,
    fresh: `sosrel_fresh_${run}`,
    ancient: `sosrel_ancient_${run}`,
    reentry: `sosrel_reentry_${run}`,
  };

  beforeAll(async () => {
    process.env.SOS_COUNTDOWN_SECONDS = '600';
    process.env.SOS_SCAN_INTERVAL_MS = '600000'; // 手动 tick 驱动
    // 退避与次数走产品默认；对账周期调到 1 秒，才能在用例里等到
    delete process.env.SOS_NOTIFY_MAX_ATTEMPTS;
    delete process.env.SOS_NOTIFY_RETRY_DELAYS_SECONDS;
    process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS = '';
    process.env.SOS_RECONCILE_INTERVAL_SECONDS = '1';
    process.env.SOS_RECONCILE_GRACE_MS = '1';
    resetMocks(mocks);
    ({ app, http, prisma } = await buildApp((b) =>
      b
        .overrideProvider(SMS_PROVIDER)
        .useValue(mocks.sms)
        .overrideProvider(PUSH_PROVIDER)
        .useValue(mocks.push),
    ));
    scheduler = app.get(SosSchedulerService);
    sosTrigger = app.get(SosTriggerService);
    owner = await createUser(app, http);
    await addContact(http, owner.token, '联系人甲', '13900000001');
    for (const deviceId of Object.values(devices)) {
      await provisionDevice(prisma, deviceId);
      await bindDevice(http, owner.token, deviceId);
    }
  });

  afterAll(async () => {
    await cleanupDevices(prisma, Object.values(devices));
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  const smsDown = (): void => {
    mocks.sms.send.mockImplementation((_phone, message) =>
      message.template === 'sos_alert'
        ? Promise.reject(new Error('短信通道故障'))
        : Promise.resolve(),
    );
  };

  /** 触发一单并立即确认（SOS Now）：终态化 + 首轮投递同步完成，返回那条短信通知行的 id */
  const confirmedSosSmsRow = async (deviceId: string): Promise<string> => {
    const fall = envelope(deviceId, 'possible_fall', { confidence: 0.9 });
    await relay(http, owner.token, deviceId, [fall]).expect(202);
    const sos = await sosByEvent(prisma, fall.eventId as string);
    await confirmSos(http, owner.token, sos!.id).expect(200);
    const row = await prisma.sosNotification.findFirstOrThrow({
      where: { sosId: sos!.id, channel: 'sms' },
    });
    return row.id;
  };

  const rowOf = (id: string) =>
    prisma.sosNotification.findUniqueOrThrow({ where: { id } });

  /** 把通知行「变老」：等效于距创建已过去这么久 */
  const ageRow = (id: string, seconds: number) =>
    prisma.sosNotification.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - seconds * 1000) },
    });

  describe('通知重试退避（默认 10 秒 / 1 分钟 / 5 分钟 / 15 分钟，连首次 5 次）', () => {
    it('通道持续故障：没到点的扫描轮次不重试；到点才投下一次；第 5 次失败后终态 failed 不再投', async () => {
      smsDown();
      const id = await confirmedSosSmsRow(devices.backoff);
      expect(await rowOf(id)).toMatchObject({ status: 'failed', attempts: 1 });

      // 原先每轮扫描都重试：连扫三轮就把次数用完了
      await scheduler.tick();
      await scheduler.tick();
      await scheduler.tick();
      expect((await rowOf(id)).attempts).toBe(1);

      // [已过去的秒数, 此时应有的投递次数]
      const timeline: [number, number][] = [
        [9, 1],
        [10, 2],
        [69, 2],
        [70, 3],
        [369, 3],
        [370, 4],
        [1269, 4],
        [1270, 5],
      ];
      for (const [elapsed, attempts] of timeline) {
        await ageRow(id, elapsed);
        await scheduler.tick();
        expect([elapsed, (await rowOf(id)).attempts]).toEqual([
          elapsed,
          attempts,
        ]);
      }

      // 次数用尽：再过多久也不投
      await ageRow(id, 24 * 3600);
      await scheduler.tick();
      const final = await rowOf(id);
      expect(final).toMatchObject({ status: 'failed', attempts: 5 });
      expect(final.lastError).toContain('短信通道故障');
    });

    it('通道在 5 分钟后恢复：第 4 次投递成功，状态 sent、清掉旧错误，之后不再投', async () => {
      smsDown();
      const id = await confirmedSosSmsRow(devices.recover);
      await ageRow(id, 10);
      await scheduler.tick();
      await ageRow(id, 70);
      await scheduler.tick();
      expect(await rowOf(id)).toMatchObject({ status: 'failed', attempts: 3 });

      resetMocks(mocks); // 通道恢复
      await ageRow(id, 370);
      await scheduler.tick();
      expect(await rowOf(id)).toMatchObject({
        status: 'sent',
        attempts: 4,
        lastError: null,
      });
      const sentCalls = mocks.sms.send.mock.calls.length;
      await ageRow(id, 24 * 3600);
      await scheduler.tick();
      expect(mocks.sms.send.mock.calls.length).toBe(sentCalls);
    });
  });

  describe('周期对账', () => {
    it('运行中丢掉的摔倒事件（raw 已落库、没建单）不用等重启：一个对账周期内补建', async () => {
      resetMocks(mocks);
      const eventId = randomUUID();
      // 事件时间必须晚于绑定时间：对账按「事件到达时设备绑给谁」找人，绑定之前的事件只留档
      const at = new Date(Date.now() - 50);
      // 直接写 raw_events、绕过分发：模拟「入库成功、建单前那次查询失败」
      await prisma.rawEvent.create({
        data: {
          eventId,
          deviceId: devices.reconcile,
          eventType: 'possible_fall',
          timestamp: at,
          receivedAt: at,
          schemaVersion: 1,
          firmwareVersion: '0.1.0',
          payload: { confidence: 0.9 },
          source: 'app_relay',
        },
      });
      expect(await sosByEvent(prisma, eventId)).toBeNull();

      let recovered = await sosByEvent(prisma, eventId);
      for (let i = 0; i < 50 && !recovered; i += 1) {
        await sleep(100);
        recovered = await sosByEvent(prisma, eventId);
      }
      expect(recovered).toMatchObject({
        status: 'pending',
        userId: owner.id,
        deviceId: devices.reconcile,
      });

      // 再过几个周期也只有这一单：对账对同一事件幂等
      await sleep(2500);
      expect(
        await prisma.sosCase.count({ where: { deviceId: devices.reconcile } }),
      ).toBe(1);
    });
  });

  describe('补传的旧事件：照常倒计时并通知，只在给本人的推送里说明（决策 #52）', () => {
    const countdownPushBody = (deviceId: string): string | undefined =>
      mocks.push.send.mock.calls.find(
        ([, title, , data]) =>
          title === 'SOS 倒计时已开始' && data?.deviceId === deviceId,
      )?.[2];

    const relayFallAt = async (deviceId: string, at: Date) => {
      const fall = envelope(
        deviceId,
        'possible_fall',
        { confidence: 0.9 },
        { timestamp: at.toISOString() },
      );
      await relay(http, owner.token, deviceId, [fall]).expect(202);
      return sosByEvent(prisma, fall.eventId as string);
    };

    beforeAll(() => resetMocks(mocks));

    it('3 小时前的摔倒：照常建单倒计时；推送正文注明「约 3 小时前的事件，刚补传到」', async () => {
      const sos = await relayFallAt(
        devices.stale,
        new Date(Date.now() - 3 * 3_600_000),
      );
      expect(sos).toMatchObject({ status: 'pending' });
      // deadline 按服务器时间起算，不因事件旧而缩短
      expect(sos!.deadline.getTime() - Date.now()).toBeGreaterThan(590_000);
      expect(countdownPushBody(devices.stale)).toContain(
        '（约 3 小时前的事件，刚补传到）',
      );
    });

    it('刚发生的摔倒：推送正文不带补传说明', async () => {
      const sos = await relayFallAt(devices.fresh, new Date());
      expect(sos).toMatchObject({ status: 'pending' });
      const body = countdownPushBody(devices.fresh);
      expect(body).toContain('检测到疑似摔倒');
      expect(body).not.toContain('补传');
    });

    it('时间戳在 100 天前（头盔时钟不可信）：仍然建单倒计时，且不说「多久之前」——不诱导本人取消', async () => {
      const sos = await relayFallAt(
        devices.ancient,
        new Date(Date.now() - 100 * 24 * 3_600_000),
      );
      expect(sos).toMatchObject({ status: 'pending' });
      expect(countdownPushBody(devices.ancient)).not.toContain('补传');
    });
  });

  describe('同一触发事件被处理两遍', () => {
    it('manual_sos 重入（重试 / 对账与在途分发撞车）：不把自己当成「倒计时中又来一条」而跳过倒计时', async () => {
      resetMocks(mocks);
      const event: ValidEnvelope = {
        schemaVersion: 1,
        eventId: randomUUID(),
        deviceId: devices.reentry,
        eventType: 'manual_sos',
        timestamp: new Date(),
        firmwareVersion: '0.1.0',
        payload: {},
      };
      await sosTrigger.handleTrigger(event, owner.id);
      await sosTrigger.handleTrigger(event, owner.id);
      expect(await sosByEvent(prisma, event.eventId)).toMatchObject({
        status: 'pending',
      });
      expect(
        mocks.sms.send.mock.calls.filter(
          ([, message]) => message.template === 'sos_alert',
        ),
      ).toHaveLength(0);

      // 对照：另一条 manual_sos 才是「倒计时中又按了一次」，照旧立即通知
      await sosTrigger.handleTrigger(
        { ...event, eventId: randomUUID() },
        owner.id,
      );
      expect(await sosByEvent(prisma, event.eventId)).toMatchObject({
        status: 'notified',
      });
      await request(http).get('/api/v1/health').expect(200);
    });
  });
});
