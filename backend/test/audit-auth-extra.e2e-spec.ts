// 2026-09-13 全面审计 §6（auth）补充：emoji/汉字密码 72 字节边界、注册竞态注入、WS 按 exp 断开（旧报告 #13 复验）、
// 改密/找回后已建立 WS 的存活观察（契约允许的 15 分钟窗口）、验证码一次性、短信 Provider 挂起无应用层超时。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WebSocket } from 'ws';
import { PrismaService } from '../src/prisma/prisma.service';
import { SMS_PROVIDER, type SmsMessage } from '../src/providers/sms.provider';
import {
  auth,
  buildApp,
  cleanupUsers,
  createUser,
  listenRandomPort,
  randomPhone,
  sleep,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  evidence,
  issueCode,
  signUserJwt,
  waitClose,
  waitCloseOrNull,
  waitOpen,
} from './helpers/audit-auth';

jest.setTimeout(180_000);

const LOG = 'extra.log';
const run = Date.now().toString(36);

describe('审计 §6：补充（密码字节边界 / 注册竞态 / WS 撤销 / Provider 挂起） (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let sendMock: jest.Mock<Promise<void>, [string, SmsMessage]>;
  const users: Array<{ id: string; phone: string }> = [];
  const phones: string[] = [];
  const sockets: WebSocket[] = [];

  const newUser = async (): Promise<TestUser> => {
    const u = await createUser(app, http);
    users.push(u);
    phones.push(u.phone);
    return u;
  };

  beforeAll(async () => {
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
    await cleanupUsers(prisma, users);
    await prisma.smsCode
      .deleteMany({ where: { phone: { in: phones } } })
      .catch(() => undefined);
    await app.close();
  });

  describe('密码 72 字节边界（emoji 4 字节 / 汉字 3 字节）', () => {
    const emoji18 = '😀'.repeat(18); // 72 字节，18 字符
    const emoji19 = '😀'.repeat(19); // 76 字节
    const mixed = `${'汉'.repeat(20)}${'😀'.repeat(3)}`; // 60 + 12 = 72 字节

    it('注册：18 emoji（72 字节）201 且可登录；19 emoji（76 字节）400；汉字+emoji 恰 72 字节 201', async () => {
      const p1 = randomPhone();
      phones.push(p1);
      const c1 = await issueCode(app, http, p1, 'register');
      const r1 = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: p1, code: c1, password: emoji18 })
        .expect(201);
      users.push({ id: r1.body.user.id as string, phone: p1 });
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: p1, password: emoji18 })
        .expect(200);
      const p2 = randomPhone();
      phones.push(p2);
      const c2 = await issueCode(app, http, p2, 'register');
      const r2 = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: p2, code: c2, password: emoji19 });
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe('VALIDATION_FAILED');
      const c2b = await issueCode(app, http, p2, 'register').catch(() => null);
      // 上一条 400 未消费验证码，同一码仍可用（注册失败不扣验证码）
      const r3 = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: p2, code: c2b ?? c2, password: mixed })
        .expect(201);
      users.push({ id: r3.body.user.id as string, phone: p2 });
      // 登录侧观察（缺陷 AUTH-01 的补充证据，不重复断言）：19 emoji 登录 18 emoji 账号
      const prefix = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: p1, password: emoji19 });
      evidence(
        LOG,
        `emoji 密码：18 个（72B）注册 201/登录 200；19 个（76B）注册 ${r2.status}；汉字20+emoji3（72B）注册 201；用 19 emoji 登录 18 emoji 账号 → ${prefix.status}（契约 400；200 = bcrypt 前缀截断）`,
      );
    });

    it('找回密码：19 emoji → 400（@MaxBytes 生效）；18 emoji → 204 后可登录', async () => {
      const u = await newUser();
      const code = await issueCode(app, http, u.phone, 'reset_password');
      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ phone: u.phone, code, newPassword: emoji19 })
        .expect(400);
      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ phone: u.phone, code, newPassword: emoji18 })
        .expect(204);
      await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: emoji18 })
        .expect(200);
      // 已消费的码再用 → 400（一次性）
      const reuse = await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ phone: u.phone, code, newPassword: 'audit_pw_after_1' })
        .expect(400);
      expect(reuse.body.code).toBe('SMS_CODE_INVALID');
      evidence(
        LOG,
        `找回密码：19 emoji 400；18 emoji 204；已消费码复用 → 400 ${reuse.body.code}`,
      );
    });
  });

  describe('账号竞态', () => {
    it('【AUTH-03 缺陷断言】注册 vs 换号同号竞态（注入 user.create 前占号）→ 应 409 PHONE_ALREADY_REGISTERED，不得 500', async () => {
      const phone = randomPhone();
      phones.push(phone);
      const code = await issueCode(app, http, phone, 'register');
      const originalCreate = prisma.user.create.bind(prisma.user);
      const spy = jest
        .spyOn(prisma.user, 'create')
        .mockImplementationOnce((async (args: unknown) => {
          const squatter = await originalCreate({
            data: { phone, passwordHash: 'x' },
            select: { id: true },
          });
          users.push({ id: squatter.id, phone });
          return originalCreate(args as never);
        }) as never);
      const raced = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: 'audit_pw_12345' });
      spy.mockRestore();
      evidence(
        LOG,
        `注册竞态（注入）→ ${raced.status} ${raced.body.code ?? ''}（期望 409）`,
      );
      expect(raced.status).toBe(409);
    });
  });

  describe('WS 与会话撤销', () => {
    it('WS 按 access exp 断开（旧报告 #13 复验）：exp=2s 的 token 连上后 ≤4s 内 4401', async () => {
      const u = await newUser();
      const wsBase = await listenRandomPort(app);
      const short = await signUserJwt(app, { sub: u.id }, '2s');
      const ws = new WebSocket(`${wsBase}/ws?token=${short}`);
      sockets.push(ws);
      await waitOpen(ws);
      const t0 = Date.now();
      const code = await waitClose(ws, 4000);
      evidence(LOG, `WS exp=2s → ${Date.now() - t0}ms 后关闭码 ${code}`);
      expect(code).toBe(4401);
      // 已过期 token 直接连 → 4401
      await sleep(50);
      const dead = new WebSocket(`${wsBase}/ws?token=${short}`);
      sockets.push(dead);
      expect(await waitClose(dead, 3000)).toBe(4401);
    });

    it('改密 / 找回密码后：已建立 WS 不被踢（契约允许 access 15 分钟窗口，BY_DESIGN 观察）', async () => {
      const u = await newUser();
      const wsBase = await listenRandomPort(app);
      const other = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: u.password })
        .expect(200);
      const wsOther = new WebSocket(
        `${wsBase}/ws?token=${other.body.accessToken}`,
      );
      sockets.push(wsOther);
      await waitOpen(wsOther);
      await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(u.token))
        .send({
          oldPassword: u.password,
          newPassword: 'audit_pw_changed9',
          refreshToken: u.refreshToken,
        })
        .expect(204);
      const afterChange = await waitCloseOrNull(wsOther, 1000);
      const code = await issueCode(app, http, u.phone, 'reset_password');
      await request(http)
        .post('/api/v1/auth/reset-password')
        .send({ phone: u.phone, code, newPassword: 'audit_pw_reset9' })
        .expect(204);
      const afterReset = await waitCloseOrNull(wsOther, 1000);
      evidence(
        LOG,
        `改密后其他会话 WS 1s 内关闭码 → ${afterChange ?? '未关闭'}；找回密码后 → ${afterReset ?? '未关闭'}（API.md §2 只要求 refresh 撤销；access/WS 存活至 exp）`,
      );
      expect(wsOther.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('短信 Provider 异常', () => {
    it('Provider 挂起：sms-code 请求随之挂起（应用层无超时，仅靠 SDK 默认 60s）；期间同号重发被 60s 限频', async () => {
      const phone = randomPhone();
      phones.push(phone);
      let release: () => void = () => undefined;
      const hang = new Promise<void>((resolve) => {
        release = resolve;
      });
      sendMock.mockImplementationOnce(() => hang);
      const t0 = Date.now();
      const hung = await request(http)
        .post('/api/v1/auth/sms-code')
        .send({ phone, purpose: 'register' })
        .timeout({ response: 1500, deadline: 2000 })
        .then(
          (r) => `status ${r.status}`,
          (e: Error & { timeout?: number }) =>
            e.timeout ? 'client timeout' : `error ${e.message}`,
        );
      const elapsed = Date.now() - t0;
      // 记录已建（发送前先落库）→ 同号立即重发 429 SMS_CODE_TOO_FREQUENT
      const retry = await request(http)
        .post('/api/v1/auth/sms-code')
        .send({ phone, purpose: 'register' });
      release();
      await sleep(50);
      evidence(
        LOG,
        `Provider 挂起：客户端 1.5s 超时前后端未响应（${hung}，${elapsed}ms）；挂起期间同号重发 → ${retry.status} ${retry.body.code ?? ''}`,
      );
      expect(hung).toBe('client timeout');
      expect(retry.status).toBe(429);
    });
  });
});
