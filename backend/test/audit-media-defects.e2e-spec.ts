// 2026-09-13 全面审计 media 领域——【预期失败】缺陷复现（保留失败测试作证据，不改业务源码）。
// MEDIA-01：事件详情的 media 反查只按 relatedEventId 匹配，不限定同一 deviceId——
//           另一台设备（他人绑定）上报 video_ready 且 relatedEventId 指向本人事件，
//           本人事件详情即出现他人设备的媒体条目（mediaId/status/duration 泄露，URL 仍 404）。
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  type Http,
  type TestUser,
} from './helpers/hardening';
import { postWebhook } from './helpers/audit-voice';
import { IngestService } from '../src/ingest/ingest.service';

jest.setTimeout(60_000);
const API_KEY = 'audit_0913_webhook_key';

describe('audit-media-defects：预期失败的缺陷复现 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const devices: string[] = [];

  beforeAll(async () => {
    process.env.INGEST_WEBHOOK_API_KEY = API_KEY;
    ({ app, http, prisma } = await buildApp());
  });
  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('MEDIA-01 他人设备经自己的 MQTT topic 上报 relatedEventId=本人事件 → 本人事件详情不应混入他人媒体', async () => {
    const victim = await createUser(app, http);
    const attacker = await createUser(app, http);
    users.push(victim, attacker);
    const devV = `audit_mdef_v_${Date.now()}`;
    const devA = `audit_mdef_a_${Date.now()}`;
    await provisionDevice(prisma, devV);
    await provisionDevice(prisma, devA);
    devices.push(devV, devA);
    await bindDevice(http, victim.token, devV);
    await bindDevice(http, attacker.token, devA);

    const riskEventId = randomUUID();
    await postWebhook(
      http,
      API_KEY,
      envelope(
        devV,
        'collision_risk',
        { riskLevel: 'high' },
        { eventId: riskEventId },
      ),
    ).expect(202);

    // 攻击者的设备走 4G 版 MQTT 路径（只发自己的 topic，未越权）投递 video_ready，
    // relatedEventId 指向受害者的事件。app-relay 入口不接 video_ready（不在蓝牙版 7 类白名单内），
    // 故此处用 Ingest 层的 mqtt 来源等价调用（与 MqttConsumerService.processPublish 同一路径）。
    const outcome = await app.get(IngestService).ingestRaw(
      JSON.stringify(
        envelope(devA, 'video_ready', {
          videoId: 'vid_inject',
          relatedEventId: riskEventId,
          storageKey: `mock/${devA}/vid_inject.mp4`,
          duration: 99,
        }),
      ),
      devA,
      'mqtt',
    );
    expect(outcome).toBe('stored');

    const detail = await request(http)
      .get(`/api/v1/events/${riskEventId}`)
      .set(auth(victim.token))
      .expect(200);

    console.log(
      '[MEDIA-01] 受害者事件详情 media',
      JSON.stringify(detail.body.media),
    );
    const injected = await prisma.media.findUniqueOrThrow({
      where: { deviceId_videoId: { deviceId: devA, videoId: 'vid_inject' } },
    });
    // URL 层归属校验仍挡住（媒体属设备 devA）
    await request(http)
      .get(`/api/v1/media/${injected.id}/url`)
      .set(auth(victim.token))
      .expect(404);
    // 详情层应只返回本设备媒体
    expect(
      (detail.body.media as Array<{ mediaId: string }>).map((m) => m.mediaId),
    ).not.toContain(injected.id);
  });
});
