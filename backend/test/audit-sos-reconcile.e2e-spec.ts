// 启动对账（reconcileLostTriggers，审计 SOS-02）的「不该补建」守卫。
// 2026-09-26 覆盖率复盘：sos-scheduler 分支覆盖 55%，未覆盖的恰是两条防重复建单的守卫——
// ① 事件发生时设备无绑定（或已解绑）→ 只留档；② 事件发生时该用户已有进行中的单 → 按合并规则（决策 #40）不建新单。
// 这两条写错的后果是**服务重启时给紧急联系人重复发短信**，或给设备前主人建单。既有 ①b 只测了「该补建的补建了」。
//
// 做法：直接往 raw_events 插「已落库但没建单」的事件（= 进程在分发阶段被杀），再调对账。
// 对账是全表窗口扫描，别的测试文件留下的事件也会被扫到，所以只按本文件的 eventId 断言，不看返回条数。
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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
  auth,
  buildSosApp,
  cancelSos,
  fallEnvelope,
  makeProviderMocks,
  resetMocks,
  sosByEvent,
  sosSmsCalls,
} from './helpers/audit-sos';

jest.setTimeout(60000);

const mocks = makeProviderMocks();

describe('审计 SOS-02 启动对账：不该补建的不补建 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let scheduler: SosSchedulerService;
  let owner: TestUser;
  let savedGrace: string | undefined;

  const run = Date.now();
  const devUnbound = `audit_rec_unbound_${run}`;
  const devFormer = `audit_rec_former_${run}`;
  const devMerged = `audit_rec_merged_${run}`;
  const devAfterFinal = `audit_rec_final_${run}`;
  const devices = [devUnbound, devFormer, devMerged, devAfterFinal];

  /** 插一条「已落库但没建单」的 possible_fall（receivedAt 默认 2 s 前，落在对账窗口内） */
  const orphanFall = async (
    deviceId: string,
    receivedAt = new Date(Date.now() - 2_000),
  ) => {
    const eventId = randomUUID();
    await prisma.rawEvent.create({
      data: {
        eventId,
        deviceId,
        eventType: 'possible_fall',
        timestamp: receivedAt,
        receivedAt,
        schemaVersion: 1,
        payload: { confidence: 0.9, algorithmVersion: 'audit-rec' },
        source: 'app_relay',
      },
    });
    return eventId;
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
    scheduler = app.get(SosSchedulerService);
    owner = await createUser(app, http);
    for (const d of devices) await provisionDevice(prisma, d);
    for (const d of [devFormer, devMerged, devAfterFinal])
      await bindDevice(http, owner.token, d);
    await addContact(http, owner.token, '家人', '19100000021');
    savedGrace = process.env.SOS_RECONCILE_GRACE_MS;
    process.env.SOS_RECONCILE_GRACE_MS = '1'; // 刚落库的事件立即参与对账
  });

  beforeEach(() => resetMocks(mocks));

  afterAll(async () => {
    if (savedGrace === undefined) delete process.env.SOS_RECONCILE_GRACE_MS;
    else process.env.SOS_RECONCILE_GRACE_MS = savedGrace;
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  it('① 事件发生时设备从未绑定：只留档，不建单、不通知任何人', async () => {
    const eventId = await orphanFall(devUnbound, new Date(Date.now() - 50));
    await scheduler.reconcileLostTriggers();
    expect(await sosByEvent(prisma, eventId)).toBeNull();
    expect(
      await prisma.sosCase.count({ where: { deviceId: devUnbound } }),
    ).toBe(0);
  });

  /** 事件时间锚在数据库里的真实时间戳之后，再等它落进对账窗口（[now-window, now-grace]） */
  const after = async (t: Date, ms = 20) => {
    const at = new Date(t.getTime() + ms);
    await new Promise((r) => setTimeout(r, ms * 2));
    return at;
  };

  it('② 事件发生在前主人解绑之后：不给前主人补建', async () => {
    await request(http)
      .delete(`/api/v1/devices/${devFormer}/binding`)
      .set(auth(owner.token))
      .expect((r) => expect([200, 204]).toContain(r.status));
    const binding = await prisma.deviceBinding.findFirst({
      where: { deviceId: devFormer, userId: owner.id },
    });
    expect(binding?.unboundAt).not.toBeNull();
    const eventId = await orphanFall(
      devFormer,
      await after(binding!.unboundAt!),
    );
    await scheduler.reconcileLostTriggers();
    expect(await sosByEvent(prisma, eventId)).toBeNull();
    expect(await prisma.sosCase.count({ where: { deviceId: devFormer } })).toBe(
      0,
    );
  });

  it('③ 事件发生时已有进行中的单、重启时那一单已结束：不为这条旧事件新建一单、不重新通知联系人（服务重启最危险的一条）', async () => {
    const first = fallEnvelope(devMerged);
    await relay(http, owner.token, devMerged, [first]).expect(202);
    const ongoing = await sosByEvent(prisma, first.eventId as string);
    expect(ongoing?.status).toBe('pending');
    // 进行中期间又来一条，raw 落了库、进程在合并判定前被杀（正常流程下它只会被合并留档）
    const eventId = await orphanFall(
      devMerged,
      await after(ongoing!.createdAt),
    );
    // 进程重启前，那一单已被取消（或到期通知）——重启时已没有进行中的单可并入
    await cancelSos(http, owner.token, ongoing!.id).expect(200);
    resetMocks(mocks);
    await scheduler.reconcileLostTriggers();
    expect(await sosByEvent(prisma, eventId)).toBeNull();
    expect(await prisma.sosCase.count({ where: { deviceId: devMerged } })).toBe(
      1,
    );
    expect(sosSmsCalls(mocks)).toHaveLength(0);
  });

  it('④ 对照：上一单结束之后才发生的事件，照常补建（守卫不能过宽，否则真丢的单永远补不回来）', async () => {
    const first = fallEnvelope(devAfterFinal);
    await relay(http, owner.token, devAfterFinal, [first]).expect(202);
    const prev = await sosByEvent(prisma, first.eventId as string);
    await cancelSos(http, owner.token, prev!.id).expect(200);
    const finalized = await prisma.sosCase.findUnique({
      where: { id: prev!.id },
    });
    expect(finalized?.finalizedAt).not.toBeNull();
    // receivedAt 晚于上一单 finalizedAt
    const eventId = await orphanFall(
      devAfterFinal,
      await after(finalized!.finalizedAt!),
    );
    await scheduler.reconcileLostTriggers();
    const recovered = await sosByEvent(prisma, eventId);
    expect(recovered).not.toBeNull();
    expect(recovered!.userId).toBe(owner.id);
    expect(recovered!.status).toBe('pending');
  });
});
