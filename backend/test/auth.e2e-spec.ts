// Auth 全链路集成测试（Testing Rules 点名要求的注册/登录集成测试）。
// 需要可用的 PostgreSQL（本地 docker compose / CI postgres service）+ 已跑 migration。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';

// 随机手机号：反复跑不冲突，也不污染真实号段语义
const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('Auth 全链路 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const phone = randomPhone();
  const password = 'test_password_123';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // 与 main.ts 相同的全局装配，保证测的是真实行为
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
  });

  afterAll(async () => {
    await app.close();
  });

  let accessToken: string;
  let refreshToken: string;

  it('注册成功并返回 token 对', async () => {
    const res = await request(http)
      .post('/api/v1/auth/register')
      .send({ phone, password, nickname: '测试骑手' })
      .expect(201);
    expect(res.body.user.phone).toBe(phone);
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it('重复注册同一手机号 → 409 PHONE_ALREADY_REGISTERED', async () => {
    const res = await request(http)
      .post('/api/v1/auth/register')
      .send({ phone, password })
      .expect(409);
    expect(res.body.code).toBe('PHONE_ALREADY_REGISTERED');
    expect(res.body.requestId).toMatch(/^req_/);
  });

  it('登录成功', async () => {
    const res = await request(http)
      .post('/api/v1/auth/login')
      .send({ phone, password })
      .expect(200);
    accessToken = res.body.accessToken as string;
    refreshToken = res.body.refreshToken as string;
  });

  it('错误密码 → 401 UNAUTHORIZED（不区分账号不存在与密码错误）', async () => {
    const res = await request(http)
      .post('/api/v1/auth/login')
      .send({ phone, password: 'wrong_password_1' })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('带 token 访问 /users/me 成功；不带 token 401', async () => {
    const me = await request(http)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(me.body.phone).toBe(phone);

    const noToken = await request(http).get('/api/v1/users/me').expect(401);
    expect(noToken.body.code).toBe('UNAUTHORIZED');
  });

  it('PATCH /users/me 更新昵称', async () => {
    const res = await request(http)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ nickname: '新昵称' })
      .expect(200);
    expect(res.body.nickname).toBe('新昵称');
  });

  let rotatedRefresh: string;

  it('refresh 轮换：拿到新 token 对', async () => {
    const res = await request(http)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    rotatedRefresh = res.body.refreshToken as string;
    expect(rotatedRefresh).not.toBe(refreshToken);
  });

  it('旧 refresh token 复用 → 401，且触发全会话撤销（盗用防护）', async () => {
    await request(http)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    // 复用检测应连坐撤销刚轮换出的新 token
    await request(http)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotatedRefresh })
      .expect(401);
  });

  it('登出幂等：不存在的 token 也返回 204', async () => {
    await request(http)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: 'nonexistent-token' })
      .expect(204);
  });
});
