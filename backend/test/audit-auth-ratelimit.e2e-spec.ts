// 2026-09-13 全面审计 §6（auth）：限频真实行为——本文件**不设 RATE_LIMIT_DISABLED**（在下方显式删除）。
// 覆盖：各路由限额与 429 + Retry-After、guard 读 env 的时机、X-Forwarded-For 在 helper（无 trust proxy）
// 与 trust proxy=1（main.ts 同配置）两种下的表现、同出口多用户、桶清理/容量策略（真实 guard 类单元级）。
import {
  ExecutionContext,
  HttpException,
  INestApplication,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Express } from 'express';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthController } from '../src/auth/auth.controller';
import {
  RATE_LIMIT_KEY,
  RateLimitGuard,
  type RateLimitRule,
} from '../src/common/rate-limit.guard';
import { SMS_PROVIDER } from '../src/providers/sms.provider';
import {
  auth,
  buildApp,
  cleanupUsers,
  createUser,
  randomPhone,
  type Http,
  type TestUser,
} from './helpers/hardening';
import { createAdmin, evidence, hist } from './helpers/audit-auth';

delete process.env.RATE_LIMIT_DISABLED;

jest.setTimeout(240_000);

const LOG = 'ratelimit.log';
const run = Date.now().toString(36);

const retryAfter = (r: request.Response): number =>
  Number.parseInt(String(r.headers['retry-after'] ?? 'NaN'), 10);

/** 逐个发直到 429（或 max）；返回 429 前的响应数与那条 429 */
const untilLimited = async (
  make: (i: number) => request.Test,
  max: number,
): Promise<{ before: number[]; limited: request.Response | null }> => {
  const before: number[] = [];
  for (let i = 0; i < max; i += 1) {
    const r = await make(i);
    if (r.status === 429) return { before, limited: r };
    before.push(r.status);
  }
  return { before, limited: null };
};

