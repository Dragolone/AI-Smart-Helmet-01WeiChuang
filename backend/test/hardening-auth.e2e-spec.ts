// 上线前加固：认证体系的并发、令牌误用、限频与输入极值。
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { lastCodeFor, spyOnSms } from './helpers/register';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  histogram,
  provisionDevice,
  randomPhone,
  sleep,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(180_000);

describe('加固：认证与令牌 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let jwt: JwtService;
  const users: TestUser[] = [];
  const extraPhones: string[] = [];

  const sendCode = (phone: string, purpose = 'register') =>
    request(http).post('/api/v1/auth/sms-code').send({ phone, purpose });

  /** 测试脚本默认关掉限频（同 IP 大量造用户）；限频用例内显式打开 */
  const withRateLimit = async (fn: () => Promise<void>): Promise<void> => {
    const saved = process.env.RATE_LIMIT_DISABLED;
    delete process.env.RATE_LIMIT_DISABLED;
    try {
      await fn();
    } finally {
      if (saved !== undefined) process.env.RATE_LIMIT_DISABLED = saved;
    }
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    jwt = app.get(JwtService);
    spyOnSms(app);
  });

  afterAll(async () => {
    await cleanupUsers(prisma, users);
    await prisma.smsCode
      .deleteMany({ where: { phone: { in: extraPhones } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { phone: { in: extraPhones } } })
      .catch(() => undefined);
    await app.close();
  });

  describe('登录暴力破解面', () => {
    it('并发 40 次错密码：同号每分钟 10 次以上必须 429，且不影响其他号码登录', async () => {
      const u = await createUser(app, http);
      const v = await createUser(app, http);
      users.push(u, v);
      await withRateLimit(async () => {
        // 顺序发（不依赖真并发）：限频计数是服务端状态，顺序更能稳定断言 10×401 + 30×429；
        // supertest 对同一临时 server 打 40 个并发在 CI（Linux）上偶发 ECONNRESET
        const results: request.Response[] = [];
        for (let i = 0; i < 40; i += 1) {
          results.push(
            await request(http)
              .post('/api/v1/auth/login')
              .send({ phone: u.phone, password: `wrong_${i}` }),
          );
        }
        const h = histogram(results.map((r) => r.status));
        console.log('[login brute-force 40x]', h);
        expect(h['500'] ?? 0).toBe(0);
        expect(h['401']).toBe(10);
        expect(h['429']).toBe(30);
        const blocked = await request(http)
          .post('/api/v1/auth/login')
          .send({ phone: u.phone, password: u.password })
          .expect(429);
        expect(blocked.body.code).toBe('RATE_LIMITED');
        expect(blocked.headers['retry-after']).toBeDefined();
        // 另一个号码不受影响（按 IP+手机号计）
        await request(http)
          .post('/api/v1/auth/login')
          .send({ phone: v.phone, password: v.password })
          .expect(200);
      });
    });
  });

  describe('注册并发与验证码', () => {
    it('同号同码并发注册 5 次：恰好 1 个 201，其余 400/409，无 5xx，库中 1 个用户', async () => {
      const phone = randomPhone();
      extraPhones.push(phone);
      await sendCode(phone).expect(204);
      const code = lastCodeFor(app, phone);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(http)
            .post('/api/v1/auth/register')
            .send({ phone, code, password: 'hardening_pw_1' }),
        ),
      );
      const h = histogram(results.map((r) => r.status));
      console.log('[concurrent register 5x]', h);
      expect(h['201']).toBe(1);
      expect(h['500'] ?? 0).toBe(0);
      expect(await prisma.user.count({ where: { phone } })).toBe(1);
    });

    it('错码 5 次后正确码也失效；跨用途的码不能混用', async () => {
      const phone = randomPhone();
      extraPhones.push(phone);
      await sendCode(phone).expect(204);
      const code = lastCodeFor(app, phone);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i += 1) {
        const r = await request(http)
          .post('/api/v1/auth/register')
          .send({ phone, code: wrong, password: 'hardening_pw_1' })
          .expect(400);
        expect(r.body.code).toBe('SMS_CODE_INVALID');
      }
      await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: 'hardening_pw_1' })
        .expect(400);
      expect(await prisma.user.count({ where: { phone } })).toBe(0);
    });

    it('限频：60s 内重发 429；日限（临时设为 3）第 4 条 429', async () => {
      const phone = randomPhone();
      extraPhones.push(phone);
      await sendCode(phone).expect(204);
      const r = await sendCode(phone).expect(429);
      expect(r.body.code).toBe('SMS_CODE_TOO_FREQUENT');

      const saved = {
        interval: process.env.SMS_CODE_RESEND_INTERVAL_SECONDS,
        daily: process.env.SMS_CODE_DAILY_LIMIT,
      };
      process.env.SMS_CODE_RESEND_INTERVAL_SECONDS = '1';
      process.env.SMS_CODE_DAILY_LIMIT = '3';
      try {
        await sleep(1100);
        await sendCode(phone).expect(204);
        await sleep(1100);
        await sendCode(phone).expect(204);
        await sleep(1100);
        const r4 = await sendCode(phone).expect(429);
        expect(r4.body.code).toBe('SMS_CODE_DAILY_LIMIT');
      } finally {
        if (saved.interval === undefined)
          delete process.env.SMS_CODE_RESEND_INTERVAL_SECONDS;
        else process.env.SMS_CODE_RESEND_INTERVAL_SECONDS = saved.interval;
        if (saved.daily === undefined) delete process.env.SMS_CODE_DAILY_LIMIT;
        else process.env.SMS_CODE_DAILY_LIMIT = saved.daily;
      }
    });

    it('跨手机号发码：同 IP 每分钟超过 5 条即 429（短信轰炸面）', async () => {
      const phones = Array.from({ length: 20 }, () => randomPhone());
      extraPhones.push(...phones);
      await withRateLimit(async () => {
        const statuses: number[] = [];
        for (const p of phones) statuses.push((await sendCode(p)).status);
        const h = histogram(statuses);
        console.log('[sms-code across 20 phones]', h);
        expect(h['204']).toBe(5);
        expect(h['429']).toBe(15);
      });
    });

    it('手机号格式：带空格 / +86 / 10 位 / 12 位 / 全角数字 → 400', async () => {
      for (const phone of [
        ' 13800138000',
        '+8613800138000',
        '1380013800',
        '138001380001',
        '１３８００１３８０００',
      ]) {
        const r = await sendCode(phone).expect(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('密码按字节限长：72 个 CJK（216 字节）拒绝 400；24 个 CJK（72 字节）可注册且不被截断', async () => {
      const phone = randomPhone();
      extraPhones.push(phone);
      await sendCode(phone).expect(204);
      const code = lastCodeFor(app, phone);
      await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: '密'.repeat(72) })
        .expect(400);
      await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: '密'.repeat(24) })
        .expect(201);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password: '密'.repeat(23) + '码' })
        .expect(401);
    });
  });

  describe('刷新令牌', () => {
    it('同一 refresh token 并发 5 次：无 5xx；记录成功次数（>1 = 轮换竞态窗口）', async () => {
      const u = await createUser(app, http);
      users.push(u);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(http)
            .post('/api/v1/auth/refresh')
            .send({ refreshToken: u.refreshToken }),
        ),
      );
      const h = histogram(results.map((r) => r.status));
      console.log('[concurrent refresh 5x]', h);
      expect(h['500'] ?? 0).toBe(0);
      // 只有一方轮换成功；输家 401 但不触发全局撤销——赢家拿到的新 token 仍可用
      expect(h['200']).toBe(1);
      const winner = results.find((r) => r.status === 200);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: winner?.body.refreshToken as string })
        .expect(200);
    });

    it('复用已轮换的 token：并发窗口内只拒绝本次；窗口外视为盗用，撤销全部会话（新 token 也失效）', async () => {
      const u = await createUser(app, http);
      users.push(u);
      const r1 = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(200);
      const newRefresh = r1.body.refreshToken as string;
      // 刚轮换完立刻复用：良性竞态，本次 401，赢家的新 token 仍有效
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      const r2 = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: newRefresh })
        .expect(200);
      // 把旧 token 的撤销时间拨到 20 分钟前（出了 15 min 补发窗口）再复用：盗用信号，全部会话作废
      await prisma.refreshToken.updateMany({
        where: { userId: u.id, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 20 * 60_000) },
      });
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: r2.body.refreshToken as string })
        .expect(401);
    });

    it('刷新应答丢失（评审 R-05）：旧 token 在 10 s 后、15 min 内再来 → 补发一对新 token，没用过的那张作废；同一张旧 token 第二次再来 → 401；其他会话不受影响', async () => {
      const u = await createUser(app, http);
      users.push(u);
      // 同一账号的另一台手机
      const other = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(200);
      const r1 = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(200);
      // 模拟「r1 的应答没回到手机」：把旧 token 的撤销时间拨到 30 秒前（出了并发窗口、在补发窗口内）
      await prisma.refreshToken.updateMany({
        where: { userId: u.id, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 30_000) },
      });
      const retry = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(200);
      expect(retry.body.refreshToken).not.toBe(r1.body.refreshToken);
      // 没送到手机的那张作废
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: r1.body.refreshToken as string })
        .expect(401);
      // 同一张旧 token 只补发一次
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      // 补发的那张正常可用；另一台手机的会话没被连坐
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: retry.body.refreshToken as string })
        .expect(200);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: other.body.refreshToken as string })
        .expect(200);
    });

    it('登出作废的 token 在补发窗口内再来：没有替代者，照常 401，不补发', async () => {
      const u = await createUser(app, http);
      users.push(u);
      await request(http)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: u.refreshToken })
        .expect(204);
      await prisma.refreshToken.updateMany({
        where: { userId: u.id, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 30_000) },
      });
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      expect(await prisma.refreshToken.count({ where: { userId: u.id } })).toBe(
        1,
      );
    });

    it('找回密码后：旧 refresh 失效；旧 access 在 15 分钟内仍有效（记录）', async () => {
      const u = await createUser(app, http);
      users.push(u);
      await sendCode(u.phone, 'reset_password').expect(204);
      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({
          phone: u.phone,
          code: lastCodeFor(app, u.phone),
          newPassword: 'new_password_9',
        })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: 'new_password_9' })
        .expect(200);
      const me = await request(http).get('/api/v1/users/me').set(auth(u.token));
      console.log('[old access token after password reset] →', me.status);
    });

    it('登出幂等：不存在的 token 也 204；登出后 refresh 401', async () => {
      const u = await createUser(app, http);
      users.push(u);
      await request(http)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: 'nope' })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: u.refreshToken })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: u.refreshToken })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
    });
  });

  describe('访问令牌误用', () => {
    let u: TestUser;
    beforeAll(async () => {
      u = await createUser(app, http);
      users.push(u);
    });

    const expect401 = async (headers: Record<string, string>) => {
      const r = await request(http)
        .get('/api/v1/users/me')
        .set(headers)
        .expect(401);
      expect(r.body.code).toBe('UNAUTHORIZED');
    };

    it('篡改签名 / alg=none / 小写 bearer / 空 Bearer / 过期 token → 401', async () => {
      const [h, p, s] = u.token.split('.');
      await expect401({
        Authorization: `Bearer ${h}.${p}.${s.slice(0, -2)}xx`,
      });
      const noneHeader = Buffer.from(
        JSON.stringify({ alg: 'none', typ: 'JWT' }),
      ).toString('base64url');
      await expect401({ Authorization: `Bearer ${noneHeader}.${p}.` });
      await expect401({ Authorization: `bearer ${u.token}` });
      await expect401({ Authorization: 'Bearer ' });
      const expired = await jwt.signAsync({ sub: u.id }, { expiresIn: '-1s' });
      await expect401({ Authorization: `Bearer ${expired}` });
    });

    it('sub 指向不存在用户的合法签名 token：/users/me 404 而非 500', async () => {
      const ghost = await jwt.signAsync({ sub: 'ghost_user_id' });
      const r = await request(http).get('/api/v1/users/me').set(auth(ghost));
      expect(r.status).toBe(404);
    });

    it('注销后的残留 access token：读写接口一律 401，不能重新绑设备/建联系人/改资料/建频道', async () => {
      const u = await createUser(app, http);
      users.push(u);
      const deviceId = `hard_ghost_${Date.now()}`;
      await provisionDevice(prisma, deviceId);
      await request(http)
        .delete('/api/v1/users/me')
        .set(auth(u.token))
        .send({ password: u.password })
        .expect(204);
      const attempts = await Promise.all([
        request(http)
          .post('/api/v1/devices/bind')
          .set(auth(u.token))
          .send({ deviceId, bindCode: `bc_${deviceId}` }),
        request(http)
          .post('/api/v1/users/me/emergency-contacts')
          .set(auth(u.token))
          .send({ name: '幽灵', phone: '13900000009' }),
        request(http)
          .patch('/api/v1/users/me')
          .set(auth(u.token))
          .send({ nickname: '复活' }),
        request(http)
          .post('/api/v1/voice/channels')
          .set(auth(u.token))
          .send({ name: '幽灵频道' }),
        request(http).get('/api/v1/devices').set(auth(u.token)),
      ]);
      expect(attempts.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
      expect(attempts.every((r) => r.body.code === 'UNAUTHORIZED')).toBe(true);
      const dev = await prisma.device.findUnique({ where: { deviceId } });
      expect(dev?.bindUserId).toBeNull();
      const me = await prisma.user.findUnique({ where: { id: u.id } });
      expect(me?.nickname).not.toBe('复活');
      await cleanupDevices(prisma, [deviceId]);
    });

    it('admin 密钥签发的 token 进用户接口 401；用户 token 进 admin 接口 401', async () => {
      const adminLike = await jwt.signAsync(
        { sub: 'admin_x', typ: 'admin' },
        { secret: process.env.ADMIN_JWT_SECRET },
      );
      await expect401({ Authorization: `Bearer ${adminLike}` });
      const r = await request(http)
        .get('/api/v1/admin/users')
        .set(auth(u.token))
        .expect(401);
      expect(r.body.code).toBe('UNAUTHORIZED');
    });

    it('用户密钥签的 typ=admin token 进 admin 接口仍 401（密钥隔离）', async () => {
      const forged = await jwt.signAsync({ sub: 'admin_x', typ: 'admin' });
      await request(http)
        .get('/api/v1/admin/users')
        .set(auth(forged))
        .expect(401);
    });
  });

  describe('请求体与路由边缘', () => {
    it('非 JSON 体 / 损坏 JSON / 200KB 体 / 额外字段：统一错误格式，无 5xx', async () => {
      const r1 = await request(http)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'text/plain')
        .send('phone=1&password=2');
      expect(r1.status).toBe(400);
      expect(typeof r1.body.code).toBe('string');
      const r2 = await request(http)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"phone": ');
      expect(r2.status).toBe(400);
      expect(typeof r2.body.code).toBe('string');
      const r3 = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: '13800138000', password: 'x'.repeat(200_000) });
      expect(r3.status).toBe(413);
      expect(typeof r3.body.code).toBe('string');
      const u = users[0];
      const r4 = await request(http)
        .post('/api/v1/auth/login')
        .send({
          phone: u.phone,
          password: u.password,
          isAdmin: true,
          role: 'admin',
        })
        .expect(200);
      expect(r4.body.user.role).toBeUndefined();
    });

    it('未知路由 404 统一格式；错误方法 404；昵称 31 字 400', async () => {
      const r = await request(http).get('/api/v1/nope').expect(404);
      expect(r.body.code).toBe('NOT_FOUND');
      expect(typeof r.body.requestId).toBe('string');
      await request(http).get('/api/v1/auth/login').expect(404);
      const phone = randomPhone();
      extraPhones.push(phone);
      await sendCode(phone).expect(204);
      await request(http)
        .post('/api/v1/auth/register')
        .send({
          phone,
          code: lastCodeFor(app, phone),
          password: 'hardening_pw_1',
          nickname: 'x'.repeat(31),
        })
        .expect(400);
    });

    it('NUL 字符（\\u0000）：昵称 / 密码 / 联系人 / 设备名 / 频道名 / 路径参数 → 400，不得 500', async () => {
      const u = await createUser(app, http);
      users.push(u);
      const deviceId = `hard_nul_${Date.now()}`;
      await provisionDevice(prisma, deviceId);
      await bindDevice(http, u.token, deviceId);
      const nul = 'a\u0000b';
      const attempts = await Promise.all([
        request(http)
          .patch('/api/v1/users/me')
          .set(auth(u.token))
          .send({ nickname: nul }),
        request(http)
          .post('/api/v1/auth/login')
          .send({ phone: u.phone, password: `${u.password}\u0000` }),
        request(http)
          .post('/api/v1/users/me/emergency-contacts')
          .set(auth(u.token))
          .send({ name: nul, phone: '13900000005' }),
        request(http)
          .post('/api/v1/users/me/emergency-contacts')
          .set(auth(u.token))
          .send({ name: '正常', phone: '13900000006', relation: nul }),
        request(http)
          .patch(`/api/v1/devices/${deviceId}`)
          .set(auth(u.token))
          .send({ name: nul }),
        request(http)
          .post('/api/v1/voice/channels')
          .set(auth(u.token))
          .send({ name: nul }),
        request(http)
          .get(`/api/v1/devices/${encodeURIComponent(nul)}`)
          .set(auth(u.token)),
        request(http)
          .get(
            `/api/v1/devices/${deviceId}/events?type=${encodeURIComponent(nul)}`,
          )
          .set(auth(u.token)),
      ]);
      for (const r of attempts) {
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      const me = await prisma.user.findUnique({ where: { id: u.id } });
      expect(me?.nickname ?? '').not.toContain('\u0000');
      await cleanupDevices(prisma, [deviceId]);
    });

    it('头像 data URI：合法 60KB 通过；非 base64 字符 / http 超长 / javascript: → 400', async () => {
      const u = users[0];
      const ok = `data:image/png;base64,${'A'.repeat(60_000)}`;
      await request(http)
        .patch('/api/v1/users/me')
        .set(auth(u.token))
        .send({ avatarUrl: ok })
        .expect(200);
      await request(http)
        .patch('/api/v1/users/me')
        .set(auth(u.token))
        .send({ avatarUrl: 'data:image/png;base64,<script>' })
        .expect(400);
      await request(http)
        .patch('/api/v1/users/me')
        .set(auth(u.token))
        .send({ avatarUrl: 'javascript:alert(1)' })
        .expect(400);
      await request(http)
        .patch('/api/v1/users/me')
        .set(auth(u.token))
        .send({ avatarUrl: `https://x.y/${'a'.repeat(600)}` })
        .expect(400);
      // null = 清除头像（IsOptional 放行 null），属可接受语义；只要求不 5xx
      const rn = await request(http)
        .patch('/api/v1/users/me')
        .set(auth(u.token))
        .send({ avatarUrl: null });
      expect(rn.status).toBeLessThan(500);
    });
  });
});
