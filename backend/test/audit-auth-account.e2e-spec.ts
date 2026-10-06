// 2026-09-13 全面审计 §6（auth）：账号全流程、验证码边界、refresh 轮换、撤销规则矩阵、注销。
// 运行：RATE_LIMIT_DISABLED=1（本文件不测限频；限频见 audit-auth-ratelimit）。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebSocket } from 'ws';
import { PrismaService } from '../src/prisma/prisma.service';
import { SMS_PROVIDER, type SmsMessage } from '../src/providers/sms.provider';
import { lastCodeFor } from './helpers/register';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  listenRandomPort,
  provisionDevice,
  randomPhone,
  sleep,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  backdateLatestCode,
  evidence,
  hist,
  issueCode,
  maskPhoneForLog,
  sendCode,
  waitCloseOrNull,
  waitOpen,
} from './helpers/audit-auth';

jest.setTimeout(180_000);

const LOG = 'account.log';
const run = Date.now().toString(36);

describe('审计 §6：账号全流程 / 验证码 / refresh / 撤销规则 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let sendMock: jest.Mock<Promise<void>, [string, SmsMessage]>;
  const users: TestUser[] = [];
  const extraUsers: Array<{ id: string; phone: string }> = [];
  const phones: string[] = [];
  const deviceIds: string[] = [];
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    // SMS provider 用 jest.fn 替换：可注入一次性发送失败，且 lastCodeFor 直接可用
    sendMock = jest.fn<Promise<void>, [string, SmsMessage]>(() =>
      Promise.resolve(),
    );
    ({ app, http, prisma } = await buildApp((b) =>
      b.overrideProvider(SMS_PROVIDER).useValue({ send: sendMock }),
    ));
    evidence(LOG, `=== run ${run} 开始 ===`);
  });

  afterAll(async () => {
    sockets.forEach((ws) => ws.close());
    await cleanupDevices(prisma, deviceIds);
    await cleanupUsers(prisma, [...users, ...extraUsers]);
    await prisma.smsCode
      .deleteMany({ where: { phone: { in: phones } } })
      .catch(() => undefined);
    await app.close();
  });

  const newUser = async (password?: string): Promise<TestUser> => {
    const u = await createUser(app, http, password);
    users.push(u);
    phones.push(u.phone);
    return u;
  };

  describe('验证码', () => {
    it('过期（TTL=1s）：过期后注册 400 SMS_CODE_INVALID', async () => {
      const phone = randomPhone();
      phones.push(phone);
      process.env.SMS_CODE_TTL_SECONDS = '1';
      try {
        const code = await issueCode(app, http, phone, 'register');
        await sleep(1200);
        const res = await request(http)
          .post('/api/v1/auth/register')
          .send({ phone, code, password: 'audit_pw_12345' })
          .expect(400);
        expect(res.body.code).toBe('SMS_CODE_INVALID');
        evidence(
          LOG,
          `验证码过期：TTL=1s 后注册 → ${res.status} ${res.body.code}`,
        );
      } finally {
        delete process.env.SMS_CODE_TTL_SECONDS;
      }
    });

    it('日限（临时=2）：第 3 条 429 SMS_CODE_DAILY_LIMIT；60s 内重发 429 SMS_CODE_TOO_FREQUENT', async () => {
      const phone = randomPhone();
      phones.push(phone);
      process.env.SMS_CODE_DAILY_LIMIT = '2';
      try {
        await sendCode(http, phone, 'register').expect(204);
        const tooFrequent = await sendCode(http, phone, 'register').expect(429);
        expect(tooFrequent.body.code).toBe('SMS_CODE_TOO_FREQUENT');
        await backdateLatestCode(prisma, phone, 'register', 61);
        await sendCode(http, phone, 'register').expect(204);
        await backdateLatestCode(prisma, phone, 'register', 61);
        const daily = await sendCode(http, phone, 'register').expect(429);
        expect(daily.body.code).toBe('SMS_CODE_DAILY_LIMIT');
        // 日限按「号+用途」计：另一用途不受影响（reset_password 需已注册号，这里用 change_phone）
        await sendCode(http, phone, 'change_phone').expect(204);
        evidence(
          LOG,
          `日限=2：第 3 条 → 429 ${daily.body.code}；同号另一用途仍 204（日限按号+用途分桶）`,
        );
      } finally {
        delete process.env.SMS_CODE_DAILY_LIMIT;
      }
    });

    it('错码上限（MAX_ATTEMPTS=2）：错 2 次后正确码也 400；错码计数不跨用途', async () => {
      const phone = randomPhone();
      phones.push(phone);
      process.env.SMS_CODE_MAX_ATTEMPTS = '2';
      try {
        const code = await issueCode(app, http, phone, 'register');
        const wrong = code === '000000' ? '000001' : '000000';
        for (let i = 0; i < 2; i += 1) {
          await request(http)
            .post('/api/v1/auth/register')
            .send({ phone, code: wrong, password: 'audit_pw_12345' })
            .expect(400);
        }
        const res = await request(http)
          .post('/api/v1/auth/register')
          .send({ phone, code, password: 'audit_pw_12345' })
          .expect(400);
        expect(res.body.code).toBe('SMS_CODE_INVALID');
        const row = await prisma.smsCode.findFirst({
          where: { phone, purpose: 'register' },
          orderBy: { createdAt: 'desc' },
        });
        expect(row?.attempts).toBe(2);
        expect(row?.consumedAt).toBeNull();
      } finally {
        delete process.env.SMS_CODE_MAX_ATTEMPTS;
      }
    });

    it('用途隔离：register 码不能用于 reset_password / change_phone', async () => {
      const u = await newUser();
      // 已注册号：register 用途发码被 409 挡住，改用 change_phone 码（发往新号）试 register/reset
      const newPhone = randomPhone();
      phones.push(newPhone);
      const changeCode = await issueCode(app, http, newPhone, 'change_phone');
      const asRegister = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: newPhone, code: changeCode, password: 'audit_pw_12345' })
        .expect(400);
      expect(asRegister.body.code).toBe('SMS_CODE_INVALID');
      // reset_password 码不能用于 change-phone
      const resetCode = await issueCode(app, http, u.phone, 'reset_password');
      const asChange = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(u.token))
        .send({ newPhone, code: resetCode })
        .expect(400);
      expect(asChange.body.code).toBe('SMS_CODE_INVALID');
      // 用途码本身仍可用（未被上面误消费）
      await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(u.token))
        .send({ newPhone, code: changeCode })
        .expect(200);
      u.phone = newPhone;
    });

    it('并发消费同一验证码（reset-password ×6）：恰好 1 个 204，其余 400，无 5xx', async () => {
      const u = await newUser();
      const code = await issueCode(app, http, u.phone, 'reset_password');
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          request(http)
            .post('/api/v1/auth/reset-password')
            .send({ phone: u.phone, code, newPassword: `audit_new_pw_${i}` }),
        ),
      );
      const statuses = results.map((r) => r.status);
      evidence(LOG, `并发消费同一码 ×6 → ${hist(statuses)}`);
      expect(statuses.filter((s) => s === 204)).toHaveLength(1);
      expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
      // 赢家的新密码可登录，旧密码不可
      const winner = results.findIndex((r) => r.status === 204);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: `audit_new_pw_${winner}` })
        .expect(200);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(401);
      u.password = `audit_new_pw_${winner}`;
    });

    it('并发发送同一号 ×6：恰好 1 个 204，其余 429 SMS_CODE_TOO_FREQUENT；库中 1 条、Provider 只发 1 次【AUTH-04 修复验证】', async () => {
      const phone = randomPhone();
      phones.push(phone);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => sendCode(http, phone, 'register')),
      );
      const statuses = results.map((r) => r.status);
      const rows = await prisma.smsCode.count({
        where: { phone, purpose: 'register' },
      });
      const sent = sendMock.mock.calls.filter(([to]) => to === phone).length;
      evidence(
        LOG,
        `并发发码同号 ×6 → ${hist(statuses)}；库中记录 ${rows} 条；Provider 实际发送 ${sent} 次`,
      );
      expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
      expect(statuses.filter((s) => s === 204)).toHaveLength(1);
      // 事务内咨询锁串行化「查最新 → 建记录」：并发只放行 1 条，其余按 60s 间隔拒绝
      const rejected = results.filter((r) => r.status === 429);
      expect(rejected).toHaveLength(5);
      expect(
        rejected.every((r) => r.body.code === 'SMS_CODE_TOO_FREQUENT'),
      ).toBe(true);
      expect(rows).toBe(1);
      expect(sent).toBe(1);
    });

    it('发送失败：Provider 抛错 → 503 SMS_SEND_FAILED，记录回滚，立即重发 204（不被 60s 限频）', async () => {
      const phone = randomPhone();
      phones.push(phone);
      sendMock.mockRejectedValueOnce(new Error('audit: provider down'));
      const failed = await sendCode(http, phone, 'register').expect(503);
      expect(failed.body.code).toBe('SMS_SEND_FAILED');
      expect(
        await prisma.smsCode.count({ where: { phone, purpose: 'register' } }),
      ).toBe(0);
      await sendCode(http, phone, 'register').expect(204);
      expect(lastCodeFor(app, phone)).toMatch(/^\d{6}$/);
      evidence(
        LOG,
        `Provider 抛错 → 503 ${failed.body.code}；记录数 0；立即重发 → 204`,
      );
    });

    it('号码枚举（BY_DESIGN，API.md §2）：register 用途已注册 409 / 未注册 204；reset 用途未注册 404 / 已注册 204', async () => {
      const u = await newUser();
      const fresh = randomPhone();
      phones.push(fresh);
      const r1 = await sendCode(http, u.phone, 'register').expect(409);
      const r2 = await sendCode(http, fresh, 'register').expect(204);
      const r3 = await sendCode(http, randomPhone(), 'reset_password').expect(
        404,
      );
      evidence(
        LOG,
        `号码枚举：register 已注册→${r1.status} ${r1.body.code}；未注册→${r2.status}；reset 未注册→${r3.status} ${r3.body.code}（文档明示，隐私风险记录）`,
      );
    });
  });

  describe('密码 72 字节边界（bcrypt）', () => {
    const cjk72 = '汉'.repeat(72); // 216 字节
    const cjk24 = '汉'.repeat(24); // 72 字节

    it('注册 / 找回密码：72 个汉字 → 400（@MaxBytes 生效）', async () => {
      const phone = randomPhone();
      phones.push(phone);
      const code = await issueCode(app, http, phone, 'register');
      await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: cjk72 })
        .expect(400);
      const u = await newUser();
      const resetCode = await issueCode(app, http, u.phone, 'reset_password');
      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ phone: u.phone, code: resetCode, newPassword: cjk72 })
        .expect(400);
    });

    it('登录：API.md §2 登录密码「≤72 字节，超出 400」——72 汉字应 400；72 字节密码 + 1 字节应不匹配', async () => {
      const u = await newUser();
      const r = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: cjk72 });
      evidence(LOG, `login 密码=72 汉字（216 字节）→ ${r.status}（契约 400）`);
      expect(r.status).not.toBeGreaterThanOrEqual(500);
      const phone = randomPhone();
      phones.push(phone);
      const code = await issueCode(app, http, phone, 'register');
      const reg = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: cjk24 })
        .expect(201);
      extraUsers.push({ id: reg.body.user.id as string, phone });
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password: cjk24 })
        .expect(200);
      const prefix = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password: `${cjk24}x` });
      evidence(
        LOG,
        `login 密码=已注册 72 字节密码 + 'x'（73 字节）→ ${prefix.status}（200 = bcrypt 按 72 字节前缀比较；契约要求超 72 字节 400）`,
      );
      expect(prefix.status).toBe(400);
      expect(r.status).toBe(400);
    });

    it('修改密码：newPassword 72 个汉字（216 字节）应与注册同规则被 400（缺 @MaxBytes 则被静默截断）', async () => {
      const u = await newUser();
      const res = await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(u.token))
        .send({ oldPassword: u.password, newPassword: cjk72 });
      evidence(LOG, `change-password newPassword=72 汉字 → ${res.status}`);
      if (res.status === 204) {
        // 截断证据：前 24 个汉字（72 字节）+ 任意尾巴也能登录
        const truncated = await request(http)
          .post('/api/v1/auth/login')
          .send({ phone: u.phone, password: `${cjk24}${'x'.repeat(40)}` });
        evidence(
          LOG,
          `  → 改密被接受；用「前 24 汉字 + 40 个 x」登录 → ${truncated.status}（200 = bcrypt 静默截断已发生）`,
        );
        u.password = cjk72;
      }
      // API.md §2：newPassword 与注册同规则；注册规则为 8–72 字符且 ≤72 字节
      expect(res.status).toBe(400);
    });
  });

  describe('refresh 轮换', () => {
    it('过期 refresh（SQL 置 expiresAt 过去）→ 401，且不触发全会话撤销', async () => {
      const u = await newUser();
      const login2 = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(200);
      // 只把第一枚（注册那枚）设为过期
      const first = await prisma.refreshToken.findFirst({
        where: { userId: u.id },
        orderBy: { createdAt: 'asc' },
      });
      await prisma.refreshToken.update({
        where: { id: first!.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const r = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      expect(r.body.code).toBe('UNAUTHORIZED');
      // 另一会话不受影响
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: login2.body.refreshToken })
        .expect(200);
    });

    it('同一 refresh 并发 ×8：恰好 1 个 200（旧报告 #12 复验），其余 401，无 5xx；输家不触发全局撤销', async () => {
      const u = await newUser();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(http)
            .post('/api/v1/auth/refresh')
            .send({ refreshToken: u.refreshToken }),
        ),
      );
      const statuses = results.map((r) => r.status);
      evidence(LOG, `同一 refresh 并发 ×8 → ${hist(statuses)}`);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
      const winner = results.find((r) => r.status === 200)!;
      // 赢家的新 token 仍可继续轮换（没被输家的“复用”误判为盗用）
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: winner.body.refreshToken })
        .expect(200);
    });

    it('窗口内复用：补发一次、没送到的那张作废；超过补发窗口（SQL 把 revokedAt 拨早 20 分钟）复用 → 撤销全部会话', async () => {
      const u = await newUser();
      const r1 = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(200);
      // 半秒并发窗口之后复用旧 token：当作应答丢失补发一对，r1 那张作废
      await new Promise((r) => setTimeout(r, 700));
      const reissued = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(200);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: r1.body.refreshToken })
        .expect(401);
      const r2 = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: reissued.body.refreshToken })
        .expect(200);
      // 把已轮换的那些 revokedAt 拨早 20 分钟（出了 15 min 补发窗口），再复用 → 视为盗用
      await prisma.refreshToken.updateMany({
        where: { userId: u.id, revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 20 * 60_000) },
      });
      const reuse = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: reissued.body.refreshToken })
        .expect(401);
      const latest = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: r2.body.refreshToken })
        .expect(401);
      evidence(
        LOG,
        `宽限外复用 → ${reuse.status}；最新 token 随之失效 → ${latest.status}（全会话撤销）`,
      );
      expect(
        await prisma.refreshToken.count({
          where: { userId: u.id, revokedAt: null },
        }),
      ).toBe(0);
    });
  });

  describe('撤销规则矩阵（API.md §2）', () => {
    it('修改密码：其他会话撤销、本设备 keepRefreshToken 保留；别人的 token 传进来不会被保留', async () => {
      const a = await newUser();
      const b = await newUser();
      const aOther = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: a.phone, password: a.password })
        .expect(200);
      // 传 B 的 token 作为 keep：A 的全部会话撤销，B 的 token 不受影响
      await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(a.token))
        .send({
          oldPassword: a.password,
          newPassword: 'audit_pw_changed1',
          refreshToken: b.refreshToken,
        })
        .expect(204);
      a.password = 'audit_pw_changed1';
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: a.refreshToken })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: aOther.body.refreshToken })
        .expect(401);
      const bRefresh = await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: b.refreshToken })
        .expect(200);
      b.refreshToken = bRefresh.body.refreshToken;
      // 改密后 A 的旧 access 仍在 15 分钟窗口内有效（设计允许，记录）
      const stillValid = await request(http)
        .get('/api/v1/users/me')
        .set(auth(a.token));
      evidence(
        LOG,
        `改密后旧 access 访问 /users/me → ${stillValid.status}（API.md §2 未要求 access 立即失效，BY_DESIGN）`,
      );

      // 正常路径：带本人 refresh → 本设备保留，其他撤销
      const s1 = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: a.phone, password: a.password })
        .expect(200);
      const s2 = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: a.phone, password: a.password })
        .expect(200);
      await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(s1.body.accessToken))
        .send({
          oldPassword: a.password,
          newPassword: 'audit_pw_changed2',
          refreshToken: s1.body.refreshToken,
        })
        .expect(204);
      a.password = 'audit_pw_changed2';
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: s2.body.refreshToken })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: s1.body.refreshToken })
        .expect(200);
    });

    it('找回密码：全部 refresh 撤销；旧 access 15 分钟内仍有效（BY_DESIGN，旧报告 #13）', async () => {
      const u = await newUser();
      const s2 = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(200);
      const code = await issueCode(app, http, u.phone, 'reset_password');
      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ phone: u.phone, code, newPassword: 'audit_pw_reset_1' })
        .expect(204);
      u.password = 'audit_pw_reset_1';
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: s2.body.refreshToken })
        .expect(401);
      const me = await request(http).get('/api/v1/users/me').set(auth(u.token));
      evidence(
        LOG,
        `找回密码后旧 access → ${me.status}（BY_DESIGN：access 无状态 15 分钟窗口）`,
      );
      expect(me.status).toBe(200);
    });

    it('换手机号：会话不受影响；原号即刻可被他人注册；并发换号+注册同号不得 5xx（注入模拟竞态）', async () => {
      const u = await newUser();
      const oldPhone = u.phone;
      const newPhone = randomPhone();
      phones.push(newPhone);
      const code = await issueCode(app, http, newPhone, 'change_phone');
      const res = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(u.token))
        .send({ newPhone, code })
        .expect(200);
      expect(res.body.phone).toBe(newPhone);
      u.phone = newPhone;
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(200);
      // 原号可被他人注册（createUser 60s 内已给原号发过 register 码，先回拨绕过重发间隔）
      await backdateLatestCode(prisma, oldPhone, 'register', 61);
      const regCode = await issueCode(app, http, oldPhone, 'register');
      const reg = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: oldPhone, code: regCode, password: 'audit_pw_12345' })
        .expect(201);
      extraUsers.push({ id: reg.body.user.id as string, phone: oldPhone });

      // 竞态注入：change-phone 与 register 同一新号——两者各自持独立用途的验证码，都能通过前置查重，
      // 后写者撞 users.phone 唯一约束。用 spyOn 让 user.update 前先由"另一个注册"占号，模拟窗口。
      const racePhone = randomPhone();
      phones.push(racePhone);
      const changeCode = await issueCode(app, http, racePhone, 'change_phone');
      const originalUpdate = prisma.user.update.bind(prisma.user);
      const spy = jest
        .spyOn(prisma.user, 'update')
        .mockImplementationOnce((async (args: unknown) => {
          const created = await prisma.user.create({
            data: { phone: racePhone, passwordHash: 'x' },
            select: { id: true },
          });
          extraUsers.push({ id: created.id, phone: racePhone });
          return originalUpdate(args as never);
        }) as never);
      const raced = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(u.token))
        .send({ newPhone: racePhone, code: changeCode });
      spy.mockRestore();
      evidence(
        LOG,
        `换号 vs 注册同号竞态（注入）→ ${raced.status} ${raced.body.code ?? ''}（期望 409，不得 500）`,
      );
      expect(raced.status).toBe(409);
    });

    it('注销：全部撤销 + 残留 access 全接口 401 + 新 WS 4401；已建立的 WS 是否被踢（观察）', async () => {
      const u = await newUser();
      const deviceId = `audit_acct_${run}`;
      deviceIds.push(deviceId);
      await provisionDevice(prisma, deviceId);
      await bindDevice(http, u.token, deviceId);
      const wsBase = await listenRandomPort(app);
      const established = new WebSocket(`${wsBase}/ws?token=${u.token}`);
      sockets.push(established);
      await waitOpen(established);

      await request(http)
        .delete('/api/v1/users/me')
        .set(auth(u.token))
        .send({ password: u.password })
        .expect(204);

      const kicked = await waitCloseOrNull(established, 1500);
      evidence(
        LOG,
        `注销后已建立 WS 在 1.5s 内关闭码 → ${kicked ?? '未关闭（连接存活至 access exp）'}`,
      );

      const fresh = new WebSocket(`${wsBase}/ws?token=${u.token}`);
      sockets.push(fresh);
      const freshClose = await waitCloseOrNull(fresh, 3000);
      expect(freshClose).toBe(4401);

      const probes: Array<[string, request.Test]> = [
        ['GET /users/me', request(http).get('/api/v1/users/me')],
        ['GET /devices', request(http).get('/api/v1/devices')],
        [
          `GET /devices/${deviceId}`,
          request(http).get(`/api/v1/devices/${deviceId}`),
        ],
        [
          'POST /devices/bind',
          request(http)
            .post('/api/v1/devices/bind')
            .send({ deviceId, bindCode: `bc_${deviceId}` }),
        ],
        [
          'GET /users/me/emergency-contacts',
          request(http).get('/api/v1/users/me/emergency-contacts'),
        ],
        ['GET /voice/channels', request(http).get('/api/v1/voice/channels')],
        [
          'POST /ingest/app-relay',
          request(http)
            .post('/api/v1/ingest/app-relay')
            .send({ deviceId, envelopes: [{}] }),
        ],
        [
          'POST /auth/change-password',
          request(http).post('/api/v1/auth/change-password').send({
            oldPassword: u.password,
            newPassword: 'audit_pw_after_del',
          }),
        ],
        [
          'DELETE /users/me (二次注销)',
          request(http)
            .delete('/api/v1/users/me')
            .send({ password: u.password }),
        ],
      ];
      for (const [name, req] of probes) {
        const r = await req.set(auth(u.token));
        evidence(LOG, `注销后残留 access ${name} → ${r.status}`);
        expect(r.status).toBe(401);
      }
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(401);

      // 号码释放：同号再注册 = 全新账号，且可绑回该设备（先回拨 60s 前那枚 register 码）
      await backdateLatestCode(prisma, u.phone, 'register', 61);
      const code = await issueCode(app, http, u.phone, 'register');
      const reg = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: u.phone, code, password: 'audit_pw_12345' })
        .expect(201);
      expect(reg.body.user.id).not.toBe(u.id);
      extraUsers.push({ id: reg.body.user.id as string, phone: u.phone });
      await bindDevice(http, reg.body.accessToken as string, deviceId);
      const deleted = await prisma.user.findUnique({ where: { id: u.id } });
      expect(deleted?.deletedAt).not.toBeNull();
      expect(deleted?.phone).toBe(`deleted:${u.id}`);
      evidence(
        LOG,
        `注销后同号 ${maskPhoneForLog(u.phone)} 再注册 → 201 新账号，可再绑设备`,
      );
    });
  });
});