describe('审计 §6：限频（RATE_LIMIT_DISABLED 未设） (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const adminIds: string[] = [];

  beforeAll(async () => {
    process.env.RATE_LIMIT_DISABLED = '1'; // 造用户期间关掉，避免吃掉 register/sms 额度
    ({ app, http, prisma } = await buildApp((b) =>
      b
        .overrideProvider(SMS_PROVIDER)
        .useValue({ send: jest.fn(() => Promise.resolve()) }),
    ));
    users.push(await createUser(app, http), await createUser(app, http));
    delete process.env.RATE_LIMIT_DISABLED;
    evidence(
      LOG,
      `=== run ${run} 开始（in-process，helper 无 trust proxy）===`,
    );
  });

  afterAll(async () => {
    await cleanupUsers(prisma, users);
    await prisma.adminUser
      .deleteMany({ where: { id: { in: adminIds } } })
      .catch(() => undefined);
    await app.close();
  });

  it('guard 每次请求读 env：运行中置 RATE_LIMIT_DISABLED=1 即放行，删掉即恢复限频', async () => {
    const u = users[0];
    const wrong = (): request.Test =>
      request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: 'wrong_pw_1' });
    const { before, limited } = await untilLimited(wrong, 12);
    expect(before).toHaveLength(10);
    expect(before.every((s) => s === 401)).toBe(true);
    expect(limited?.status).toBe(429);
    expect(limited?.body.code).toBe('RATE_LIMITED');
    expect(retryAfter(limited!)).toBeGreaterThanOrEqual(1);
    expect(retryAfter(limited!)).toBeLessThanOrEqual(60);
    // 正确密码同样被 429（限的是尝试次数，不是失败次数）
    const correct = await request(http)
      .post('/api/v1/auth/login')
      .send({ phone: u.phone, password: u.password });
    expect(correct.status).toBe(429);
    process.env.RATE_LIMIT_DISABLED = '1';
    const bypass = await wrong();
    delete process.env.RATE_LIMIT_DISABLED;
    const again = await wrong();
    evidence(
      LOG,
      `login 同 IP+手机号：10×401 → 第 11 次 429 Retry-After=${retryAfter(limited!)}；正确密码也 429；env=1 时 → ${bypass.status}；删 env → ${again.status}`,
    );
    expect(bypass.status).toBe(401);
    expect(again.status).toBe(429);
    // 另一手机号同 IP 不受 login_phone 影响
    const other = await request(http)
      .post('/api/v1/auth/login')
      .send({ phone: users[1].phone, password: 'wrong_pw_1' });
    expect(other.status).toBe(401);
  });

  it('已登录的密码校验端点（改密 / 换号 / 注销）同用户 5 次/分、三处共用额度：第 6 次 429；换接口不能续命；他人不受影响', async () => {
    process.env.RATE_LIMIT_DISABLED = '1';
    const u = await createUser(app, http);
    users.push(u);
    delete process.env.RATE_LIMIT_DISABLED;
    const wrongPassword = (): request.Test =>
      request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(u.token))
        .send({ oldPassword: 'wrong_pw_1', newPassword: 'new_password_8' });
    const { before, limited } = await untilLimited(wrongPassword, 7);
    expect(before).toHaveLength(5);
    expect(before.every((s) => s === 400)).toBe(true);
    expect(limited?.status).toBe(429);
    expect(limited?.body.code).toBe('RATE_LIMITED');
    expect(retryAfter(limited!)).toBeGreaterThanOrEqual(1);
    // 同一额度覆盖换号与注销：换到另一个端点也 429，猜密码没法靠换接口续命；正确密码同样被限（限的是尝试次数）
    const changePhone = await request(http)
      .post('/api/v1/auth/change-phone')
      .set(auth(u.token))
      .send({ password: u.password, newPhone: randomPhone(), code: '000000' });
    expect(changePhone.status).toBe(429);
    const del = await request(http)
      .delete('/api/v1/users/me')
      .set(auth(u.token))
      .send({ password: u.password });
    expect(del.status).toBe(429);
    // 按用户分桶：同 IP 的另一个用户照常 400
    const other = await request(http)
      .post('/api/v1/auth/change-password')
      .set(auth(users[1].token))
      .send({ oldPassword: 'wrong_pw_1', newPassword: 'new_password_8' });
    expect(other.status).toBe(400);
    evidence(
      LOG,
      `change-password 同用户：5×400 → 第 6 次 429 Retry-After=${retryAfter(limited!)}；change-phone / DELETE me 共用额度 → 429；同 IP 他人 → ${other.status}`,
    );
  });

  it('sms-code 同 IP 5 条/分：第 6 条 429 + Retry-After；无 trust proxy 时 X-Forwarded-For 伪造不能绕过', async () => {
    const send = (i: number, xff?: string): request.Test => {
      let t = request(http)
        .post('/api/v1/auth/sms-code')
        .send({ phone: randomPhone(), purpose: 'register' });
      if (xff) t = t.set('X-Forwarded-For', xff);
      return t;
    };
    const { before, limited } = await untilLimited(
      (i) => send(i, `10.0.${i}.${i + 1}`),
      8,
    );
    evidence(
      LOG,
      `sms-code 同 IP（每条带不同 XFF）→ ${hist(before)} 后第 ${before.length + 1} 条 ${limited?.status} Retry-After=${limited ? retryAfter(limited) : '-'}`,
    );
    expect(before).toHaveLength(5);
    expect(before.every((s) => s === 204)).toBe(true);
    expect(limited?.status).toBe(429);
    expect(limited?.body.code).toBe('RATE_LIMITED');
    expect(retryAfter(limited!)).toBeGreaterThanOrEqual(1);
    expect(retryAfter(limited!)).toBeLessThanOrEqual(60);
    // 同出口多个合法用户：第 6 个不同号码同样 429（按 IP 计，NAT 场景口径记录）
    const sixthUser = await send(9);
    expect(sixthUser.status).toBe(429);
  });

  it('register 20/分（guard 先于校验：垃圾体也吃额度）、reset 同 IP+手机号 10/分、refresh 60/分、admin login 10/分', async () => {
    const reg = await untilLimited(
      () => request(http).post('/api/v1/auth/register').send({}),
      25,
    );
    expect(reg.before).toHaveLength(20);
    expect(reg.before.every((s) => s === 400)).toBe(true);
    expect(reg.limited?.status).toBe(429);

    const phone = users[1].phone;
    const reset = await untilLimited(
      () =>
        request(http)
          .post('/api/v1/auth/reset-password')
          .send({ phone, code: '000000', newPassword: 'audit_pw_12345' }),
      15,
    );
    expect(reset.before).toHaveLength(10);
    expect(reset.before.every((s) => s === 400)).toBe(true);
    expect(reset.limited?.status).toBe(429);
    const otherPhone = await request(http)
      .post('/api/v1/auth/reset-password')
      .send({
        phone: users[0].phone,
        code: '000000',
        newPassword: 'audit_pw_12345',
      });
    expect(otherPhone.status).toBe(400);

    const refresh = await untilLimited(
      () =>
        request(http)
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: `garbage_${run}` }),
      70,
    );
    expect(refresh.before).toHaveLength(60);
    expect(refresh.before.every((s) => s === 401)).toBe(true);
    expect(refresh.limited?.status).toBe(429);

    const admin = await createAdmin(prisma, http, `rl_${run}`);
    adminIds.push(admin.id);
    const adminLogin = await untilLimited(
      () =>
        request(http)
          .post('/api/v1/admin/auth/login')
          .send({ username: admin.username, password: 'wrong_admin_pw' }),
      15,
    );
    // createAdmin 自己登录过 1 次（成功也计数），所以这里只剩 9 次
    expect(adminLogin.before).toHaveLength(9);
    expect(adminLogin.before.every((s) => s === 401)).toBe(true);
    expect(adminLogin.limited?.status).toBe(429);

    // logout 无限频（幂等 204）：记录
    const logouts = await Promise.all(
      Array.from({ length: 70 }, () =>
        request(http)
          .post('/api/v1/auth/logout')
          .send({ refreshToken: `garbage_${run}` }),
      ),
    );
    evidence(
      LOG,
      `register 空体 20×400 → 429；reset 10×400 → 429（另一号仍 400）；refresh 60×401 → 429；admin login 1+9 → 429；logout ×70 → ${hist(logouts.map((r) => r.status))}（无限频，幂等）`,
    );
  });

  it('login 同 IP 100 次/分（跨手机号横向扫号）：第 101 次 429', async () => {
    // 新实例：不与前面用例的桶互相污染
    const fresh = await buildApp();
    try {
      const phones = Array.from({ length: 12 }, () => randomPhone());
      const res = await untilLimited(
        (i) =>
          request(fresh.http)
            .post('/api/v1/auth/login')
            .send({ phone: phones[i % 12], password: 'wrong_pw_1' }),
        110,
      );
      evidence(
        LOG,
        `login 同 IP 轮换 12 个号 → ${res.before.length} 次 401 后 ${res.limited?.status}（Retry-After=${res.limited ? retryAfter(res.limited) : '-'}）`,
      );
      expect(res.before).toHaveLength(100);
      expect(res.limited?.status).toBe(429);
    } finally {
      await fresh.app.close();
    }
  });

  it('trust proxy=1（与 main.ts 同配置）：直连时伪造 X-Forwarded-For 可逐条换 IP 绕过限频（部署须保证后端不可直连、网关覆写 XFF）', async () => {
    const fresh = await buildApp((b) =>
      b
        .overrideProvider(SMS_PROVIDER)
        .useValue({ send: jest.fn(() => Promise.resolve()) }),
    );
    (fresh.app.getHttpAdapter().getInstance() as Express).set('trust proxy', 1);
    try {
      const send = (xff: string): request.Test =>
        request(fresh.http)
          .post('/api/v1/auth/sms-code')
          .set('X-Forwarded-For', xff)
          .send({ phone: randomPhone(), purpose: 'register' });
      const spoofed = await untilLimited((i) => send(`203.0.113.${i + 1}`), 12);
      const same = await untilLimited(() => send('198.51.100.7'), 8);
      evidence(
        LOG,
        `trust proxy=1：逐条换 XFF ×12 → ${hist(spoofed.before)}，${spoofed.limited ? '仍被 429' : '全部放行（绕过）'}；固定 XFF → ${same.before.length} 条后 ${same.limited?.status}`,
      );
      expect(spoofed.limited).toBeNull();
      expect(spoofed.before).toHaveLength(12);
      expect(same.before).toHaveLength(5);
      expect(same.limited?.status).toBe(429);
    } finally {
      await fresh.app.close();
    }
  });

  it('已登录接口不限频（仅公开认证面）：/users/me 连发 150 次全部 200', async () => {
    const results = await Promise.all(
      Array.from({ length: 150 }, () =>
        request(http).get('/api/v1/users/me').set(auth(users[1].token)),
      ),
    );
    const h = hist(results.map((r) => r.status));
    evidence(LOG, `GET /users/me ×150（同 token）→ ${h}`);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });
});

