// 2026-09-13 交付审计 §11（数据库 / 可恢复性）：健康探针、DATABASE_URL 缺失快速失败、
// 关闭钩子断开 Prisma、事务回滚（绑定 / 注销账号）、并发上限原子性、§5 分页排序稳定性、连接池上限。
// 隔离库 helmet_audit_dbops；全部合成数据，用完清理。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  relay,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  cleanupAdmins,
  createAdmin,
  type TestAdmin,
} from './helpers/audit-admin';

const uid = () => randomUUID().slice(0, 8);

/** 在交互式事务内注入故障：tx.<model>.<method> 抛错一次（spy 顶层 prisma.<model> 对 tx 客户端无效） */
function failInsideNextTransaction(
  prisma: PrismaService,
  model: 'deviceBinding',
  method: 'create' | 'updateMany',
): jest.SpyInstance {
  const original = prisma.$transaction.bind(prisma);
  return jest.spyOn(prisma, '$transaction').mockImplementationOnce(((
    fn: unknown,
    opts?: unknown,
  ) => {
    if (typeof fn !== 'function') return original(fn as never, opts as never);
    return original(
      (async (tx: Record<string, unknown>) => {
        const delegate = tx[model] as Record<string, unknown>;
        const proxied = new Proxy(tx, {
          get: (target, prop) =>
            prop === model
              ? {
                  ...delegate,
                  [method]: () =>
                    Promise.reject(
                      new Error(`injected: ${model}.${method} failed`),
                    ),
                }
              : (target as Record<string | symbol, unknown>)[prop],
        });
        return (fn as (t: unknown) => Promise<unknown>)(proxied);
      }) as never,
      opts as never,
    );
  }) as never);
}

