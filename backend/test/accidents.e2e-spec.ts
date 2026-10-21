// 事故记录查询集成测试：列表（分页/排序/双过滤）、详情（快照/触发 payload/通知脱敏）、
// Admin 事故列表（筛选/归属用户/token 隔离）。
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
import { settleSosDelivery } from './helpers/audit-sos';
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('事故记录查询 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ingest: IngestService;

  const run = Date.now();
  const deviceId = `e2e_acc_${run}`;
  const adminUsername = `e2e_acc_admin_${run}`;
  const adminPassword = 'e2e_admin_pw_1';
  let ownerToken: string;
  let otherToken: string;
  let adminToken: string;
  const userIds: string[] = [];

  let cancelledId: string;
  let notifiedId: string;
  let pendingId: string;

  const fallEnvelope = (eventId: string): string =>
    JSON.stringify({
      schemaVersion: 1,
      eventId,
      deviceId,
      eventType: 'possible_fall',
      timestamp: new Date().toISOString(),
      firmwareVersion: '0.1.0-e2e',
      payload: {
        confidence: 0.91,
        algorithmVersion: 'e2e-fall-v1',
        location: {
          latitude: 40.94901,
          longitude: 115.41802,
          coordinateSystem: 'wgs84',
          accuracy: 6,
        },
      },
    });

  const sosCaseOf = (eventId: string) =>
    prisma.sosCase.findFirstOrThrow({ where: { triggerEventId: eventId } });

  beforeAll(async () => {
    process.env.SOS_COUNTDOWN_SECONDS = '600'; // 长倒计时：本套件不测到期，pending 稳定存在
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
      },
    });
    await prisma.adminUser.create({
      data: {
        username: adminUsername,
        passwordHash: await bcrypt.hash(adminPassword, 10),
      },
    });

    const register = async (): Promise<string> => {
      const res = await registerUser(app, http, {
        phone: randomPhone(),
        password: 'e2e_password_1',
      });
      userIds.push(res.body.user.id as string);
      return res.body.accessToken as string;
    };
    ownerToken = await register();
    otherToken = await register();
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ deviceId, bindCode: `bc_${deviceId}` })
      .expect(200);
    await request(http)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '妈妈', phone: '13800001111' })
      .expect(201);

    const adminLogin = await request(http)
      .post('/api/v1/admin/auth/login')
      .send({ username: adminUsername, password: adminPassword })
      .expect(200);
    adminToken = adminLogin.body.accessToken as string;

    // 造三种终态：cancelled → notified → pending（创建顺序即时间序，列表断言最新在前）
    const e1 = randomUUID();
    await ingest.ingestRaw(fallEnvelope(e1), deviceId, 'mqtt');
    cancelledId = (await sosCaseOf(e1)).id;
    await request(http)
      .post(`/api/v1/sos/${cancelledId}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const e2 = randomUUID();
    await ingest.ingestRaw(fallEnvelope(e2), deviceId, 'mqtt');
    notifiedId = (await sosCaseOf(e2)).id;
    await request(http)
      .post(`/api/v1/sos/${notifiedId}/confirm`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    await settleSosDelivery(app);

    const e3 = randomUUID();
    await ingest.ingestRaw(fallEnvelope(e3), deviceId, 'mqtt');
    pendingId = (await sosCaseOf(e3)).id;
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
    await prisma.emergencyContact
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await prisma.adminUser
      .delete({ where: { username: adminUsername } })
      .catch(() => undefined);
    await app.close();
  });

  it('列表：含全部终态与进行中，最新在前，统一分页结构', async () => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/accidents`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.items.map((i: { sosId: string }) => i.sosId)).toEqual([
      pendingId,
      notifiedId,
      cancelledId,
    ]);
    expect(res.body.items.map((i: { status: string }) => i.status)).toEqual([
      'pending',
      'notified',
      'cancelled',
    ]);
    // 位置快照在列（三案例都带事件内嵌位置）
    expect(res.body.items[0].location).toMatchObject({
      latitude: 40.94901,
      coordinateSystem: 'wgs84',
      source: 'event',
    });
  });

  it('分页：pageSize=2 第二页剩 1 条', async () => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/accidents`)
      .query({ page: 2, pageSize: 2 })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].sosId).toBe(cancelledId);
  });

  it('详情：触发 payload 原样、通知记录含通道与重试信息、手机号已脱敏', async () => {
    const res = await request(http)
      .get(`/api/v1/accidents/${notifiedId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.status).toBe('notified');
    expect(res.body.triggerPayload).toMatchObject({
      confidence: 0.91,
      algorithmVersion: 'e2e-fall-v1',
    });
    expect(res.body.location.source).toBe('event');

    const notifications = res.body.notifications as Array<{
      channel: string;
      target: string;
      status: string;
      attempts: number;
      contactName: string | null;
    }>;
    expect(notifications).toHaveLength(2); // 1 联系人 SMS + 本人 Push
    const sms = notifications.find((n) => n.channel === 'sms');
    expect(sms?.target).toBe('138****1111'); // 出接口前脱敏
    expect(sms?.contactName).toBe('妈妈');
    expect(sms?.status).toBe('sent');
    expect(sms?.attempts).toBe(1);
    // 库里存的是原值（重试需要），脱敏只发生在接口层
    const row = await prisma.sosNotification.findFirstOrThrow({
      where: { sosId: notifiedId, channel: 'sms' },
    });
    expect(row.target).toBe('13800001111');
  });

  it('取消单详情：无通知记录（未触发任何发送）', async () => {
    const res = await request(http)
      .get(`/api/v1/accidents/${cancelledId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.notifications).toEqual([]);
  });

  it('归属：他人访问列表 → 404 DEVICE_NOT_FOUND；他人访问详情 → 404；未登录 → 401', async () => {
    const list = await request(http)
      .get(`/api/v1/devices/${deviceId}/accidents`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect(list.body.code).toBe('DEVICE_NOT_FOUND');
    await request(http)
      .get(`/api/v1/accidents/${notifiedId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(http)
      .get(`/api/v1/devices/${deviceId}/accidents`)
      .expect(401);
  });

  it('Admin 列表：全量可见、status/deviceId 筛选、带归属用户', async () => {
    const all = await request(http)
      .get('/api/v1/admin/accidents')
      .query({ deviceId })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(all.body.total).toBe(3);
    expect(all.body.items[0].user).toMatchObject({ id: userIds[0] });
    expect(typeof all.body.items[0].user.phone).toBe('string');

    const cancelled = await request(http)
      .get('/api/v1/admin/accidents')
      .query({ deviceId, status: 'cancelled' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(cancelled.body.total).toBe(1);
    expect(cancelled.body.items[0].sosId).toBe(cancelledId);

    // 非法 status 值被校验挡住
    await request(http)
      .get('/api/v1/admin/accidents')
      .query({ status: 'exploded' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('Admin token 隔离：用户 token 访问 admin 端点 → 401；admin token 访问用户端点 → 401', async () => {
    await request(http)
      .get('/api/v1/admin/accidents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(401);
    await request(http)
      .get(`/api/v1/devices/${deviceId}/accidents`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(401);
  });
});
