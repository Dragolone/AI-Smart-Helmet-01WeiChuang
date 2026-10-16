// 补测发现的端到端复现（test/coverage-findings-1016.md）：真库 + 真 HTTP，只断言现状。
// BC1：(0,0) 位置点进轨迹表 → 最新位置返回 (0,0)；摔倒事件自带 (0,0) 被当缺失、回落最新轨迹点（#202 起跳过 (0,0)）。
// BC3：对讲频道名全空白也能建。修好后把这里的期望改成修复后的口径。
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
  `17${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('补测发现复现（cov e2e）', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ingest: IngestService;
  let token: string;
  let userId: string;
  const deviceId = `cov_f_${Date.now()}`;

  const envelope = (
    eventType: string,
    payload: Record<string, unknown>,
  ): string =>
    JSON.stringify({
      schemaVersion: 1,
      eventId: randomUUID(),
      deviceId,
      eventType,
      timestamp: new Date().toISOString(),
      firmwareVersion: '0.1.0-cov',
      payload,
    });

  beforeAll(async () => {
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
        deviceSecretHash: createHash('sha256').update('cov').digest('hex'),
        bindCode: `bc_${deviceId}`,
      },
    });
    const res = await registerUser(app, http, {
      phone: randomPhone(),
      password: 'cov_password_1',
    });
    token = res.body.accessToken as string;
    userId = res.body.user.id as string;
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceId, bindCode: `bc_${deviceId}` })
      .expect(200);
  });

  afterAll(async () => {
    await prisma.sosNotification
      .deleteMany({ where: { sos: { deviceId } } })
      .catch(() => undefined);
    await prisma.sosCase
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.locationPoint
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.voiceChannelMember
      .deleteMany({ where: { userId } })
      .catch(() => undefined);
    await prisma.voiceChannel
      .deleteMany({ where: { ownerId: userId } })
      .catch(() => undefined);
    await prisma.deviceBinding
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  it('BC1：(0,0) 位置点照收、最新位置仍返回 (0,0)（现状）；摔倒事件位置 (0,0) 回落时跳过 (0,0) 点，没有别的点 → 事故无位置（#202 B2 已修）', async () => {
    await expect(
      ingest.ingestRaw(
        envelope('location_update', {
          latitude: 0,
          longitude: 0,
          coordinateSystem: 'wgs84',
          accuracy: 5,
          speed: 0,
          heading: 0,
        }),
        deviceId,
        'mqtt',
      ),
    ).resolves.toBe('stored');

    const latest = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations/latest`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(latest.body.location).toMatchObject({ latitude: 0, longitude: 0 });

    await expect(
      ingest.ingestRaw(
        envelope('possible_fall', {
          confidence: 0.9,
          location: { latitude: 0, longitude: 0, coordinateSystem: 'wgs84' },
        }),
        deviceId,
        'mqtt',
      ),
    ).resolves.toBe('stored');

    const accidents = await request(http)
      .get(`/api/v1/devices/${deviceId}/accidents`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(accidents.body.items).toHaveLength(1);
    expect(accidents.body.items[0].location).toBeNull();

    // 取消掉，免得到期扫描去通知（本账号没有联系人，也只会走 Console Mock）
    await request(http)
      .post(`/api/v1/sos/${accidents.body.items[0].sosId as string}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('BC3 现状：对讲频道名全空白 → 201 照建（名字原样存三个空格）', async () => {
    const res = await request(http)
      .post('/api/v1/voice/channels')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '   ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('   ');
  });

  it('对照：联系人名全空白 → 400（已先 trim 再验）', async () => {
    const res = await request(http)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '   ', phone: '13800001111' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
