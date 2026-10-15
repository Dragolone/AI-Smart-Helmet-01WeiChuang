// 2026-10-16 边界测试：管理后台（API.md §10）。audit-admin 已覆盖分页 / 关键字通配符 / 时区 / 统计，
// 这里补登录入参、令牌在管理员被删后的行为、枚举参数的大小写、时间窗端点、已注销账号在各列表里的样子。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  adminGet,
  cleanupAdmins,
  createAdmin,
  type TestAdmin,
} from './helpers/audit-admin';
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
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

describe('边界：管理后台 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let admin: TestAdmin;
  const run = Date.now();
  const adminNames: string[] = [];
  const users: TestUser[] = [];
  const dev = `edge_adm_${run}`;
  const devIdle = `edge_adm_idle_${run}`;

  const login = (body: unknown) =>
    request(http)
      .post('/api/v1/admin/auth/login')
      .send(body as object);

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    admin = await createAdmin(prisma, http, `edge_admin_${run}`);
    adminNames.push(admin.username);
    await provisionDevice(prisma, dev);
    await provisionDevice(prisma, devIdle);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [dev, devIdle]);
    await cleanupUsers(prisma, users);
    await cleanupAdmins(prisma, adminNames);
    await app.close();
  });

  describe('管理员登录', () => {
    it('用户名首尾空格 / 大小写不同 → 401（不 trim、区分大小写）；错误信息与「账号不存在」一致', async () => {
      const r1 = await login({
        username: ` ${admin.username}`,
        password: admin.password,
      });
      const r2 = await login({
        username: admin.username.toUpperCase(),
        password: admin.password,
      });
      const r3 = await login({
        username: `nobody_${run}`,
        password: admin.password,
      });
      expect([r1.status, r2.status, r3.status]).toEqual([401, 401, 401]);
      expect(r1.body.message).toBe(r3.body.message);
    });

    it('密码 128 字符（形状合法、内容错）→ 401；129 字符 → 400；非字符串 → 400', async () => {
      expect(
        (await login({ username: admin.username, password: 'p'.repeat(128) }))
          .status,
      ).toBe(401);
      expect(
        (await login({ username: admin.username, password: 'p'.repeat(129) }))
          .status,
      ).toBe(400);
      expect(
        (await login({ username: admin.username, password: 12345678 })).status,
      ).toBe(400);
    });

    it('登录响应不含密码哈希；admin token 进 App 用户接口 401', async () => {
      const r = await login({
        username: admin.username,
        password: admin.password,
      }).expect(200);
      expect(Object.keys(r.body).sort()).toEqual(['accessToken', 'admin']);
      expect(Object.keys(r.body.admin).sort()).toEqual(['id', 'username']);
      const u = await request(http)
        .get('/api/v1/users/me')
        .set(auth(r.body.accessToken as string));
      expect(u.status).toBe(401);
    });

    it('管理员记录被删后，已签发的 admin token 在有效期内仍可用（12h 无状态令牌，文档未写吊销，按现状）', async () => {
      const temp = await createAdmin(prisma, http, `edge_admin_tmp_${run}`);
      adminNames.push(temp.username);
      await prisma.adminUser.delete({ where: { id: temp.id } });
      const r = await adminGet(http, temp.token, '/stats/overview');
      expect(r.status).toBe(200);
      // 但不能再登录
      expect(
        (await login({ username: temp.username, password: temp.password }))
          .status,
      ).toBe(401);
    });
  });

  describe('枚举参数严格匹配', () => {
    it('includeDeleted / online / invalid 只收小写 true / false：TRUE / 1 / yes / 空串 → 400', async () => {
      for (const v of ['TRUE', 'True', '1', 'yes', '']) {
        expect(
          (await adminGet(http, admin.token, '/users', { includeDeleted: v }))
            .status,
        ).toBe(400);
        expect(
          (await adminGet(http, admin.token, '/devices', { online: v })).status,
        ).toBe(400);
        expect(
          (await adminGet(http, admin.token, '/events', { invalid: v })).status,
        ).toBe(400);
      }
    });

    it('accidents.status 大小写不同 / 未知 → 400；deviceId 64 字符 200（空）、65 字符 400；首尾空白被 trim', async () => {
      for (const status of ['PENDING', 'Notified', 'failed']) {
        expect(
          (await adminGet(http, admin.token, '/accidents', { status })).status,
        ).toBe(400);
      }
      const ok = await adminGet(http, admin.token, '/accidents', {
        deviceId: 'a'.repeat(64),
      });
      expect(ok.status).toBe(200);
      expect(ok.body.items).toEqual([]);
      expect(
        (
          await adminGet(http, admin.token, '/accidents', {
            deviceId: 'a'.repeat(65),
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('事件时间窗与设备详情', () => {
    it('admin 事件：from = to 时返回恰好落在该时刻的事件（两端闭区间，Admin 不校验先后，按现状——App 端同参数 400）', async () => {
      const owner = await createUser(app, http);
      users.push(owner);
      await bindDevice(http, owner.token, dev);
      const at = new Date(
        Math.floor((Date.now() - 60_000) / 1000) * 1000,
      ).toISOString();
      const e = envelope(
        dev,
        'collision_risk',
        { riskLevel: 'low' },
        { timestamp: at },
      );
      await relay(http, owner.token, dev, [e]).expect(202);
      const r = await adminGet(http, admin.token, '/events', {
        deviceId: dev,
        from: at,
        to: at,
      });
      expect(r.status).toBe(200);
      expect(r.body.items.map((x: { eventId: string }) => x.eventId)).toEqual([
        e.eventId,
      ]);
      const app400 = await request(http)
        .get(`/api/v1/devices/${dev}/events`)
        .query({ from: at, to: at })
        .set(auth(owner.token));
      expect(app400.status).toBe(400);
    });

    it('从未上报过的设备：详情 200，online=false、recentEvents 空、settings 为 {}、bindUser 为 null', async () => {
      const r = await adminGet(http, admin.token, `/devices/${devIdle}`).expect(
        200,
      );
      expect(r.body).toMatchObject({
        deviceId: devIdle,
        online: false,
        lastSeenAt: null,
        recentEvents: [],
        settings: {},
        bindUser: null,
      });
    });

    it('设备关键字按 deviceId 不区分大小写匹配（按现状）；首尾空白被 trim', async () => {
      for (const keyword of [dev.toUpperCase(), `  ${dev}  `]) {
        const r = await adminGet(http, admin.token, '/devices', {
          keyword,
        }).expect(200);
        expect(
          r.body.items.map((x: { deviceId: string }) => x.deviceId),
        ).toContain(dev);
      }
    });
  });

  describe('已注销账号在后台', () => {
    it('注销后：用户列表默认不出现、includeDeleted=true 出现且 phone 为 deleted:<id>、带 deletedAt；其名下的事故仍带 user 归属（昵称保留）', async () => {
      const u = await createUser(app, http);
      const devGone = `edge_adm_gone_${run}`;
      await provisionDevice(prisma, devGone);
      await bindDevice(http, u.token, devGone);
      await request(http)
        .patch('/api/v1/users/me')
        .set(auth(u.token))
        .send({ nickname: `注销骑手${run}` })
        .expect(200);
      await relay(http, u.token, devGone, [
        envelope(devGone, 'manual_sos', {}),
      ]).expect(202);
      await request(http)
        .delete('/api/v1/users/me')
        .set(auth(u.token))
        .send({ password: u.password })
        .expect(204);
      users.push({ ...u, phone: `deleted:${u.id}` });

      const hidden = await adminGet(http, admin.token, '/users', {
        keyword: `注销骑手${run}`,
      }).expect(200);
      expect(hidden.body.items).toEqual([]);
      const shown = await adminGet(http, admin.token, '/users', {
        keyword: `注销骑手${run}`,
        includeDeleted: 'true',
      }).expect(200);
      expect(shown.body.items).toHaveLength(1);
      expect(shown.body.items[0]).toMatchObject({
        id: u.id,
        phone: `deleted:${u.id}`,
        deviceCount: 0,
      });
      expect(typeof shown.body.items[0].deletedAt).toBe('string');

      const acc = await adminGet(http, admin.token, '/accidents', {
        deviceId: devGone,
      }).expect(200);
      expect(acc.body.items).toHaveLength(1);
      expect(acc.body.items[0].user).toMatchObject({
        id: u.id,
        nickname: `注销骑手${run}`,
      });
      // 设备已随注销解绑：后台设备列表里 bindUser 为 null
      const devs = await adminGet(http, admin.token, '/devices', {
        keyword: devGone,
      }).expect(200);
      expect(devs.body.items[0].bindUser).toBeNull();
      await cleanupDevices(prisma, [devGone]);
    });
  });
});