describe('§11 dbops：健康探针与启动前置', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health 正常返回 200 {status:ok, database:connected}', async () => {
    const res = await request(http).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'connected' });
  });

  it('数据库探针失败 → /health 503（状态码正确）', async () => {
    const spy = jest
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error("Can't reach database server"));
    await request(http).get('/api/v1/health').expect(503);
    spy.mockRestore();
    await request(http).get('/api/v1/health').expect(200);
  });

  it('【DBOPS-05 缺陷断言】API.md §1 /health 约定 503 体为 { status: "error", database: "unreachable" }，实际被统一异常过滤器改写成 { code, message, requestId }', async () => {
    const spy = jest
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error("Can't reach database server"));
    const res = await request(http).get('/api/v1/health').expect(503);
    spy.mockRestore();
    expect(res.body).toMatchObject({
      status: 'error',
      database: 'unreachable',
    });
  });

  it('缺 DATABASE_URL → PrismaService 构造即抛错（启动阶段快速失败，不静默回退 PG* 变量）', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => new PrismaService()).toThrow(/DATABASE_URL/);
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });

  it('连接池：40 并发读请求下，本应用对数据库的连接数不超过 pg Pool 默认上限 10（超出即排队）', async () => {
    const user = await createUser(app, http);
    const samples: number[] = [];
    const sampler = (async () => {
      for (let i = 0; i < 40; i += 1) {
        const rows = await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND backend_type = 'client backend'`;
        samples.push(rows[0].n);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        request(http).get('/api/v1/devices').set(auth(user.token)),
      ),
    );
    await sampler;
    expect(results.every((r) => r.status === 200)).toBe(true);
    const peak = Math.max(...samples);
    // 记录峰值供报告；上限 10 由 pg-pool 默认值决定（PrismaPg 适配器不读 DATABASE_URL 的 connection_limit）

    console.log(
      `[dbops] pg_stat_activity 峰值连接数 = ${peak}（其中含本采样连接）`,
    );
    expect(peak).toBeLessThanOrEqual(11);
    await cleanupUsers(prisma, [{ id: user.id, phone: user.phone }]);
  });
});

describe('§11 dbops：事务回滚', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const deviceIds: string[] = [];
  const userIds: { id: string; phone: string }[] = [];

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });

  afterAll(async () => {
    await cleanupDevices(prisma, deviceIds);
    await cleanupUsers(prisma, userIds);
    await app.close();
  });

  it('绑定：写绑定历史失败 → 整个事务回滚，设备仍未绑定、无历史行；重试成功且只有一段历史', async () => {
    const user = await createUser(app, http);
    userIds.push({ id: user.id, phone: user.phone });
    const deviceId = `dbops_bind_${uid()}`;
    deviceIds.push(deviceId);
    await provisionDevice(prisma, deviceId);

    const spy = failInsideNextTransaction(prisma, 'deviceBinding', 'create');
    const failed = await request(http)
      .post('/api/v1/devices/bind')
      .set(auth(user.token))
      .send({ deviceId, bindCode: `bc_${deviceId}` });
    spy.mockRestore();
    expect(failed.status).toBe(500);

    const device = await prisma.device.findUniqueOrThrow({
      where: { deviceId },
    });
    expect(device.bindUserId).toBeNull();
    expect(device.boundAt).toBeNull();
    expect(await prisma.deviceBinding.count({ where: { deviceId } })).toBe(0);

    await bindDevice(http, user.token, deviceId);
    const bound = await prisma.device.findUniqueOrThrow({
      where: { deviceId },
    });
    expect(bound.bindUserId).toBe(user.id);
    expect(await prisma.deviceBinding.count({ where: { deviceId } })).toBe(1);
  });

  it('注销账号：解绑历史写失败 → 用户未被软删、手机号未改写、设备仍绑定；重试成功后全部一致', async () => {
    const user = await createUser(app, http);
    userIds.push({ id: user.id, phone: user.phone });
    const deviceId = `dbops_del_${uid()}`;
    deviceIds.push(deviceId);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, user.token, deviceId);

    const spy = failInsideNextTransaction(
      prisma,
      'deviceBinding',
      'updateMany',
    );
    const failed = await request(http)
      .delete('/api/v1/users/me')
      .set(auth(user.token))
      .send({ password: user.password });
    spy.mockRestore();
    expect(failed.status).toBe(500);

    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.deletedAt).toBeNull();
    expect(u.phone).toBe(user.phone);
    const d = await prisma.device.findUniqueOrThrow({ where: { deviceId } });
    expect(d.bindUserId).toBe(user.id);
    expect(
      await prisma.deviceBinding.count({
        where: { deviceId, unboundAt: null },
      }),
    ).toBe(1);
    await request(http)
      .get('/api/v1/users/me')
      .set(auth(user.token))
      .expect(200);

    await request(http)
      .delete('/api/v1/users/me')
      .set(auth(user.token))
      .send({ password: user.password })
      .expect(204);
    const gone = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.phone).toBe(`deleted:${user.id}`);
    const released = await prisma.device.findUniqueOrThrow({
      where: { deviceId },
    });
    expect(released.bindUserId).toBeNull();
    expect(
      await prisma.deviceBinding.count({
        where: { deviceId, unboundAt: null },
      }),
    ).toBe(0);
  });

  it('紧急联系人上限 5：8 路并发创建只成功 5 条（advisory lock 事务原子）', async () => {
    const user = await createUser(app, http);
    userIds.push({ id: user.id, phone: user.phone });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(http)
          .post('/api/v1/users/me/emergency-contacts')
          .set(auth(user.token))
          .send({ name: `并发${i}`, phone: `1390000${String(1000 + i)}` }),
      ),
    );
    const created = results.filter((r) => r.status === 201).length;
    const rejected = results.filter(
      (r) => r.status === 400 || r.status === 409,
    ).length;
    expect(created).toBe(5);
    expect(rejected).toBe(3);
    expect(
      await prisma.emergencyContact.count({ where: { userId: user.id } }),
    ).toBe(5);
  });
});

describe('§11 dbops：§5 轨迹分页排序稳定性', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let user: TestUser;
  const deviceId = `dbops_page_${uid()}`;
  const TIE = 30;
  const sameTs = new Date(Date.now() - 60_000).toISOString();

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    user = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, user.token, deviceId);
    // 30 个点共用同一 timestamp（BLE 补传/同秒批量上报的现实情形）
    const res = await relay(
      http,
      user.token,
      deviceId,
      Array.from({ length: TIE }, (_, i) =>
        envelope(deviceId, 'location_update', validLocation(i), {
          timestamp: sameTs,
        }),
      ),
    ).expect(202);
    expect(res.body.accepted).toBe(TIE);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId]);
    await cleanupUsers(prisma, [{ id: user.id, phone: user.phone }]);
    await app.close();
  });

  const page = async (p: number, pageSize: number) => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations`)
      .query({ from, to, page: p, pageSize })
      .set(auth(user.token))
      .expect(200);
    return res.body as {
      items: { id?: string; eventId?: string; timestamp: string }[];
      total: number;
    };
  };

  it('同一执行计划下翻页：3 页 × 10 条覆盖全部 30 个并列点，无重复无遗漏', async () => {
    const seen: string[] = [];
    for (let p = 1; p <= 3; p += 1) {
      const body = await page(p, 10);
      expect(body.total).toBe(TIE);
      expect(body.items).toHaveLength(10);
      seen.push(...body.items.map((it) => JSON.stringify(it)));
    }
    expect(new Set(seen).size).toBe(TIE);
  });

  it('【DBOPS-01 缺陷断言】§5 分页 orderBy 只有 timestamp、无唯一次序键：并列点的页序由执行计划决定（05-explain/06-pagination 日志：同页两种计划 32/100 行不同）', async () => {
    const spy = jest.spyOn(prisma.locationPoint, 'findMany');
    await page(1, 10);
    const call = spy.mock.calls.find((c) => c[0]?.orderBy !== undefined);
    spy.mockRestore();
    expect(call).toBeDefined();
    const orderBy = call![0]!.orderBy;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) =>
      Object.keys(o ?? {}),
    );
    // 期望：timestamp 之后还有唯一列（id / eventId）作为次序键，跨页/跨计划才稳定
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.some((k) => k === 'id' || k === 'eventId')).toBe(true);
  });
});

