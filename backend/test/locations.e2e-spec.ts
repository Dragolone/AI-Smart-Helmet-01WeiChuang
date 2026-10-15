// 位置链路集成测试：Ingest 入位置表 → latest / 轨迹范围查询 → 归属与参数校验。
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

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('位置与轨迹 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ingest: IngestService;

  const deviceId = `e2e_loc_${Date.now()}`;
  const bindCode = '13572468';
  // 基准取「2 小时前、对齐到整分」：断言排序与范围过滤只依赖相对偏移。
  // 不能写死日期——超过离线缓存窗口（72 h）的设备时间会被当成时钟错乱、改按收到时间入库（DEVICE_PROTOCOL §8）
  const base = Math.floor((Date.now() - 2 * 3_600_000) / 60_000) * 60_000;
  let ownerToken: string;
  let otherToken: string;

  const locationEnvelope = (offsetSec: number, altitude?: number): string =>
    JSON.stringify({
      schemaVersion: 1,
      eventId: randomUUID(),
      deviceId,
      eventType: 'location_update',
      timestamp: new Date(base + offsetSec * 1000).toISOString(),
      firmwareVersion: '0.1.0-e2e',
      payload: {
        latitude: 40.949 + offsetSec * 0.0001,
        longitude: 115.418,
        coordinateSystem: 'wgs84',
        accuracy: 8,
        speed: 12.5,
        heading: 45,
        ...(altitude !== undefined ? { altitude } : {}),
      },
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
    // RealtimeGateway 在模块图中，init 前必须装 WS 适配器（与 main.ts 一致）
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    ingest = app.get(IngestService);

    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
        bindCode,
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
      .send({ deviceId, bindCode })
      .expect(200);
  });

  afterAll(async () => {
    await prisma.locationPoint
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  it('无位置数据时 latest 返回 location: null', async () => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations/latest`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body).toEqual({ location: null });
  });

  it('Ingest location_update → 位置表（含海拔），重复 eventId 只入一次', async () => {
    for (let i = 0; i < 3; i++) {
      await ingest.ingestRaw(
        locationEnvelope(i * 5, 2100 - i * 10),
        deviceId,
        'mqtt',
      );
    }
    // 重复 envelope（同 eventId）不重复入位置表
    const dup = locationEnvelope(999);
    await ingest.ingestRaw(dup, deviceId, 'mqtt');
    await ingest.ingestRaw(dup, deviceId, 'mqtt');

    const count = await prisma.locationPoint.count({ where: { deviceId } });
    expect(count).toBe(4);
  });

  it('payload 不合法的 location_update：raw 留档但不进位置表', async () => {
    const bad = JSON.stringify({
      schemaVersion: 1,
      eventId: randomUUID(),
      deviceId,
      eventType: 'location_update',
      timestamp: new Date(base).toISOString(),
      firmwareVersion: '0.1.0-e2e',
      payload: { latitude: 91, longitude: 115.4, coordinateSystem: 'wgs84' },
    });
    await expect(ingest.ingestRaw(bad, deviceId, 'mqtt')).resolves.toBe(
      'stored',
    );
    const count = await prisma.locationPoint.count({ where: { deviceId } });
    expect(count).toBe(4);
  });

  it('latest 返回最新点（timestamp 最大者）', async () => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations/latest`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.location.timestamp).toBe(
      new Date(base + 999 * 1000).toISOString(),
    );
  });

  it('轨迹范围查询：时间正序、分页结构、海拔在列', async () => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations`)
      .query({
        from: new Date(base).toISOString(),
        to: new Date(base + 60_000).toISOString(),
      })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items).toHaveLength(3);
    const timestamps = res.body.items.map(
      (p: { timestamp: string }) => p.timestamp,
    );
    expect(timestamps).toEqual([...timestamps].sort());
    expect(res.body.items[0].altitude).toBe(2100);
    expect(res.body.items[0].coordinateSystem).toBe('wgs84');
  });

  it('分页生效：pageSize=2 时第二页只剩 1 条', async () => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations`)
      .query({
        from: new Date(base).toISOString(),
        to: new Date(base + 60_000).toISOString(),
        page: 2,
        pageSize: 2,
      })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBe(3);
  });

  it('参数校验：缺 from/to → 400；from ≥ to → 400；范围超 24h → 400', async () => {
    await request(http)
      .get(`/api/v1/devices/${deviceId}/locations`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);

    const eq = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations`)
      .query({
        from: new Date(base).toISOString(),
        to: new Date(base).toISOString(),
      })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
    expect(eq.body.code).toBe('VALIDATION_FAILED');

    const tooWide = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations`)
      .query({
        from: new Date(base).toISOString(),
        to: new Date(base + 25 * 3600_000).toISOString(),
      })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
    expect(tooWide.body.code).toBe('VALIDATION_FAILED');
  });

  it('非绑定用户查询 → 404（不泄露存在性）', async () => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations/latest`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
  });
});
