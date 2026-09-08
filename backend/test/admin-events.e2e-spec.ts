// Admin 全量事件查询集成测试（API.md §10）：类型/设备/invalid 视图切换、
// 排查字段（source/clockSkew/payload）、token 隔离。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

describe('Admin 全量事件查询 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ingest: IngestService;

  const run = Date.now();
  const deviceId = `e2e_admevt_${run}`;
  const adminUsername = `e2e_admevt_${run}`;
  const adminPassword = 'e2e_admin_pw_1';
  let adminToken: string;

  const envelope = (eventType: string, payload: Record<string, unknown>) =>
    JSON.stringify({
      schemaVersion: 1,
      eventId: randomUUID(),
      deviceId,
      eventType,
      timestamp: new Date().toISOString(),
      firmwareVersion: '0.1.0-e2e',
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
        deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
      },
    });
    await prisma.adminUser.create({
      data: {
        username: adminUsername,
        passwordHash: await bcrypt.hash(adminPassword, 10),
      },
    });
    const login = await request(http)
      .post('/api/v1/admin/auth/login')
      .send({ username: adminUsername, password: adminPassword })
      .expect(200);
    adminToken = login.body.accessToken as string;

    await ingest.ingestRaw(
      envelope('collision_risk', { riskLevel: 'high', direction: 'rear' }),
      deviceId,
      'mqtt',
    );
    await ingest.ingestRaw(
      envelope('sleep_entered', { reason: 'manual' }),
      deviceId,
      'mqtt',
    );
    await ingest.ingestRaw('{broken', deviceId, 'mqtt'); // _invalid 留档
  });

  afterAll(async () => {
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await prisma.adminUser
      .delete({ where: { username: adminUsername } })
      .catch(() => undefined);
    await app.close();
  });

  const list = (query: Record<string, string>) =>
    request(http)
      .get('/api/v1/admin/events')
      .query({ deviceId, ...query })
      .set('Authorization', `Bearer ${adminToken}`);

  it('默认视图：排除 _invalid、最新在前、带排查字段与 payload', async () => {
    const res = await list({}).expect(200);
    expect(res.body.total).toBe(2);
    const first = res.body.items[0] as Record<string, unknown>;
    expect(first.source).toBe('mqtt');
    expect(typeof first.clockSkew).toBe('boolean');
    expect(first.payload).toBeDefined();
    expect(
      res.body.items.every(
        (i: { eventType: string }) => i.eventType !== '_invalid',
      ),
    ).toBe(true);
  });

  it('type 多值过滤 + 未知类型 400', async () => {
    const filtered = await list({ type: 'collision_risk' }).expect(200);
    expect(filtered.body.total).toBe(1);
    const bad = await list({ type: 'exploded' }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
  });

  it('invalid=true：只看校验失败留档（原始报文在 payload 里）', async () => {
    const res = await list({ invalid: 'true' }).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].eventType).toBe('_invalid');
  });

  it('token 隔离：无 token / 用户 token 一律 401', async () => {
    await request(http).get('/api/v1/admin/events').expect(401);
    const reg = await registerUser(app, http, {
      phone: `19${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, '0')}`,
      password: 'e2e_password_1',
    });
    await request(http)
      .get('/api/v1/admin/events')
      .set('Authorization', `Bearer ${reg.body.accessToken as string}`)
      .expect(401);
  });
});