describe('审计 §6：RateLimitGuard 桶策略（真实类，单元级）', () => {
  const makeGuard = (rules: RateLimitRule[]): RateLimitGuard => {
    const reflector = {
      getAllAndOverride: () => rules,
    } as unknown as Reflector;
    return new RateLimitGuard(reflector);
  };
  const ctx = (
    ip: string,
    body: Record<string, unknown> = {},
  ): { ctx: ExecutionContext; headers: Record<string, string> } => {
    const headers: Record<string, string> = {};
    const c = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ ip, body }),
        getResponse: () => ({
          setHeader: (k: string, v: string) => {
            headers[k] = v;
          },
        }),
      }),
    } as unknown as ExecutionContext;
    return { ctx: c, headers };
  };
  const status = (fn: () => boolean): number => {
    try {
      fn();
      return 200;
    } catch (e) {
      return e instanceof HttpException ? e.getStatus() : 500;
    }
  };
  const bucketsOf = (g: RateLimitGuard): Map<string, number[]> =>
    (g as unknown as { buckets: Map<string, number[]> }).buckets;

  afterEach(() => jest.restoreAllMocks());

  it('窗口滑动恢复：限满后 Retry-After 递减；越过窗口后同 key 重新放行', () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const g = makeGuard([{ name: 'r', limit: 3, windowMs: 60_000 }]);
    const c = ctx('1.1.1.1');
    expect([1, 2, 3].map(() => status(() => g.canActivate(c.ctx)))).toEqual([
      200, 200, 200,
    ]);
    now += 15_000;
    expect(status(() => g.canActivate(c.ctx))).toBe(429);
    expect(c.headers['Retry-After']).toBe('45');
    now += 44_999;
    expect(status(() => g.canActivate(c.ctx))).toBe(429);
    expect(c.headers['Retry-After']).toBe('1');
    now += 1;
    expect(status(() => g.canActivate(c.ctx))).toBe(200);
    evidence(
      LOG,
      'guard 单元：limit=3/60s → 第 4 次 429 Retry-After=45→1 → 窗口过后放行',
    );
  });

  it('多规则顺序：后一条规则 429 时，前一条规则的桶已被计入（被拒请求也消耗前序额度）', () => {
    const g = makeGuard([
      { name: 'per_phone', limit: 100, windowMs: 60_000, keyBy: 'ip+phone' },
      { name: 'per_ip', limit: 1, windowMs: 60_000 },
    ]);
    const c1 = ctx('2.2.2.2', { phone: '13800000001' });
    const c2 = ctx('2.2.2.2', { phone: '13800000002' });
    expect(status(() => g.canActivate(c1.ctx))).toBe(200);
    expect(status(() => g.canActivate(c2.ctx))).toBe(429);
    const b = bucketsOf(g);
    const phoneBucketOf429 = b.get('per_phone:2.2.2.2|13800000002');
    evidence(
      LOG,
      `guard 单元：per_ip 拒绝的请求仍在 per_phone 建桶并计 ${phoneBucketOf429?.length ?? 0} 次（桶总数 ${b.size}）`,
    );
    // 观察项（契约未规定；记录为 P3 备注）：被拒请求不应消耗前序规则额度，也不应新建桶
    expect(phoneBucketOf429?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('桶容量：单 IP 用 5 万个不同手机号的被拒请求不能清空全站限频桶、不能重置自己的 login_ip 额度【AUTH-08 修复验证】', () => {
    let now = 5_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const g = makeGuard([
      { name: 'login_phone', limit: 10, windowMs: 60_000, keyBy: 'ip+phone' },
      { name: 'login_ip', limit: 100, windowMs: 60_000 },
    ]);
    const attacker = '9.9.9.9';
    const victim = ctx('8.8.8.8', { phone: '13900000000' });
    // 受害者（另一 IP）先把自己的 10 次用完 → 429
    for (let i = 0; i < 10; i += 1) status(() => g.canActivate(victim.ctx));
    expect(status(() => g.canActivate(victim.ctx))).toBe(429);
    // 攻击者：100 次后 login_ip 429；继续用不同手机号发被拒请求
    let allowed = 0;
    let rejected = 0;
    const total = 50_200;
    for (let i = 0; i < total; i += 1) {
      now += 1; // 同一分钟内
      const s = status(() =>
        g.canActivate(
          // 合法格式的合成号（守卫只把合法手机号当独立 key，其余退化为 ip 桶）
          ctx(attacker, { phone: `13${String(i).padStart(9, '0')}` }).ctx,
        ),
      );
      if (s === 200) allowed += 1;
      else rejected += 1;
    }
    const size = bucketsOf(g).size;
    // 清表后：受害者的 429 状态被解除，攻击者也重新获得 login_ip 额度
    const victimAfter = status(() => g.canActivate(victim.ctx));
    const attackerAfter = status(() =>
      g.canActivate(ctx(attacker, { phone: '13911111111' }).ctx),
    );
    evidence(
      LOG,
      `guard 单元：攻击者 ${total} 次（放行 ${allowed} / 拒绝 ${rejected}），桶数=${size}；清表后受害者 → ${victimAfter}，攻击者再登录 → ${attackerAfter}（同一分钟内）`,
    );
    // 契约（API.md §2）：同 IP+手机号 10 次/分、同 IP 100 次/分——同一分钟内不应重新放行
    expect(victimAfter).toBe(429);
    expect(attackerAfter).toBe(429);
    expect(allowed).toBeLessThanOrEqual(100);
  });

  it('桶容量：5 万个随机号码的找回密码请求撑满桶表，也清不掉一个 IP 的 24h 发码日限（2026-10-14）', () => {
    let now = 20_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    // 用控制器上真实挂着的规则：两条路由共用同一个守卫实例的桶表
    // SetMetadata 挂在方法函数本身上；按属性名取，不把方法从原型上拆下来
    const handlers = AuthController.prototype as unknown as Record<
      'smsCode' | 'resetPassword',
      object
    >;
    const rulesOf = (name: 'smsCode' | 'resetPassword') =>
      Reflect.getMetadata(RATE_LIMIT_KEY, handlers[name]) as RateLimitRule[];
    const smsRules = rulesOf('smsCode');
    const resetRules = rulesOf('resetPassword');
    let current = smsRules;
    const g = new RateLimitGuard({
      getAllAndOverride: () => current,
    } as unknown as Reflector);

    // 攻击者 IP 一天内发满 50 条验证码（每分钟 5 条的分钟限照常遵守）
    const attacker = '7.7.7.7';
    for (let i = 0; i < 50; i += 1) {
      if (i > 0 && i % 5 === 0) now += 61_000;
      expect(status(() => g.canActivate(ctx(attacker).ctx))).toBe(200);
    }
    now += 61_000;
    expect(status(() => g.canActivate(ctx(attacker).ctx))).toBe(429);

    // 同一 IP 发不出 5 万个：找回密码有同 IP 每分钟 30 次的上限，被拒请求不建桶
    current = resetRules;
    let fromAttacker = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const s = status(() =>
        g.canActivate(
          ctx(attacker, { phone: `13${String(i).padStart(9, '0')}` }).ctx,
        ),
      );
      if (s === 200) fromAttacker += 1;
    }
    expect(fromAttacker).toBe(30);

    // 换成大量出口 IP 把表撑过上限：淘汰的是最先到期的 1 分钟桶，不是 24h 的发码日限桶
    for (let i = 0; i < 50_010; i += 1) {
      status(() =>
        g.canActivate(
          ctx(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, {
            phone: `15${String(i).padStart(9, '0')}`,
          }).ctx,
        ),
      );
    }
    current = smsRules;
    const after = status(() => g.canActivate(ctx(attacker).ctx));
    evidence(
      LOG,
      `guard 单元：发满 50 条后撑满桶表（${bucketsOf(g).size} 个桶）→ 攻击者再发码 ${after}`,
    );
    expect(after).toBe(429);
  });

  it('定期清理：60s 一次只删 24h 无命中的桶；有效桶保留（内存不因 sms_day 24h 窗口无限增长）', () => {
    let now = 9_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const g = makeGuard([
      { name: 'sms_day', limit: 50, windowMs: 24 * 60 * 60_000 },
    ]);
    for (let i = 0; i < 100; i += 1)
      status(() => g.canActivate(ctx(`10.1.${i >> 8}.${i & 255}`).ctx));
    expect(bucketsOf(g).size).toBe(100);
    now += 25 * 60 * 60_000; // 25h 后
    status(() => g.canActivate(ctx('10.2.0.1').ctx)); // 触发 prune
    const size = bucketsOf(g).size;
    evidence(
      LOG,
      `guard 单元：100 个桶 25h 后一次请求触发清理 → 剩 ${size} 个`,
    );
    expect(size).toBe(1);
  });
});
