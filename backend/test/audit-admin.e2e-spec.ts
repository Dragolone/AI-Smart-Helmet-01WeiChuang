// 审计（2026-09-13）Admin 后端边界：查询参数校验（旧报告 #6 复验）、分页边界、搜索特殊字符、
// 事件类型白名单、概览与 SQL 交叉核对（在线阈值 90s / 今日=UTC+8 / 不含 _invalid / activeSos）、
// 时区边界、token 过期/畸形、故障注入后的错误格式与恢复、注销用户在后台的口径。
// 只用本套件自己造的数据；结束只清理自己创建的行。
import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { Prisma } from '../src/generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import {
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
  adminGet,
  adminGetRaw,
  cleanupAdmins,
  countOf,
  createAdmin,
  signAdminToken,
  utc8TodayStart,
  type TestAdmin,
} from './helpers/audit-admin';
import { registerUser } from './helpers/register';

jest.setTimeout(60_000);

const run = Date.now();
const XSS_NICK = '<script>alert(1)</script>';
// 30 字符上限内：换行 + emoji + 百分号/下划线/反斜杠（搜索特殊字符）
const WEIRD_NICK = 'a%b_c\\d\n🚴‍♂️尾';

describe('审计：Admin 后端边界 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let admin: TestAdmin;
  let owner: TestUser;
  let xssUser: TestUser;
  let weirdUser: TestUser;
  const users: TestUser[] = [];
  const devOnline = `audit_adm_on_${run}`;
  const devOffline = `audit_adm_off_${run}`;
  const devTz = `audit_adm_tz_${run}`;
  const deviceIds = [devOnline, devOffline, devTz];
  const adminUsernames: string[] = [];

  beforeAll(async () => {
    process.env.SOS_COUNTDOWN_SECONDS = '600';
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    ({ app, http, prisma } = await buildApp());
    admin = await createAdmin(prisma, http);
    adminUsernames.push(admin.username);

    owner = await createUser(app, http);
    users.push(owner);
    // 昵称走 PATCH /users/me（注册 DTO 与更新 DTO 同为 MaxLength(30)，无字符白名单）
    xssUser = await createUser(app, http);
    users.push(xssUser);
    await request(http)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${xssUser.token}`)
      .send({ nickname: XSS_NICK })
      .expect(200);
    weirdUser = await createUser(app, http);
    users.push(weirdUser);
    await request(http)
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${weirdUser.token}`)
      .send({ nickname: WEIRD_NICK })
      .expect(200);

    for (const id of deviceIds) await provisionDevice(prisma, id);
    await bindDevice(http, owner.token, devOnline);
    await bindDevice(http, xssUser.token, devTz);

    // 在线设备：心跳 + 3 个位置点 + 一次疑似摔倒（→ pending SOS）+ 一条范围外类型（→ _invalid 留档）
    await relay(http, owner.token, devOnline, [
      envelope(devOnline, 'device_status', { battery: 77, charging: false }),
      envelope(devOnline, 'location_update', validLocation(0)),
      envelope(devOnline, 'location_update', validLocation(1)),
      envelope(devOnline, 'location_update', validLocation(2)),
      envelope(devOnline, 'possible_fall', {
        confidence: 0.9,
        location: validLocation(3),
      }),
      envelope(devOnline, 'sleep_entered', { reason: 'manual' }),
    ]).expect(202);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, deviceIds);
    await cleanupUsers(prisma, users);
    await cleanupAdmins(prisma, adminUsernames);
    await app.close();
  });

  // ————————————————————————————————————————————————————————————
  describe('事件查询参数（旧报告 #6 复验 + 类型白名单 + 时区）', () => {
    it('from=not-a-date → 400 VALIDATION_FAILED（旧 #6：曾 500）', async () => {
      const res = await adminGet(http, admin.token, '/events', {
        from: 'not-a-date',
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.requestId).toMatch(/^req_/);
    });

    it('to=2026-13-45 / from=2026-09-13T25:00:00Z → 400；不产生 500', async () => {
      const badQueries: Record<string, string | number>[] = [
        { to: '2026-13-45' },
        { from: '2026-09-13T25:00:00Z' },
        { from: '1694500000000' },
        { to: 'now' },
      ];
      for (const bad of badQueries) {
        const res = await adminGet(http, admin.token, '/events', bad);
        expect([400]).toContain(res.status);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('from > to → 200 空列表（不是错误）', async () => {
      const res = await adminGet(http, admin.token, '/events', {
        deviceId: devOnline,
        from: '2026-09-13T00:00:00Z',
        to: '2026-09-12T00:00:00Z',
      }).expect(200);
      expect(res.body.total).toBe(0);
      expect(res.body.items).toEqual([]);
    });

    it('时区边界：from 带 +08:00 与 Z 的语义不同，按 timestamp 精确切分', async () => {
      // 两条设备时间刚好落在北京时间 2026-09-13 00:00:00 两侧（UTC 09-12 16:00:00 / 15:59:59）
      const at = new Date('2026-09-12T16:00:00.000Z');
      const before = new Date('2026-09-12T15:59:59.000Z');
      await prisma.rawEvent.createMany({
        data: [
          {
            eventId: `audit_tz_at_${run}`,
            deviceId: devTz,
            eventType: 'location_update',
            timestamp: at,
            schemaVersion: 1,
            payload: validLocation(0) as Prisma.InputJsonValue,
            source: 'app_relay',
          },
          {
            eventId: `audit_tz_before_${run}`,
            deviceId: devTz,
            eventType: 'location_update',
            timestamp: before,
            schemaVersion: 1,
            payload: validLocation(1) as Prisma.InputJsonValue,
            source: 'app_relay',
          },
        ],
      });
      const plus8 = await adminGet(http, admin.token, '/events', {
        deviceId: devTz,
        from: '2026-09-13T00:00:00+08:00',
        to: '2026-09-13T23:59:59+08:00',
      }).expect(200);
      expect(
        plus8.body.items.map((e: { eventId: string }) => e.eventId),
      ).toEqual([`audit_tz_at_${run}`]);
      const zulu = await adminGet(http, admin.token, '/events', {
        deviceId: devTz,
        from: '2026-09-13T00:00:00Z',
      }).expect(200);
      expect(zulu.body.total).toBe(0);
      const utcCut = await adminGet(http, admin.token, '/events', {
        deviceId: devTz,
        from: '2026-09-12T16:00:00Z',
        to: '2026-09-12T16:00:00Z',
      }).expect(200);
      expect(utcCut.body.total).toBe(1); // lte 含端点
      // 只写日期（ISO 8601 合法）按 UTC 零点解释——与「今日=UTC+8」的概览口径不同，接口层需注意
      const dateOnly = await adminGet(http, admin.token, '/events', {
        deviceId: devTz,
        from: '2026-09-12',
        to: '2026-09-12',
      }).expect(200);
      expect(dateOnly.body.total).toBe(0);
    });

    it('type 白名单：未知/混入未知/_invalid 一律 400；空段与空白容忍', async () => {
      for (const type of ['exploded', 'collision_risk,exploded', '_invalid']) {
        const res = await adminGet(http, admin.token, '/events', { type });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      const tolerant = await adminGet(http, admin.token, '/events', {
        deviceId: devOnline,
        type: ' location_update , ,device_status,',
      }).expect(200);
      expect(tolerant.body.total).toBe(4);
      const noneFilter = await adminGet(http, admin.token, '/events', {
        deviceId: devOnline,
        type: ',,',
      }).expect(200);
      expect(noneFilter.body.total).toBe(5); // 5 条合法事件，_invalid 排除
    });

    it('invalid 参数：非 true/false → 400；invalid=true 优先于 type', async () => {
      const bad = await adminGet(http, admin.token, '/events', {
        invalid: 'yes',
      });
      expect(bad.status).toBe(400);
      const res = await adminGet(http, admin.token, '/events', {
        deviceId: devOnline,
        invalid: 'true',
        type: 'location_update',
      }).expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].eventType).toBe('_invalid');
      expect(res.body.items[0].payload.reason).toBe('event_type_not_allowed');
      expect(res.body.items[0].source).toBe('app_relay');
    });

    it('deviceId 超长（65）→ 400；不存在的 deviceId → 200 空', async () => {
      await adminGet(http, admin.token, '/events', {
        deviceId: 'x'.repeat(65),
      }).expect(400);
      const res = await adminGet(http, admin.token, '/events', {
        deviceId: `no_such_${run}`,
      }).expect(200);
      expect(res.body.total).toBe(0);
    });
  });

  // ————————————————————————————————————————————————————————————
  describe('分页边界（四个列表接口同 DTO）', () => {
    const paths = ['/users', '/devices', '/accidents', '/events'];

    it('pageSize=101 / 0 / -1、page=0 / 1.5 / abc → 400', async () => {
      for (const path of paths) {
        const pageQueries: Record<string, string | number>[] = [
          { pageSize: 101 },
          { pageSize: 0 },
          { pageSize: -1 },
          { page: 0 },
          { page: 1.5 },
          { page: 'abc' },
        ];
        for (const q of pageQueries) {
          const res = await adminGet(http, admin.token, path, q);
          expect({ path, q, status: res.status }).toEqual({
            path,
            q,
            status: 400,
          });
          expect(res.body.code).toBe('VALIDATION_FAILED');
        }
      }
    });

    it('pageSize=100 上限可用；page 超出总页数 → 200 空 items 且 total 不变', async () => {
      for (const path of paths) {
        const max = await adminGet(http, admin.token, path, {
          pageSize: 100,
        }).expect(200);
        expect(max.body.pageSize).toBe(100);
        const far = await adminGet(http, admin.token, path, {
          page: 100000,
          pageSize: 100,
        }).expect(200);
        expect(far.body.items).toEqual([]);
        expect(far.body.total).toBe(max.body.total);
        expect(far.body.page).toBe(100000);
      }
    });

    it('重复键 page=1&page=2 → 400（不 500）', async () => {
      const res = await adminGetRaw(http, admin.token, '/users?page=1&page=2');
      expect(res.status).toBe(400);
    });

    it('缺省分页 = page 1 / pageSize 20；末页条数 = total - (pages-1)*pageSize', async () => {
      const res = await adminGet(http, admin.token, '/events', {
        deviceId: devOnline,
        pageSize: 2,
      }).expect(200);
      expect(res.body.total).toBe(5);
      expect(res.body.items).toHaveLength(2);
      const last = await adminGet(http, admin.token, '/events', {
        deviceId: devOnline,
        pageSize: 2,
        page: 3,
      }).expect(200);
      expect(last.body.items).toHaveLength(1);
      const dflt = await adminGet(http, admin.token, '/users').expect(200);
      expect(dflt.body).toMatchObject({ page: 1, pageSize: 20 });
    });
  });

  // ————————————————————————————————————————————————————————————
  describe('搜索特殊字符（% _ \\ 不当通配符；超长拒绝）', () => {
    it('users keyword=% / _ / \\ 只命中真正含该字符的行', async () => {
      for (const kw of ['%', '_', '\\']) {
        const res = await adminGet(http, admin.token, '/users', {
          keyword: kw,
          pageSize: 100,
        }).expect(200);
        const ids = res.body.items.map((u: { id: string }) => u.id);
        expect(ids).toContain(weirdUser.id);
        expect(ids).not.toContain(owner.id); // 昵称为空、手机号纯数字
        for (const u of res.body.items as Array<{
          phone: string;
          nickname: string | null;
        }>) {
          expect(`${u.phone}${u.nickname ?? ''}`).toContain(kw);
        }
      }
    });

    it('devices keyword=% 不会匹配全部设备；keyword 全空白 = 无过滤', async () => {
      const res = await adminGet(http, admin.token, '/devices', {
        keyword: '%',
        pageSize: 100,
      }).expect(200);
      const ids = res.body.items.map((d: { deviceId: string }) => d.deviceId);
      expect(ids).not.toContain(devOnline);
      const blank = await adminGet(http, admin.token, '/devices', {
        keyword: '   ',
        pageSize: 100,
      }).expect(200);
      expect(
        blank.body.items.map((d: { deviceId: string }) => d.deviceId),
      ).toContain(devOnline);
    });

    it('keyword 64 字符可用、65 → 400；昵称大小写不敏感、手机号子串', async () => {
      await adminGet(http, admin.token, '/users', {
        keyword: 'k'.repeat(64),
      }).expect(200);
      await adminGet(http, admin.token, '/users', {
        keyword: 'k'.repeat(65),
      }).expect(400);
      const ci = await adminGet(http, admin.token, '/users', {
        keyword: 'SCRIPT>ALERT',
      }).expect(200);
      expect(ci.body.items.map((u: { id: string }) => u.id)).toContain(
        xssUser.id,
      );
      const sub = await adminGet(http, admin.token, '/users', {
        keyword: owner.phone.slice(3, 9),
      }).expect(200);
      expect(sub.body.items.map((u: { id: string }) => u.id)).toContain(
        owner.id,
      );
    });

    it('XSS / emoji 昵称原样回传（转义是前端职责），换行入库前压成空格；设备详情 bindUser 同', async () => {
      const res = await adminGet(http, admin.token, '/users', {
        keyword: xssUser.phone,
      }).expect(200);
      expect(res.body.items[0].nickname).toBe(XSS_NICK);
      const weird = await adminGet(http, admin.token, '/users', {
        keyword: weirdUser.phone,
      }).expect(200);
      // 表情组合里的零宽连接符保留，换行压成一个空格（common/display-name）
      expect(weird.body.items[0].nickname).toBe(WEIRD_NICK.replace('\n', ' '));
      const detail = await adminGet(
        http,
        admin.token,
        `/devices/${devTz}`,
      ).expect(200);
      expect(detail.body.bindUser.nickname).toBe(XSS_NICK);
    });
  });

  // ————————————————————————————————————————————————————————————
  describe('鉴权：过期 / 畸形 / 越权', () => {
    it('已过期 admin token → 401 UNAUTHORIZED', async () => {
      const expired = signAdminToken(admin.id, { expiresInSec: -5 });
      const res = await adminGet(http, expired, '/users').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('管理员改密（create:admin --reset）/ 被删除后旧 token 立即 401，不再等 12 h 过期（观察项 7）', async () => {
      const victim = await createAdmin(
        prisma,
        http,
        `audit_admin_revoke_${Date.now()}`,
      );
      adminUsernames.push(victim.username);
      await adminGet(http, victim.token, '/users').expect(200);
      await prisma.adminUser.update({
        where: { id: victim.id },
        data: { passwordHash: await bcrypt.hash('rotated_pw_2', 4) },
      });
      await adminGet(http, victim.token, '/users').expect(401);
      const relogin = await request(http)
        .post('/api/v1/admin/auth/login')
        .send({ username: victim.username, password: 'rotated_pw_2' })
        .expect(200);
      await adminGet(http, relogin.body.accessToken as string, '/users').expect(
        200,
      );
      await prisma.adminUser.delete({ where: { id: victim.id } });
      await adminGet(http, relogin.body.accessToken as string, '/users').expect(
        401,
      );
    });

    it('缺 typ / typ=user / 错密钥 / 非 Bearer 头 → 401', async () => {
      await adminGet(
        http,
        signAdminToken(admin.id, { typ: null }),
        '/users',
      ).expect(401);
      await adminGet(
        http,
        signAdminToken(admin.id, { typ: 'user' }),
        '/users',
      ).expect(401);
      await adminGet(
        http,
        signAdminToken(admin.id, { secret: 'not_the_secret' }),
        '/users',
      ).expect(401);
      await request(http)
        .get('/api/v1/admin/users')
        .set('Authorization', `Token ${admin.token}`)
        .expect(401);
    });

    it('App 用户 token 进全部 admin 只读接口 → 401', async () => {
      for (const path of [
        '/users',
        '/devices',
        `/devices/${devOnline}`,
        '/accidents',
        '/events',
        '/stats/overview',
      ]) {
        await adminGet(http, owner.token, path).expect(401);
      }
    });

    it('登录 DTO：用户名 65 字符 / 空 / 缺字段 / 非 JSON → 400，不泄露账号存在性', async () => {
      const long = await request(http)
        .post('/api/v1/admin/auth/login')
        .send({ username: 'u'.repeat(65), password: 'x' });
      expect(long.status).toBe(400);
      const empty = await request(http)
        .post('/api/v1/admin/auth/login')
        .send({ username: '', password: '' });
      expect(empty.status).toBe(400);
      const missing = await request(http)
        .post('/api/v1/admin/auth/login')
        .send({});
      expect(missing.status).toBe(400);
      const notJson = await request(http)
        .post('/api/v1/admin/auth/login')
        .set('Content-Type', 'application/json')
        .send('{broken');
      expect(notJson.status).toBe(400);
      const noSuch = await request(http)
        .post('/api/v1/admin/auth/login')
        .send({ username: `no_such_${run}`, password: 'x' });
      const wrongPw = await request(http)
        .post('/api/v1/admin/auth/login')
        .send({ username: admin.username, password: 'wrong' });
      expect(noSuch.status).toBe(401);
      expect(wrongPw.status).toBe(401);
      expect(noSuch.body.message).toBe(wrongPw.body.message);
    });
  });

  // ————————————————————————————————————————————————————————————
  describe('概览统计与 SQL 交叉核对', () => {
    it('五指标与直接 SQL 一致（在线 90s / 今日 UTC+8 / 不含 _invalid / pending）', async () => {
      const res = await adminGet(http, admin.token, '/stats/overview').expect(
        200,
      );
      const s = res.body as Record<string, number>;
      const todayStart = utc8TodayStart();
      const onlineSince = new Date(Date.now() - 90_000);
      const [dt, don, ut, te, sos] = await Promise.all([
        prisma.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM devices`,
        prisma.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM devices WHERE last_seen_at >= ${onlineSince}`,
        prisma.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM users WHERE deleted_at IS NULL`,
        prisma.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM raw_events WHERE received_at >= ${todayStart} AND event_type <> '_invalid'`,
        prisma.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM sos_cases WHERE status = 'pending'`,
      ]);
      expect(s.deviceTotal).toBe(countOf(dt));
      expect(s.deviceOnline).toBe(countOf(don));
      expect(s.userTotal).toBe(countOf(ut));
      expect(s.todayEvents).toBe(countOf(te));
      expect(s.activeSos).toBe(countOf(sos));
      expect(s.deviceOnline).toBeGreaterThanOrEqual(1); // devOnline 刚心跳
      expect(s.activeSos).toBeGreaterThanOrEqual(1); // possible_fall 建单
    });

    it('今日边界：received_at 早 1s 不计入，恰好等于零点计入', async () => {
      const before = await adminGet(http, admin.token, '/stats/overview')
        .expect(200)
        .then((r) => r.body.todayEvents as number);
      const todayStart = utc8TodayStart();
      await prisma.rawEvent.createMany({
        data: [
          {
            eventId: `audit_today_edge_in_${run}`,
            deviceId: devTz,
            eventType: 'device_status',
            timestamp: todayStart,
            receivedAt: todayStart,
            schemaVersion: 1,
            payload: { battery: 1 },
            source: 'app_relay',
          },
          {
            eventId: `audit_today_edge_out_${run}`,
            deviceId: devTz,
            eventType: 'device_status',
            timestamp: new Date(todayStart.getTime() - 1000),
            receivedAt: new Date(todayStart.getTime() - 1000),
            schemaVersion: 1,
            payload: { battery: 2 },
            source: 'app_relay',
          },
          {
            eventId: `invalid_audit_today_${run}`,
            deviceId: devTz,
            eventType: '_invalid',
            timestamp: new Date(),
            schemaVersion: 0,
            payload: { reason: 'audit', raw: '{' },
            source: 'app_relay',
          },
        ],
      });
      const after = await adminGet(http, admin.token, '/stats/overview')
        .expect(200)
        .then((r) => r.body.todayEvents as number);
      expect(after - before).toBe(1);
    });

    it('在线阈值：last_seen_at 刚好 90s 前算在线，91s 前算离线（列表/详情/概览同口径）', async () => {
      await prisma.device.update({
        where: { deviceId: devOffline },
        data: { lastSeenAt: new Date(Date.now() - 89_000) },
      });
      const on = await adminGet(
        http,
        admin.token,
        `/devices/${devOffline}`,
      ).expect(200);
      expect(on.body.online).toBe(true);
      await prisma.device.update({
        where: { deviceId: devOffline },
        data: { lastSeenAt: new Date(Date.now() - 91_000) },
      });
      const off = await adminGet(
        http,
        admin.token,
        `/devices/${devOffline}`,
      ).expect(200);
      expect(off.body.online).toBe(false);
      const list = await adminGet(http, admin.token, '/devices', {
        keyword: devOffline,
        online: 'false',
      }).expect(200);
      expect(
        list.body.items.map((d: { deviceId: string }) => d.deviceId),
      ).toEqual([devOffline]);
      const listOn = await adminGet(http, admin.token, '/devices', {
        keyword: devOffline,
        online: 'true',
      }).expect(200);
      expect(listOn.body.total).toBe(0);
      const badOnline = await adminGet(http, admin.token, '/devices', {
        online: '1',
      });
      expect(badOnline.status).toBe(400);
    });
  });

  // ————————————————————————————————————————————————————————————
  describe('事故与设备详情', () => {
    it('accidents：status 非法 → 400；deviceId 精确筛；user 归属固化', async () => {
      await adminGet(http, admin.token, '/accidents', {
        status: 'done',
      }).expect(400);
      const res = await adminGet(http, admin.token, '/accidents', {
        deviceId: devOnline,
        status: 'pending',
      }).expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].triggerType).toBe('possible_fall');
      expect(res.body.items[0].user.id).toBe(owner.id);
      expect(res.body.items[0].location.source).toBe('event');
      // 前缀不算精确匹配
      const prefix = await adminGet(http, admin.token, '/accidents', {
        deviceId: devOnline.slice(0, -2),
      }).expect(200);
      expect(prefix.body.total).toBe(0);
    });

    it('设备详情：URL 编码特殊字符 / 不存在 → 404 NOT_FOUND；最近事件含 _invalid 且 ≤10', async () => {
      const weird = await adminGet(
        http,
        admin.token,
        '/devices/%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      );
      expect(weird.status).toBe(404);
      expect(weird.body.code).toBe('NOT_FOUND');
      const detail = await adminGet(
        http,
        admin.token,
        `/devices/${devOnline}`,
      ).expect(200);
      expect(detail.body.recentEvents.length).toBeLessThanOrEqual(10);
      expect(
        detail.body.recentEvents.map((e: { eventType: string }) => e.eventType),
      ).toContain('_invalid');
      expect(detail.body.bindUser.id).toBe(owner.id);
      expect(detail.body.settings).toEqual({});
    });
  });

  // ————————————————————————————————————————————————————————————
  describe('故障注入：数据库异常时的错误格式与恢复', () => {
    it('rawEvent.count 抛错 → 500 INTERNAL_ERROR 统一格式；下一次请求恢复', async () => {
      const spy = jest
        .spyOn(prisma.rawEvent, 'count')
        .mockImplementationOnce(() => {
          throw new Error('audit: injected db failure');
        });
      try {
        const res = await adminGet(http, admin.token, '/events', {
          deviceId: devOnline,
        });
        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
        expect(res.body.requestId).toMatch(/^req_/);
        expect(JSON.stringify(res.body)).not.toContain('injected db failure');
      } finally {
        spy.mockRestore();
      }
      const ok = await adminGet(http, admin.token, '/events', {
        deviceId: devOnline,
      }).expect(200);
      expect(ok.body.total).toBe(5);
    });

    it('$transaction 抛错 → 概览 500 而不是返回全 0', async () => {
      const spy = jest
        .spyOn(prisma, '$transaction')
        .mockRejectedValueOnce(new Error('audit: injected tx failure'));
      try {
        const res = await adminGet(http, admin.token, '/stats/overview');
        expect(res.status).toBe(500);
        expect(res.body.code).toBe('INTERNAL_ERROR');
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ————————————————————————————————————————————————————————————
  describe('注销用户在后台的口径（API.md §10 未定义；审计预期见 ADMIN 报告）', () => {
    let deleted: TestUser;
    const nick = `audit_del_nick_${run}`;

    beforeAll(async () => {
      deleted = await createUser(app, http);
      users.push(deleted);
      await request(http)
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${deleted.token}`)
        .send({ nickname: nick })
        .expect(200);
      await request(http)
        .delete('/api/v1/users/me')
        .set('Authorization', `Bearer ${deleted.token}`)
        .send({ password: deleted.password })
        .expect(204);
    });

    it('已注销用户默认不出现在用户列表；includeDeleted=true 时出现并带 deletedAt【ADMIN-04 修复验证】', async () => {
      const res = await adminGet(http, admin.token, '/users', {
        keyword: nick,
      }).expect(200);
      // 口径 2026-09-15：默认不列出；记录保留，显式 includeDeleted=true 才列出并带 deletedAt
      expect(res.body.items.map((u: { id: string }) => u.id)).not.toContain(
        deleted.id,
      );
      const withDeleted = await adminGet(http, admin.token, '/users', {
        keyword: nick,
        includeDeleted: 'true',
      }).expect(200);
      const row = (
        withDeleted.body.items as Array<{
          id: string;
          deletedAt: string | null;
        }>
      ).find((u) => u.id === deleted.id);
      expect(row).toBeDefined();
      expect(row!.deletedAt).not.toBeNull();
    });

    it('userTotal 只计未注销用户【ADMIN-04 修复验证】', async () => {
      const res = await adminGet(http, admin.token, '/stats/overview').expect(
        200,
      );
      const active = await prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*)::bigint AS n FROM users WHERE deleted_at IS NULL`;
      expect(res.body.userTotal).toBe(countOf(active));
    });
  });

  // ————————————————————————————————————————————————————————————
  describe('注册用户带 XSS 昵称走注册接口也能落库（前端转义是唯一防线）', () => {
    it('register.nickname=<img onerror> 原样存储并在 admin 列表回传', async () => {
      const phone = `19${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, '0')}`;
      const reg = await registerUser(app, http, {
        phone,
        password: 'audit_pw_1',
        nickname: '<img src=x onerror=alert(2)>',
      });
      users.push({
        id: reg.body.user.id as string,
        phone,
        password: 'audit_pw_1',
        token: reg.body.accessToken as string,
        refreshToken: reg.body.refreshToken as string,
      });
      const res = await adminGet(http, admin.token, '/users', {
        keyword: phone,
      }).expect(200);
      expect(res.body.items[0].nickname).toBe('<img src=x onerror=alert(2)>');
      expect(randomUUID()).toBeTruthy();
    });
  });
});
