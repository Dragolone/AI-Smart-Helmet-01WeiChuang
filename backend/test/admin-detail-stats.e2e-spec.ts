// Admin 设备详情 + 概览统计集成测试（API.md §10.1，指标集定稿）。
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

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('Admin 设备详情与概览统计 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ingest: IngestService;

  const run = Date.now();
  const deviceId = `e2e_admds_${run}`;
  const adminUsername = `e2e_admds_${run}`;
  const adminPassword = 'e2e_admin_pw_1';
  let adminToken: string;
  let ownerToken: string;
  const userIds: string[] = [];

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
    process.env.SOS_COUNTDOWN_SECONDS = '600';
    process.env.SOS_SCAN_INTERVAL_MS = '600000';

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
        settings: { beepVolume: 70 },
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

    const reg = await registerUser(app, http, {
      phone: randomPhone(),
      password: 'e2e_password_1',
    });
    ownerToken = reg.body.accessToken as string;
    userIds.push(reg.body.user.id as string);
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ deviceId, bindCode: `bc_${deviceId}` })
      .expect(200);

    // 心跳（置为在线）+ 今日事件 + 一单进行中 SOS + 一条坏报文
    await ingest.ingestRaw(
      envelope('device_status', { battery: 66 }),
      deviceId,
      'mqtt',
    );
    await ingest.ingestRaw(
      envelope('possible_fall', {
        location: {
          latitude: 22.5,
          longitude: 113.9,
          coordinateSystem: 'wgs84',
        },
      }),
      deviceId,
      'mqtt',
    );
    await ingest.ingestRaw('{broken', deviceId, 'mqtt');
  });

  afterAll(async () => {
    await prisma.sosNotification
      .deleteMany({ where: { sos: { deviceId } } })
      .catch(() => undefined);
    await prisma.sosCase
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await prisma.adminUser
      .delete({ where: { username: adminUsername } })
      .catch(() => undefined);
    await app.close();
  });

  it('设备详情：状态/绑定用户/生效设置/最近事件（含 _invalid，最新在前）', async () => {
    const res = await request(http)
      .get(`/api/v1/admin/devices/${deviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.online).toBe(true);
    expect(res.body.battery).toBe(66);
    expect(res.body.settings).toEqual({ beepVolume: 70 });
    expect(res.body.bindUser.id).toBe(userIds[0]);

    const events = res.body.recentEvents as Array<{
      eventType: string;
      source: string;
    }>;
    expect(events).toHaveLength(3);
    expect(events[0].eventType).toBe('_invalid'); // 最新在前
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['device_status', 'possible_fall', '_invalid']),
    );
    expect(events[0].source).toBe('mqtt');
  });

  it('设备详情：不存在 404', async () => {
    const res = await request(http)
      .get('/api/v1/admin/devices/no_such_device')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('概览统计：五指标齐全且覆盖本套件种下的数据；今日事件不含 _invalid', async () => {
    const res = await request(http)
      .get('/api/v1/admin/stats/overview')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const s = res.body as Record<string, number | string>;
    expect(s.deviceTotal as number).toBeGreaterThanOrEqual(1);
    expect(s.deviceOnline as number).toBeGreaterThanOrEqual(1);
    expect(s.userTotal as number).toBeGreaterThanOrEqual(1);
    // 本套件贡献 2 条合法今日事件；_invalid 不计入
    expect(s.todayEvents as number).toBeGreaterThanOrEqual(2);
    expect(s.activeSos as number).toBeGreaterThanOrEqual(1);
    expect(new Date(s.generatedAt as string).getTime()).not.toBeNaN();
  });

  it('token 隔离：无 token / 用户 token → 401', async () => {
    await request(http).get('/api/v1/admin/stats/overview').expect(401);
    await request(http)
      .get(`/api/v1/admin/devices/${deviceId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(401);
  });
});
