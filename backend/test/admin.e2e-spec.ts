// Admin 基础全链路集成测试：管理员登录 → 用户/设备列表 → 双向 token 隔离。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { PrismaService } from '../src/prisma/prisma.service';
import { registerUser } from './helpers/register';

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('Admin 基础 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  const adminUsername = `e2e_admin_${Date.now()}`;
  const adminPassword = 'e2e_admin_password_1';
  const onlineDeviceId = `e2e_adm_on_${Date.now()}`;
  const offlineDeviceId = `e2e_adm_off_${Date.now()}`;
  const userPhone = randomPhone();
  let adminToken: string;
  let userToken: string;

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

    // 管理员（与 create-admin 脚本同机制）+ 一在线一离线两台设备 + 一个 App 用户
    await prisma.adminUser.create({
      data: {
        username: adminUsername,
        passwordHash: await bcrypt.hash(adminPassword, 10),
      },
    });
    const secretHash = createHash('sha256').update('test_secret').digest('hex');
    await prisma.device.createMany({
      data: [
        {
          deviceId: onlineDeviceId,
          deviceSecretHash: secretHash,
          lastSeenAt: new Date(),
          battery: 66,
        },
        { deviceId: offlineDeviceId, deviceSecretHash: secretHash },
      ],
    });
    const reg = await registerUser(app, http, {
      phone: userPhone,
      password: 'e2e_password_1',
    });
    userToken = reg.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma.device
      .deleteMany({
        where: { deviceId: { in: [onlineDeviceId, offlineDeviceId] } },
      })
      .catch(() => undefined);
    await prisma.adminUser
      .delete({ where: { username: adminUsername } })
      .catch(() => undefined);
    await app.close();
  });

  it('错误密码登录 → 401 UNAUTHORIZED（不区分账号不存在与密码错误）', async () => {
    const res = await request(http)
      .post('/api/v1/admin/auth/login')
      .send({ username: adminUsername, password: 'wrong_password' })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(res.body.requestId).toMatch(/^req_/);
  });

  it('管理员登录成功，响应不含密码哈希', async () => {
    const res = await request(http)
      .post('/api/v1/admin/auth/login')
      .send({ username: adminUsername, password: adminPassword })
      .expect(200);
    expect(res.body.admin.username).toBe(adminUsername);
    expect(res.body.admin).not.toHaveProperty('passwordHash');
    adminToken = res.body.accessToken as string;
  });

  it('无 token 访问 admin 接口 → 401', async () => {
    const res = await request(http).get('/api/v1/admin/users').expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('App 用户 token 访问 admin 接口 → 401（密钥隔离）', async () => {
    await request(http)
      .get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(401);
  });

  it('admin token 访问 App 用户接口 → 401（反向隔离）', async () => {
    await request(http)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(401);
  });

  it('用户列表：统一分页结构，keyword 能检索到注册用户', async () => {
    const res = await request(http)
      .get('/api/v1/admin/users')
      .query({ keyword: userPhone })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20 });
    expect(typeof res.body.total).toBe('number');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].phone).toBe(userPhone);
    expect(res.body.items[0]).not.toHaveProperty('passwordHash');
    expect(res.body.items[0].deviceCount).toBe(0);
  });

  it('设备列表：含快照字段与在线判定', async () => {
    const res = await request(http)
      .get('/api/v1/admin/devices')
      .query({ keyword: onlineDeviceId })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.online).toBe(true);
    expect(item.battery).toBe(66);
    expect(item.bindUser).toBeNull();
  });

  it('设备列表 online 筛选：true 含在线设备，false 含离线设备', async () => {
    const online = await request(http)
      .get('/api/v1/admin/devices')
      .query({ online: 'true', pageSize: 100 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const onlineIds = online.body.items.map(
      (d: { deviceId: string }) => d.deviceId,
    );
    expect(onlineIds).toContain(onlineDeviceId);
    expect(onlineIds).not.toContain(offlineDeviceId);

    const offline = await request(http)
      .get('/api/v1/admin/devices')
      .query({ online: 'false', pageSize: 100 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const offlineIds = offline.body.items.map(
      (d: { deviceId: string }) => d.deviceId,
    );
    expect(offlineIds).toContain(offlineDeviceId);
    expect(offlineIds).not.toContain(onlineDeviceId);
  });

  it('非法分页参数 → 400 VALIDATION_FAILED', async () => {
    const res = await request(http)
      .get('/api/v1/admin/users')
      .query({ page: 0 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
