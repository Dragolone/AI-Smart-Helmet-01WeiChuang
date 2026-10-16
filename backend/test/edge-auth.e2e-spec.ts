// 2026-10-16 边界测试：认证（发码 / 注册 / 登录 / 刷新 / 登出 / 改密 / 换号 / 找回）。
// 只补现有 auth / hardening-auth / audit-auth-* 没覆盖到的输入形状与组合；断言 API.md §2 写明的行为，
// 文档没写的按代码现状断言并注明「文档未写，按现状」。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { lastCodeFor, registerUser, spyOnSms } from './helpers/register';
import {
  auth,
  buildApp,
  cleanupUsers,
  createUser,
  histogram,
  randomPhone,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

/** 号码的若干「看着像但不是」的写法：API.md §3「phone 校验与注册同口径（大陆手机号）」，服务端不做归一化 */
const phoneVariants = (phone: string): string[] => [
  `+86${phone}`,
  `86${phone}`,
  `0${phone}`,
  ` ${phone}`,
  `${phone} `,
  `${phone.slice(0, 3)} ${phone.slice(3, 7)} ${phone.slice(7)}`,
  `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`,
  // 全角数字
  phone.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))),
  // 零宽空格夹在中间
  `${phone.slice(0, 5)}\u200b${phone.slice(5)}`,
];

