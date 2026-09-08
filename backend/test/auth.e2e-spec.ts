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
import { lastCodeFor, spyOnSms } from './helpers/register';

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

  it('sms-code：purpose 非法 → 400', async () => {
    await request(http)
      .post('/api/v1/auth/sms-code')
      .send({ phone, purpose: 'login' })
      .expect(400);
  });

  it('sms-code：下发验证码 → 204，短信通道收到 6 位码', async () => {
    const sms = spyOnSms(app);
    await request(http)
      .post('/api/v1/auth/sms-code')
      .send({ phone, purpose: 'register' })
      .expect(204);
    expect(lastCodeFor(app, phone)).toMatch(/^\d{6}$/);
    expect(sms).toHaveBeenCalled();
  });

  it('sms-code：60s 内重发 → 429 SMS_CODE_TOO_FREQUENT', async () => {
    const res = await request(http)
      .post('/api/v1/auth/sms-code')
      .send({ phone, purpose: 'register' })
      .expect(429);
    expect(res.body.code).toBe('SMS_CODE_TOO_FREQUENT');
  });

  it('注册：缺 code → 400；code 错误 → 400 SMS_CODE_INVALID', async () => {
    await request(http)
      .post('/api/v1/auth/register')
      .send({ phone, password })
      .expect(400);
    const wrong = lastCodeFor(app, phone) === '000000' ? '111111' : '000000';
    const res = await request(http)
      .post('/api/v1/auth/register')
      .send({ phone, password, code: wrong })
      .expect(400);
    expect(res.body.code).toBe('SMS_CODE_INVALID');
  });

  it('注册成功并返回 token 对', async () => {
    const res = await request(http)
      .post('/api/v1/auth/register')
      .send({
        phone,
        password,
        nickname: '测试骑手',
        code: lastCodeFor(app, phone),
      })
      .expect(201);
    expect(res.body.user.phone).toBe(phone);
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it('同一验证码二次使用 → 400 SMS_CODE_INVALID（一次性）', async () => {
    const res = await request(http)
      .post('/api/v1/auth/register')
      .send({ phone: randomPhone(), password, code: lastCodeFor(app, phone) })
      .expect(400);
    expect(res.body.code).toBe('SMS_CODE_INVALID');
  });

  it('重复注册同一手机号 → 409 PHONE_ALREADY_REGISTERED', async () => {
    const res = await request(http)
      .post('/api/v1/auth/register')
      .send({ phone, password, code: '123456' })
      .expect(409);
    expect(res.body.code).toBe('PHONE_ALREADY_REGISTERED');
    expect(res.body.requestId).toMatch(/^req_/);
  });

  it('sms-code：register 用途下已注册号 → 409；reset_password 用途下未注册号 → 404', async () => {
    const a = await request(http)
      .post('/api/v1/auth/sms-code')
      .send({ phone, purpose: 'register' })
      .expect(409);
    expect(a.body.code).toBe('PHONE_ALREADY_REGISTERED');
    const b = await request(http)
      .post('/api/v1/auth/sms-code')
      .send({ phone: randomPhone(), purpose: 'reset_password' })
      .expect(404);
    expect(b.body.code).toBe('PHONE_NOT_REGISTERED');
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
  it('reset-password：验证码通过 → 204，旧密码失效、新密码可登录、旧 refresh 作废', async () => {
    const newPassword = 'new_password_456';
    await request(http)
      .post('/api/v1/auth/sms-code')
      .send({ phone, purpose: 'reset_password' })
      .expect(204);
    await request(http)
      .post('/api/v1/auth/reset-password')
      .send({ phone, code: lastCodeFor(app, phone), newPassword })
      .expect(204);
    await request(http)
      .post('/api/v1/auth/login')
      .send({ phone, password })
      .expect(401);
    const res = await request(http)
      .post('/api/v1/auth/login')
      .send({ phone, password: newPassword })
      .expect(200);
    expect(res.body.accessToken).toBeTruthy();
  });
});
