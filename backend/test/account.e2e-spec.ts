// 账号与安全（API.md §2，2026-09-11）：修改密码 / 换绑手机号 / 注销账号 全链路集成测试。
// 需要可用的 PostgreSQL（本地 docker compose / CI postgres service）+ 已跑 migration。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { PrismaService } from '../src/prisma/prisma.service';
import { lastCodeFor, registerUser } from './helpers/register';

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('账号与安全 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  const password = 'e2e_password_1';
  const newPassword = 'e2e_password_2';
  const deviceId = `e2e_acct_${Date.now()}`;
  const bindCode = '11223344';
  const userIds: string[] = [];

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256')
          .update('test_secret')
          .digest('hex'),
        bindCode,
      },
    });
  });

  afterAll(async () => {
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await prisma.emergencyContact
      .deleteMany({ where: { userId: { in: userIds } } })
      .catch(() => undefined);
    await app.close();
  });

  describe('修改密码', () => {
    const phone = randomPhone();
    let access: string;
    let keptRefresh: string;
    let otherRefresh: string;

    beforeAll(async () => {
      const reg = await registerUser(app, http, { phone, password });
      userIds.push(reg.body.user.id as string);
      access = reg.body.accessToken as string;
      keptRefresh = reg.body.refreshToken as string;
      // 第二台设备登录，用来验证"其他会话被撤销"
      const other = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password })
        .expect(200);
      otherRefresh = other.body.refreshToken as string;
    });

    it('未登录 → 401（非 @Public）', async () => {
      await request(http)
        .post('/api/v1/auth/change-password')
        .send({ oldPassword: password, newPassword })
        .expect(401);
    });

    it('新密码过短 → 400 校验失败', async () => {
      await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(access))
        .send({ oldPassword: password, newPassword: 'short' })
        .expect(400);
    });

    it('旧密码错误 → 400 PASSWORD_INCORRECT，密码不变', async () => {
      const res = await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(access))
        .send({ oldPassword: 'wrong_password_1', newPassword })
        .expect(400);
      expect(res.body.code).toBe('PASSWORD_INCORRECT');
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password })
        .expect(200);
    });

    it('旧密码正确 → 204；旧密码失效、新密码可登录', async () => {
      await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(access))
        .send({ oldPassword: password, newPassword, refreshToken: keptRefresh })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password: newPassword })
        .expect(200);
    });

    it('传入的 refreshToken 保留（本设备免重登），其他会话已撤销', async () => {
      const kept = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: keptRefresh })
        .expect(200);
      expect(kept.body.accessToken).toBeTruthy();
      const other = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: otherRefresh })
        .expect(401);
      expect(other.body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('换绑手机号', () => {
    const phone = randomPhone();
    const newPhone = randomPhone();
    let access: string;

    beforeAll(async () => {
      const reg = await registerUser(app, http, { phone, password });
      userIds.push(reg.body.user.id as string);
      access = reg.body.accessToken as string;
    });

    it('sms-code：change_phone 用途下新号已注册 → 409 PHONE_ALREADY_REGISTERED', async () => {
      const res = await request(http)
        .post('/api/v1/auth/sms-code')
        .send({ phone, purpose: 'change_phone' })
        .expect(409);
      expect(res.body.code).toBe('PHONE_ALREADY_REGISTERED');
    });

    it('sms-code：change_phone 发往新号 → 204', async () => {
      await request(http)
        .post('/api/v1/auth/sms-code')
        .send({ phone: newPhone, purpose: 'change_phone' })
        .expect(204);
      expect(lastCodeFor(app, newPhone)).toMatch(/^\d{6}$/);
    });

    it('未登录 → 401', async () => {
      await request(http)
        .post('/api/v1/auth/change-phone')
        .send({ newPhone, code: lastCodeFor(app, newPhone) })
        .expect(401);
    });

    it('验证码错误 → 400 SMS_CODE_INVALID，手机号不变', async () => {
      const right = lastCodeFor(app, newPhone);
      const wrong = right === '000000' ? '111111' : '000000';
      const res = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(access))
        .send({ newPhone, code: wrong })
        .expect(400);
      expect(res.body.code).toBe('SMS_CODE_INVALID');
      const me = await request(http)
        .get('/api/v1/users/me')
        .set(auth(access))
        .expect(200);
      expect(me.body.phone).toBe(phone);
    });

    it('新号已被他人注册 → 409 PHONE_ALREADY_REGISTERED（不消费验证码）', async () => {
      const takenPhone = randomPhone();
      const other = await registerUser(app, http, {
        phone: takenPhone,
        password,
      });
      userIds.push(other.body.user.id as string);
      const res = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(access))
        .send({ newPhone: takenPhone, code: '123456' })
        .expect(409);
      expect(res.body.code).toBe('PHONE_ALREADY_REGISTERED');
    });

    it('验证码正确 → 200 返回更新后的 user；新号可登录、旧号释放', async () => {
      const res = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(access))
        .send({ newPhone, code: lastCodeFor(app, newPhone) })
        .expect(200);
      expect(res.body.phone).toBe(newPhone);
      expect(res.body).not.toHaveProperty('passwordHash');
      const me = await request(http)
        .get('/api/v1/users/me')
        .set(auth(access))
        .expect(200);
      expect(me.body.phone).toBe(newPhone);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: newPhone, password })
        .expect(200);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password })
        .expect(401);
      // 旧号已释放：按"未注册号"处理
      const freed = await request(http)
        .post('/api/v1/auth/sms-code')
        .send({ phone, purpose: 'reset_password' })
        .expect(404);
      expect(freed.body.code).toBe('PHONE_NOT_REGISTERED');
    });
  });

  describe('注销账号', () => {
    const phone = randomPhone();
    let userId: string;
    let access: string;
    let refresh: string;

    beforeAll(async () => {
      const reg = await registerUser(app, http, { phone, password });
      userId = reg.body.user.id as string;
      userIds.push(userId);
      access = reg.body.accessToken as string;
      refresh = reg.body.refreshToken as string;
      await request(http)
        .post('/api/v1/devices/bind')
        .set(auth(access))
        .send({ deviceId, bindCode })
        .expect(200);
      await request(http)
        .post('/api/v1/users/me/emergency-contacts')
        .set(auth(access))
        .send({ name: '家人', phone: '13800138000' })
        .expect(201);
      await request(http)
        .patch('/api/v1/users/me')
        .set(auth(access))
        .send({ nickname: '张三' })
        .expect(200);
      await request(http)
        .patch(`/api/v1/devices/${deviceId}`)
        .set(auth(access))
        .send({ name: '张三的头盔' })
        .expect(200);
    });

    it('密码错误 → 400 PASSWORD_INCORRECT，账号原样', async () => {
      const res = await request(http)
        .delete('/api/v1/users/me')
        .set(auth(access))
        .send({ password: 'wrong_password_1' })
        .expect(400);
      expect(res.body.code).toBe('PASSWORD_INCORRECT');
      await request(http).get('/api/v1/users/me').set(auth(access)).expect(200);
    });

    it('密码正确 → 204；残留 access 访问 /users/me 401、refresh 401、旧号登录 401', async () => {
      await request(http)
        .delete('/api/v1/users/me')
        .set(auth(access))
        .send({ password })
        .expect(204);
      const me = await request(http)
        .get('/api/v1/users/me')
        .set(auth(access))
        .expect(401);
      expect(me.body.code).toBe('UNAUTHORIZED');
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: refresh })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password })
        .expect(401);
    });

    it('库中：软删除留档、phone 改写、头像清空、原号验证码记录删除、设备已解绑且自定义名清空、联系人已软删', async () => {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user?.deletedAt).toBeInstanceOf(Date);
      expect(user?.phone).toBe(`deleted:${userId}`);
      expect(user?.avatarUrl).toBeNull();
      // 隐私政策 V1.2：注销后「立即清除你的手机号」——验证码表里的手机号是明文
      expect(await prisma.smsCode.count({ where: { phone } })).toBe(0);
      const device = await prisma.device.findUnique({ where: { deviceId } });
      expect(device?.bindUserId).toBeNull();
      expect(device?.boundAt).toBeNull();
      expect(device?.name).toBeNull();
      const activeContacts = await prisma.emergencyContact.count({
        where: { userId, deletedAt: null },
      });
      expect(activeContacts).toBe(0);
      const allContacts = await prisma.emergencyContact.count({
        where: { userId },
      });
      expect(allContacts).toBe(1);
    });

    it('同一手机号可重新注册（新账号，设备可再次绑定）', async () => {
      // 清掉该号刚才注册时的验证码记录，等价于 60s 重发窗口已过
      await prisma.smsCode.deleteMany({ where: { phone } });
      const reg = await registerUser(app, http, { phone, password });
      const newId = reg.body.user.id as string;
      userIds.push(newId);
      expect(newId).not.toBe(userId);
      const contacts = await request(http)
        .get('/api/v1/users/me/emergency-contacts')
        .set(auth(reg.body.accessToken as string))
        .expect(200);
      expect(contacts.body).toEqual([]);
      await request(http)
        .post('/api/v1/devices/bind')
        .set(auth(reg.body.accessToken as string))
        .send({ deviceId, bindCode })
        .expect(200);
    });
  });
});