describe('§11 dbops：关闭钩子', () => {
  it('app.close() → PrismaService.onModuleDestroy 触发 $disconnect（SIGTERM 路径经 enableShutdownHooks 同源）', async () => {
    const { app, prisma } = await buildApp();
    const disconnect = jest.spyOn(prisma, '$disconnect');
    await app.close();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('§11 dbops：误配 ADMIN_JWT_SECRET == JWT_SECRET（deploy/.env.example 要求两值不同，运行时无校验）', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let savedAdminSecret: string | undefined;
  let admin: TestAdmin;
  let user: TestUser;

  beforeAll(async () => {
    savedAdminSecret = process.env.ADMIN_JWT_SECRET;
    process.env.ADMIN_JWT_SECRET = process.env.JWT_SECRET;
    ({ app, http, prisma } = await buildApp());
    admin = await createAdmin(prisma, http, `dbops_admin_${uid()}`);
    user = await createUser(app, http);
  });

  afterAll(async () => {
    process.env.ADMIN_JWT_SECRET = savedAdminSecret;
    await cleanupAdmins(prisma, [admin.username]);
    await cleanupUsers(prisma, [{ id: user.id, phone: user.phone }]);
    await app.close();
  });

  it('两密钥同值时后端仍能启动（没有启动期互斥校验——仅记录，靠 typ 声明兜底）', async () => {
    await request(http).get('/api/v1/health').expect(200);
  });

  it('用户 token 打 /admin/* → 401（typ 缺失即拒）', async () => {
    await request(http)
      .get('/api/v1/admin/users')
      .set(auth(user.token))
      .expect(401);
  });

  it('【DBOPS-06 缺陷断言】API.md §10「admin token 与用户 token 互不可用（双向 401）」：两密钥同值时 admin token 通过用户 JwtAuthGuard（无 typ 校验），/users/me 返回 404 而非 401', async () => {
    await request(http)
      .get('/api/v1/users/me')
      .set(auth(admin.token))
      .expect(401);
  });
});
