// 媒体链路集成测试（API.md §9）：video_ready 入库与双重幂等、事件详情 media 关联、
// 预签名 URL 换取（时效/归属/未就绪 409）。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('媒体元数据与预签名 URL (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ingest: IngestService;

  const deviceId = `e2e_media_${Date.now()}`;
  let ownerToken: string;
  let otherToken: string;
  const riskEventId = randomUUID();

  const envelope = (
    eventType: string,
    payload: Record<string, unknown>,
    eventId = randomUUID(),
  ): string =>
    JSON.stringify({
      schemaVersion: 1,
      eventId,
      deviceId,
      eventType,
      timestamp: new Date().toISOString(),
      firmwareVersion: '0.1.0-e2e',
      payload,
    });

  beforeAll(async () => {
    // 短时效验证 expiresAt 窗口
    process.env.MEDIA_URL_TTL_SECONDS = '60';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(requestIdMiddleware);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new UnifiedExceptionFilter());
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    ingest = app.get(IngestService);

    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
        bindCode: `bc_${deviceId}`,
      },
    });
    const register = async (): Promise<string> => {
      const res = await registerUser(app, http, {
        phone: randomPhone(),
        password: 'e2e_password_1',
      });
      return res.body.accessToken as string;
    };
    ownerToken = await register();
    otherToken = await register();
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ deviceId, bindCode: `bc_${deviceId}` })
      .expect(200);

    // 一条危险事件，供 relatedEventId 关联
    await ingest.ingestRaw(
      envelope('collision_risk', { riskLevel: 'high' }, riskEventId),
      deviceId,
      'mqtt',
    );
  });

  afterAll(async () => {
    await prisma.media
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  it('video_ready 入库；同 eventId 重发 + 同 videoId 换 eventId 重发都只留一条', async () => {
    const eventId = randomUUID();
    const payload = {
      videoId: 'vid_001',
      relatedEventId: riskEventId,
      duration: 12,
      sizeBytes: 3_500_000,
      storageKey: `mock/${deviceId}/vid_001.mp4`,
    };
    await ingest.ingestRaw(
      envelope('video_ready', payload, eventId),
      deviceId,
      'mqtt',
    );
    // 同 eventId 重发（QoS1 重复交付）
    await ingest.ingestRaw(
      envelope('video_ready', payload, eventId),
      deviceId,
      'mqtt',
    );
    // 同 videoId 但新 eventId（设备重复宣告）
    await ingest.ingestRaw(envelope('video_ready', payload), deviceId, 'mqtt');

    const rows = await prisma.media.findMany({ where: { deviceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      videoId: 'vid_001',
      relatedEventId: riskEventId,
      duration: 12,
      status: 'ready',
    });
  });

  it('缺 videoId 的 video_ready：raw 留档但不入媒体表', async () => {
    await ingest.ingestRaw(
      envelope('video_ready', { duration: 5 }),
      deviceId,
      'mqtt',
    );
    expect(await prisma.media.count({ where: { deviceId } })).toBe(1);
  });

  it('事件详情 media 关联：危险事件反查到关联媒体；video_ready 事件带自身条目', async () => {
    const risk = await request(http)
      .get(`/api/v1/events/${riskEventId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(risk.body.media).toHaveLength(1);
    expect(risk.body.media[0]).toMatchObject({ status: 'ready', duration: 12 });

    const mediaRow = await prisma.media.findFirstOrThrow({
      where: { deviceId, videoId: 'vid_001' },
    });
    const videoEvent = await request(http)
      .get(`/api/v1/events/${mediaRow.eventId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(videoEvent.body.media[0].mediaId).toBe(mediaRow.id);
  });

  it('换取预签名 URL：url 含 storageKey、expiresAt 在时效窗口内', async () => {
    const mediaRow = await prisma.media.findFirstOrThrow({
      where: { deviceId, videoId: 'vid_001' },
    });
    const before = Date.now();
    const res = await request(http)
      .get(`/api/v1/media/${mediaRow.id}/url`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.url).toContain(`mock/${deviceId}/vid_001.mp4`);
    const expiresAt = new Date(res.body.expiresAt as string).getTime();
    // TTL=60s（本套件 env）：允许秒级执行误差
    expect(expiresAt).toBeGreaterThan(before + 55_000);
    expect(expiresAt).toBeLessThan(before + 65_000);
  });

  it('未上传就绪（无 storageKey）→ 409 MEDIA_NOT_READY', async () => {
    await ingest.ingestRaw(
      envelope('video_ready', { videoId: 'vid_pending' }),
      deviceId,
      'mqtt',
    );
    const pending = await prisma.media.findFirstOrThrow({
      where: { deviceId, videoId: 'vid_pending' },
    });
    expect(pending.status).toBe('pending_upload');
    const res = await request(http)
      .get(`/api/v1/media/${pending.id}/url`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
    expect(res.body.code).toBe('MEDIA_NOT_READY');
  });

  it('归属：他人换 URL → 404（不泄露存在性）；未登录 401；不存在的 mediaId 404', async () => {
    const mediaRow = await prisma.media.findFirstOrThrow({
      where: { deviceId, videoId: 'vid_001' },
    });
    const res = await request(http)
      .get(`/api/v1/media/${mediaRow.id}/url`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
    await request(http).get(`/api/v1/media/${mediaRow.id}/url`).expect(401);
    await request(http)
      .get('/api/v1/media/nonexistent/url')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });
});
