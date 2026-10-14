// eventId 幂等粒度 = 设备内（决策 #54，2026-10-14）。原先全局唯一：BLE 版 eventId 由公开算法从 deviceId + 序号推出，
// 任何绑了头盔的用户都能用自己的设备抢先占用别人的 eventId，让对方之后的摔倒被当成重复——不建单、不通知任何人。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  relay,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';

describe('eventId 只在设备内唯一 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let victim: TestUser;
  let attacker: TestUser;
  const victimDevice = `eid_victim_${Date.now()}`;
  const attackerDevice = `eid_attacker_${Date.now()}`;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    ingest = app.get(IngestService);
    victim = await createUser(app, http);
    attacker = await createUser(app, http);
    await provisionDevice(prisma, victimDevice);
    await provisionDevice(prisma, attackerDevice);
    await bindDevice(http, victim.token, victimDevice);
    await bindDevice(http, attacker.token, attackerDevice);
  });

  afterAll(async () => {
    await prisma.sosCase.deleteMany({
      where: { deviceId: { in: [victimDevice, attackerDevice] } },
    });
    await cleanupDevices(prisma, [victimDevice, attackerDevice]);
    await cleanupUsers(prisma, [victim, attacker]);
    await app.close();
  });

  it('别人用自己的设备抢先占用受害者的 eventId：受害者之后的摔倒照常建单，不被当成重复', async () => {
    // 攻击者算出受害者下一条事件的 eventId，先用自己的设备以一条位置事件占住它
    const stolenId = randomUUID();
    const squat = await relay(http, attacker.token, attackerDevice, [
      envelope(attackerDevice, 'location_update', validLocation(), {
        eventId: stolenId,
      }),
    ]).expect(202);
    expect(squat.body).toMatchObject({ accepted: 1, duplicate: 0 });

    // 受害者真摔倒，eventId 恰好就是那个
    const fall = await relay(http, victim.token, victimDevice, [
      envelope(
        victimDevice,
        'possible_fall',
        { confidence: 0.9 },
        { eventId: stolenId },
      ),
    ]).expect(202);
    expect(fall.body).toMatchObject({ accepted: 1, duplicate: 0 });

    // 两台设备各有一条同号的 raw；受害者有单
    const rows = await prisma.rawEvent.findMany({
      where: { eventId: stolenId },
      select: { deviceId: true, eventType: true },
    });
    expect(rows).toHaveLength(2);
    const sos = await prisma.sosCase.findFirst({
      where: { deviceId: victimDevice, triggerEventId: stolenId },
    });
    expect(sos).toMatchObject({ status: 'pending', userId: victim.id });

    // 受害者自己重放同一条（补传 / QoS1 重投）：设备内仍然幂等，只有一单
    const replay = await relay(http, victim.token, victimDevice, [
      envelope(
        victimDevice,
        'possible_fall',
        { confidence: 0.9 },
        { eventId: stolenId },
      ),
    ]).expect(202);
    expect(replay.body).toMatchObject({ accepted: 0, duplicate: 1 });
    expect(
      await prisma.sosCase.count({ where: { triggerEventId: stolenId } }),
    ).toBe(1);

    // 事件详情按本人设备找：各自看到自己那条
    const mine = await request(http)
      .get(`/api/v1/events/${stolenId}`)
      .set(auth(victim.token))
      .expect(200);
    expect(mine.body).toMatchObject({
      deviceId: victimDevice,
      eventType: 'possible_fall',
    });
    const theirs = await request(http)
      .get(`/api/v1/events/${stolenId}`)
      .set(auth(attacker.token))
      .expect(200);
    expect(theirs.body).toMatchObject({
      deviceId: attackerDevice,
      eventType: 'location_update',
    });
  });

  it('位置点与媒体同样按设备内去重：两台设备同号各存一条', async () => {
    const sharedId = randomUUID();
    for (const [user, deviceId] of [
      [attacker, attackerDevice],
      [victim, victimDevice],
    ] as const) {
      const res = await relay(http, user.token, deviceId, [
        envelope(deviceId, 'location_update', validLocation(1), {
          eventId: sharedId,
        }),
      ]).expect(202);
      expect(res.body).toMatchObject({ accepted: 1, duplicate: 0 });
    }
    expect(
      await prisma.locationPoint.count({ where: { eventId: sharedId } }),
    ).toBe(2);

    const videoEventId = randomUUID();
    for (const deviceId of [attackerDevice, victimDevice]) {
      const outcome = await ingest.ingestRaw(
        JSON.stringify(
          envelope(
            deviceId,
            'video_ready',
            { videoId: 'vid_shared', storageKey: `mock/${deviceId}/v.mp4` },
            { eventId: videoEventId },
          ),
        ),
        deviceId,
        'mqtt',
      );
      expect(outcome).toBe('stored');
    }
    expect(await prisma.media.count({ where: { eventId: videoEventId } })).toBe(
      2,
    );
  });
});