describe('边界：认证 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const extraPhones: string[] = [];

  const sendCode = (phone: string, purpose: unknown = 'register') =>
    request(http).post('/api/v1/auth/sms-code').send({ phone, purpose });

  /** 临时改 env（服务每次调用时读取），用完复原 */
  const withEnv = async (
    vars: Record<string, string>,
    fn: () => Promise<void>,
  ): Promise<void> => {
    const saved = Object.fromEntries(
      Object.keys(vars).map((k) => [k, process.env[k]]),
    );
    Object.assign(process.env, vars);
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const newUser = async (password?: string): Promise<TestUser> => {
    const u = await createUser(app, http, password);
    users.push(u);
    return u;
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    spyOnSms(app);
  });

  afterAll(async () => {
    await cleanupUsers(prisma, users);
    await prisma.smsCode
      .deleteMany({ where: { phone: { in: extraPhones } } })
      .catch(() => undefined);
    const leftovers = await prisma.user.findMany({
      where: { phone: { in: extraPhones } },
      select: { id: true, phone: true },
    });
    await cleanupUsers(prisma, leftovers);
    await app.close();
  });

  describe('发码 sms-code 入参', () => {
    it('purpose 大小写 / 前后空格 / 数组 / 数字 / 缺失 → 400（枚举严格匹配）', async () => {
      const phone = randomPhone();
      for (const purpose of [
        'REGISTER',
        'Register',
        ' register',
        'register ',
        ['register'],
        1,
        null,
        '',
      ]) {
        const r = await sendCode(phone, purpose);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      const missing = await request(http)
        .post('/api/v1/auth/sms-code')
        .send({ phone });
      expect(missing.status).toBe(400);
      // 一条都没发出去
      expect(await prisma.smsCode.count({ where: { phone } })).toBe(0);
    });

    it('手机号写法变体（+86 / 86 / 0 前缀、首尾空格、空格或横线分组、全角、零宽字符）一律 400，不做归一化', async () => {
      for (const phone of phoneVariants(randomPhone())) {
        const r = await sendCode(phone);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('号段边界：10–12 开头 400；13–19 开头放行（PHONE_PATTERN ^1[3-9]\\d{9}$）', async () => {
      const tail = '12345678';
      for (const prefix of ['100', '110', '120', '200', '012']) {
        const r = await sendCode(`${prefix}${tail}`);
        expect(r.status).toBe(400);
      }
      for (const prefix of ['130', '199']) {
        const phone = `${prefix}${Math.floor(Math.random() * 1e8)
          .toString()
          .padStart(8, '0')}`;
        extraPhones.push(phone);
        const r = await sendCode(phone);
        // 极小概率撞到已注册号 → 409；两种都说明号段本身被接受
        expect([204, 409]).toContain(r.status);
      }
    });

    it('重发后旧码作废：只认该号该用途最新一条（文档未写，按现状）', async () => {
      const phone = randomPhone();
      extraPhones.push(phone);
      await withEnv({ SMS_CODE_RESEND_INTERVAL_SECONDS: '1' }, async () => {
        await sendCode(phone).expect(204);
        const first = lastCodeFor(app, phone);
        await new Promise((r) => setTimeout(r, 1100));
        await sendCode(phone).expect(204);
        const second = lastCodeFor(app, phone);
        if (first !== second) {
          const old = await request(http)
            .post('/api/v1/auth/register')
            .send({ phone, code: first, password: 'edge_pw_001' });
          expect(old.status).toBe(400);
          expect(old.body.code).toBe('SMS_CODE_INVALID');
        }
        await request(http)
          .post('/api/v1/auth/register')
          .send({ phone, code: second, password: 'edge_pw_001' })
          .expect(201);
      });
    });

    it('日限按号码合计不分用途：register + change_phone 各发一条后（日限临时=2），第三条任何用途都 429 SMS_CODE_DAILY_LIMIT', async () => {
      const phone = randomPhone();
      extraPhones.push(phone);
      await withEnv(
        { SMS_CODE_DAILY_LIMIT: '2', SMS_CODE_RESEND_INTERVAL_SECONDS: '1' },
        async () => {
          await sendCode(phone, 'register').expect(204);
          await sendCode(phone, 'change_phone').expect(204);
          await new Promise((r) => setTimeout(r, 1100));
          const third = await sendCode(phone, 'register');
          expect(third.status).toBe(429);
          expect(third.body.code).toBe('SMS_CODE_DAILY_LIMIT');
          const fourth = await sendCode(phone, 'change_phone');
          expect(fourth.status).toBe(429);
          expect(fourth.body.code).toBe('SMS_CODE_DAILY_LIMIT');
        },
      );
    });

    it('同号不同用途不互相占 60 秒间隔：register 刚发完，change_phone 立刻能发（间隔按「用途+号码」算）', async () => {
      const phone = randomPhone();
      extraPhones.push(phone);
      await sendCode(phone, 'register').expect(204);
      await sendCode(phone, 'change_phone').expect(204);
      const again = await sendCode(phone, 'register');
      expect(again.status).toBe(429);
      expect(again.body.code).toBe('SMS_CODE_TOO_FREQUENT');
    });
  });

  describe('注册 register 入参', () => {
    const freshCode = async (phone: string): Promise<string> => {
      extraPhones.push(phone);
      await sendCode(phone).expect(204);
      return lastCodeFor(app, phone);
    };

    it('code 形状：数字类型 / 5 位 / 7 位 / 带空格 / 全角 / 字母 → 400 VALIDATION_FAILED，且不消耗该码的尝试次数', async () => {
      const phone = randomPhone();
      const code = await freshCode(phone);
      for (const bad of [
        Number(code),
        code.slice(0, 5),
        `${code}0`,
        ` ${code}`,
        `${code} `,
        code.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))),
        'abcdef',
        null,
      ]) {
        const r = await request(http)
          .post('/api/v1/auth/register')
          .send({ phone, code: bad, password: 'edge_pw_001' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      // 形状错误被 DTO 挡在门外：真码依旧可用（错 5 次作废只数「形状对但不匹配」的尝试）
      const row = await prisma.smsCode.findFirstOrThrow({
        where: { phone },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.attempts).toBe(0);
      await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: 'edge_pw_001' })
        .expect(201);
    });

    it('用发给别的号码的验证码注册 → 400 SMS_CODE_INVALID', async () => {
      const p1 = randomPhone();
      const p2 = randomPhone();
      const c1 = await freshCode(p1);
      await freshCode(p2);
      const r = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: p2, code: c1, password: 'edge_pw_001' });
      // 极小概率两码相同；相同则会注册成功，这里只在不同时断言
      if (c1 !== lastCodeFor(app, p2)) {
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('SMS_CODE_INVALID');
      }
    });

    it('密码长度边界：7 字符 400；8 字符 201；72 个 ASCII 201；73 个 ASCII 400', async () => {
      const cases: Array<[string, number]> = [
        ['a'.repeat(7), 400],
        ['b'.repeat(8), 201],
        ['c'.repeat(72), 201],
        ['d'.repeat(73), 400],
      ];
      for (const [password, status] of cases) {
        const phone = randomPhone();
        const code = await freshCode(phone);
        const r = await request(http)
          .post('/api/v1/auth/register')
          .send({ phone, code, password });
        expect(r.status).toBe(status);
      }
    });

    it('8 个空格的密码可注册并可登录（只限长度不限字符，文档未写，按现状）', async () => {
      const phone = randomPhone();
      const code = await freshCode(phone);
      await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: ' '.repeat(8) })
        .expect(201);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password: ' '.repeat(8) })
        .expect(200);
      // 不做 trim：7 个空格就不是同一个密码
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone, password: ' '.repeat(7) })
        .expect(401);
    });

    it('密码非字符串（数字 / 数组 / 对象）→ 400', async () => {
      const phone = randomPhone();
      const code = await freshCode(phone);
      for (const password of [12345678, ['abcdefgh'], { a: 1 }, true]) {
        const r = await request(http)
          .post('/api/v1/auth/register')
          .send({ phone, code, password });
        expect(r.status).toBe(400);
      }
    });

    it('昵称：缺省为 null；30 个 emoji 201；31 个 400；RTL / 零宽字符去掉、只剩看不见的字符 → null；非字符串 400', async () => {
      const ok = async (nickname: unknown): Promise<request.Response> => {
        const phone = randomPhone();
        const code = await freshCode(phone);
        return request(http)
          .post('/api/v1/auth/register')
          .send({ phone, code, password: 'edge_pw_001', nickname });
      };
      const none = await ok(undefined);
      expect(none.status).toBe(201);
      expect(none.body.user.nickname).toBeNull();
      const emoji30 = await ok('😀'.repeat(30));
      expect(emoji30.status).toBe(201);
      expect(emoji30.body.user.nickname).toBe('😀'.repeat(30));
      expect((await ok('😀'.repeat(31))).status).toBe(400);
      // 入库前整理（common/display-name，与 App 显示同一规则；10-16 夜测 N6）
      const r = await ok('\u202e骑手\u200d\u200b');
      expect(r.status).toBe(201);
      expect(r.body.user.nickname).toBe('骑手');
      const blank = await ok('\u200b\n\u200c');
      expect(blank.status).toBe(201);
      expect(blank.body.user.nickname).toBeNull();
      expect((await ok(123)).status).toBe(400);
    });

    it('注册响应：user 只含 id / phone / nickname / avatarUrl / createdAt，不回传密码哈希', async () => {
      const phone = randomPhone();
      const code = await freshCode(phone);
      const r = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: 'edge_pw_001' })
        .expect(201);
      expect(Object.keys(r.body.user).sort()).toEqual(
        ['avatarUrl', 'createdAt', 'id', 'nickname', 'phone'].sort(),
      );
      expect(JSON.stringify(r.body)).not.toContain('passwordHash');
      expect(typeof r.body.accessToken).toBe('string');
      expect(typeof r.body.refreshToken).toBe('string');
    });
  });

  describe('登录 login', () => {
    it('手机号写法变体一律 400（校验先于查库，不会变成 401）', async () => {
      const u = await newUser();
      for (const phone of phoneVariants(u.phone)) {
        const r = await request(http)
          .post('/api/v1/auth/login')
          .send({ phone, password: u.password });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('空密码 400；非字符串密码 400；缺字段 400；未注册号与错密码同为 401', async () => {
      const u = await newUser();
      expect(
        (
          await request(http)
            .post('/api/v1/auth/login')
            .send({ phone: u.phone, password: '' })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(http)
            .post('/api/v1/auth/login')
            .send({ phone: u.phone, password: 12345678 })
        ).status,
      ).toBe(400);
      expect(
        (await request(http).post('/api/v1/auth/login').send({})).status,
      ).toBe(400);
      const unknown = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: randomPhone(), password: u.password });
      const wrong = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: `${u.password}x` });
      expect([unknown.status, wrong.status]).toEqual([401, 401]);
      expect(unknown.body.code).toBe('UNAUTHORIZED');
      // 不区分「号不存在」和「密码错」：两条 message 一样
      expect(unknown.body.message).toBe(wrong.body.message);
    });

    it('密码大小写敏感、首尾空格不被裁掉', async () => {
      const u = await newUser('Edge_Pw_Case1');
      for (const password of [
        'edge_pw_case1',
        'EDGE_PW_CASE1',
        ' Edge_Pw_Case1',
        'Edge_Pw_Case1 ',
      ]) {
        const r = await request(http)
          .post('/api/v1/auth/login')
          .send({ phone: u.phone, password });
        expect(r.status).toBe(401);
      }
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: 'Edge_Pw_Case1' })
        .expect(200);
    });

    it('同一账号并发登录 10 次：全部 200，各得一张不同的 refresh token，互不作废', async () => {
      const u = await newUser();
      const rs = await Promise.all(
        Array.from({ length: 10 }, () =>
          request(http)
            .post('/api/v1/auth/login')
            .send({ phone: u.phone, password: u.password }),
        ),
      );
      expect(histogram(rs.map((r) => r.status))).toEqual({ '200': 10 });
      const tokens = new Set(rs.map((r) => r.body.refreshToken as string));
      expect(tokens.size).toBe(10);
      // 随便挑两张都还能刷新（多端登录不互踢）
      for (const r of [rs[0], rs[9]]) {
        await request(http)
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: r.body.refreshToken })
          .expect(200);
      }
    });
  });

  describe('刷新 / 登出', () => {
    it('refreshToken 形状：缺失 / 空串 / 数字 / 数组 → 400；accessToken 冒充 / 2 万字符垃圾 / 首尾空格 → 401', async () => {
      const u = await newUser();
      for (const body of [
        {},
        { refreshToken: '' },
        { refreshToken: 123 },
        { refreshToken: [u.refreshToken] },
      ]) {
        const r = await request(http).post('/api/v1/auth/refresh').send(body);
        expect(r.status).toBe(400);
      }
      for (const refreshToken of [
        u.token,
        'x'.repeat(20_000),
        ` ${u.refreshToken}`,
        `${u.refreshToken} `,
      ]) {
        const r = await request(http)
          .post('/api/v1/auth/refresh')
          .send({ refreshToken });
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('UNAUTHORIZED');
      }
      // 上面这些失败尝试不触发全会话撤销：原 token 照常可刷
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(200);
    });

    it('登出缺 refreshToken → 400；登出别人的 refresh token 也会让它失效（持有即凭证，文档未写，按现状）', async () => {
      const u = await newUser();
      const v = await newUser();
      expect(
        (await request(http).post('/api/v1/auth/logout').send({})).status,
      ).toBe(400);
      await request(http)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: v.refreshToken })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: v.refreshToken })
        .expect(401);
      // 只作废那一张：u 的会话不受影响
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(200);
    });

    it('同一 token 登出并发 5 次：全部 204（幂等），之后刷新 401', async () => {
      const u = await newUser();
      const rs = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(http)
            .post('/api/v1/auth/logout')
            .send({ refreshToken: u.refreshToken }),
        ),
      );
      expect(histogram(rs.map((r) => r.status))).toEqual({ '204': 5 });
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
    });
  });

  describe('改密 / 换号 / 找回', () => {
    it('改密：新旧密码相同也 204（文档未写，按现状），且照样撤销其他会话', async () => {
      const u = await newUser();
      const second = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(200);
      await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(u.token))
        .send({
          oldPassword: u.password,
          newPassword: u.password,
          refreshToken: u.refreshToken,
        })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: second.body.refreshToken })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(200);
    });

    it('改密：refreshToken 传垃圾值 → 204，所有会话（含本设备）都撤销', async () => {
      const u = await newUser();
      await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(u.token))
        .send({
          oldPassword: u.password,
          newPassword: 'edge_new_pw_1',
          refreshToken: 'not-a-real-token',
        })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect(401);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: 'edge_new_pw_1' })
        .expect(200);
    });

    it('改密：缺 oldPassword / 空 oldPassword / newPassword 非字符串 → 400，密码不变', async () => {
      const u = await newUser();
      for (const body of [
        { newPassword: 'edge_new_pw_1' },
        { oldPassword: '', newPassword: 'edge_new_pw_1' },
        { oldPassword: u.password, newPassword: 12345678 },
        { oldPassword: u.password },
      ]) {
        const r = await request(http)
          .post('/api/v1/auth/change-password')
          .set(auth(u.token))
          .send(body);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(200);
    });

    it('改密并发 5 次（同一旧密码、同一新密码）：无 5xx；新密码可登录、旧密码失效', async () => {
      const u = await newUser();
      const rs = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(http)
            .post('/api/v1/auth/change-password')
            .set(auth(u.token))
            .send({ oldPassword: u.password, newPassword: 'edge_conc_pw_1' }),
        ),
      );
      expect(rs.every((r) => r.status < 500)).toBe(true);
      expect(rs.some((r) => r.status === 204)).toBe(true);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: 'edge_conc_pw_1' })
        .expect(200);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(401);
    });

    it('换号到自己当前号码：发码 409、提交也 409 PHONE_ALREADY_REGISTERED（密码对时）', async () => {
      const u = await newUser();
      const sc = await sendCode(u.phone, 'change_phone');
      expect(sc.status).toBe(409);
      expect(sc.body.code).toBe('PHONE_ALREADY_REGISTERED');
      const r = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(u.token))
        .send({ newPhone: u.phone, code: '123456', password: u.password });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PHONE_ALREADY_REGISTERED');
    });

    it('换号：newPhone 写法变体 400（校验先于密码检查）；密码错与号已占同时出现时先报 PASSWORD_INCORRECT', async () => {
      const u = await newUser();
      const v = await newUser();
      for (const newPhone of phoneVariants(randomPhone())) {
        const r = await request(http)
          .post('/api/v1/auth/change-phone')
          .set(auth(u.token))
          .send({ newPhone, code: '123456', password: 'wrong_pw_xx' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      const both = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(u.token))
        .send({ newPhone: v.phone, code: '123456', password: 'wrong_pw_xx' });
      expect(both.status).toBe(400);
      expect(both.body.code).toBe('PASSWORD_INCORRECT');
    });

    it('换号用 register 用途的码 → 400 SMS_CODE_INVALID；用 change_phone 的码成功后，原号的 register 码仍可给别人注册', async () => {
      const u = await newUser();
      const target = randomPhone();
      extraPhones.push(target);
      await sendCode(target, 'register').expect(204);
      const regCode = lastCodeFor(app, target);
      const wrongPurpose = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(u.token))
        .send({ newPhone: target, code: regCode, password: u.password });
      expect(wrongPurpose.status).toBe(400);
      expect(wrongPurpose.body.code).toBe('SMS_CODE_INVALID');
      await sendCode(target, 'change_phone').expect(204);
      const cpCode = lastCodeFor(app, target);
      const ok = await request(http)
        .post('/api/v1/auth/change-phone')
        .set(auth(u.token))
        .send({ newPhone: target, code: cpCode, password: u.password })
        .expect(200);
      expect(ok.body.phone).toBe(target);
      u.phone = target;
      // 刚才那张 register 码属于同一号码：号码已被占用，注册 409（号码检查先于验证码）
      const reg = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: target, code: regCode, password: 'edge_pw_001' });
      expect(reg.status).toBe(409);
      expect(reg.body.code).toBe('PHONE_ALREADY_REGISTERED');
    });

    it('找回密码：已注销账号的原号 → 发码 404 / 提交 404 PHONE_NOT_REGISTERED；原号重新注册后是全新账号', async () => {
      const u = await createUser(app, http);
      await request(http)
        .delete('/api/v1/users/me')
        .set(auth(u.token))
        .send({ password: u.password })
        .expect(204);
      const sc = await sendCode(u.phone, 'reset_password');
      expect(sc.status).toBe(404);
      expect(sc.body.code).toBe('PHONE_NOT_REGISTERED');
      const rp = await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ phone: u.phone, code: '123456', newPassword: 'edge_pw_002' });
      expect(rp.status).toBe(404);
      expect(rp.body.code).toBe('PHONE_NOT_REGISTERED');
      const again = await registerUser(app, http, {
        phone: u.phone,
        password: 'edge_pw_003',
      });
      expect(again.body.user.id).not.toBe(u.id);
      users.push({ ...u, id: again.body.user.id as string });
      await cleanupUsers(prisma, [{ id: u.id, phone: `deleted:${u.id}` }]);
    });

    it('找回密码：newPassword 7 字符 / 非字符串 → 400，且不消费验证码（之后正确提交仍成功）', async () => {
      const u = await newUser();
      await sendCode(u.phone, 'reset_password').expect(204);
      const code = lastCodeFor(app, u.phone);
      for (const newPassword of ['a'.repeat(7), 12345678]) {
        const r = await request(http)
          .post('/api/v1/auth/reset-password')
          .send({ phone: u.phone, code, newPassword });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ phone: u.phone, code, newPassword: 'edge_reset_pw_1' })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: 'edge_reset_pw_1' })
        .expect(200);
    });
  });
});
