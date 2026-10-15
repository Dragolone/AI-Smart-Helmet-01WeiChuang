// 2026-10-16 边界测试：事件历史与详情（API.md §6）。
// type 参数的书写变体、时间窗端点、分页极值、eventId 只在设备内唯一（决策 #54）时的详情查询。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('边界：事件查询 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let owner: TestUser;
  let other: TestUser;
  const run = Date.now();
  const d1 = `edge_evt1_${run}`;
  const d2 = `edge_evt2_${run}`;
  /** 事件时间锚：1 小时前起每分钟一条，共 6 条，类型轮换 */
  const T0 = Math.floor((Date.now() - 60 * MIN) / 1000) * 1000;
  const TYPES = [
    'collision_risk',
    'obstacle_risk',
    'risk_cleared',
    'collision_risk',
    'obstacle_risk',
    'risk_cleared',
  ];

  const list = (
    query: Record<string, string>,
    deviceId = d1,
    token = owner.token,
  ) =>
    request(http)
      .get(`/api/v1/devices/${deviceId}/events`)
      .query(query)
      .set(auth(token));

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    owner = await createUser(app, http);
    other = await createUser(app, http);
    for (const d of [d1, d2]) {
      await provisionDevice(prisma, d);
      await bindDevice(http, owner.token, d);
    }
    await relay(
      http,
      owner.token,
      d1,
      TYPES.map((t, i) =>
        envelope(
          d1,
          t,
          t === 'risk_cleared' ? {} : { riskLevel: 'high', direction: 'rear' },
          { timestamp: iso(T0 + i * MIN) },
        ),
      ),
    ).expect(202);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [d1, d2]);
    await cleanupUsers(prisma, [owner, other]);
    await app.close();
  });

  describe('type 参数', () => {
    it('逗号两侧空白、重复值、尾逗号都容忍：等价于去重后的集合', async () => {
      const canonical = await list({
        type: 'collision_risk,obstacle_risk',
      }).expect(200);
      expect(canonical.body.total).toBe(4);
      for (const type of [
        ' collision_risk , obstacle_risk ',
        'collision_risk,collision_risk,obstacle_risk',
        'collision_risk,obstacle_risk,',
        ',collision_risk,,obstacle_risk',
      ]) {
        const r = await list({ type }).expect(200);
        expect(r.body.total).toBe(4);
      }
    });

    it('大小写不同 / 未知值混入 / 保留类型 _invalid → 400 VALIDATION_FAILED', async () => {
      for (const type of [
        'COLLISION_RISK',
        'Collision_Risk',
        'collision_risk,foo',
        '_invalid',
        'collision-risk',
      ]) {
        const r = await list({ type });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('type 300 字符可用（全是合法值的重复）、301 字符 → 400；全空白 = 不筛', async () => {
      const unit = 'risk_cleared,';
      let t300 = unit.repeat(Math.floor(300 / unit.length));
      t300 = t300 + ','.repeat(300 - t300.length);
      expect(t300).toHaveLength(300);
      const ok = await list({ type: t300 });
      expect(ok.status).toBe(200);
      expect(ok.body.total).toBe(2);
      expect((await list({ type: `${t300},` })).status).toBe(400);
      const blank = await list({ type: '   ' }).expect(200);
      expect(blank.body.total).toBe(6);
    });

    it('重复的 type 参数（type=a&type=b）→ 400，不 500', async () => {
      const r = await request(http)
        .get(
          `/api/v1/devices/${d1}/events?type=collision_risk&type=obstacle_risk`,
        )
        .set(auth(owner.token));
      expect(r.status).toBe(400);
    });
  });

  describe('时间窗', () => {
    it('from / to 两端闭区间：正好落在端点上的事件都在；收进 1 ms 就都不在', async () => {
      const r = await list({
        from: iso(T0 + MIN),
        to: iso(T0 + 3 * MIN),
      }).expect(200);
      expect(
        r.body.items.map((e: { timestamp: string }) => e.timestamp),
      ).toEqual([iso(T0 + 3 * MIN), iso(T0 + 2 * MIN), iso(T0 + MIN)]);
      const inner = await list({
        from: iso(T0 + MIN + 1),
        to: iso(T0 + 3 * MIN - 1),
      }).expect(200);
      expect(inner.body.total).toBe(1);
    });

    it('只给 from / 只给 to 都可以；from = to → 400；不设 24h 上限（跨 10 年照查）', async () => {
      expect(
        (await list({ from: iso(T0 + 4 * MIN) }).expect(200)).body.total,
      ).toBe(2);
      expect((await list({ to: iso(T0 + MIN) }).expect(200)).body.total).toBe(
        2,
      );
      expect((await list({ from: iso(T0), to: iso(T0) })).status).toBe(400);
      const decade = await list({
        from: '2020-01-01T00:00:00Z',
        to: '2030-01-01T00:00:00Z',
      }).expect(200);
      expect(decade.body.total).toBe(6);
    });

    it('1970 年起 / 9999 年止的窗口：200，不 500', async () => {
      const r = await list({
        from: '1970-01-01T00:00:00Z',
        to: '9999-12-31T23:59:59Z',
      });
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(6);
    });
  });

  describe('分页', () => {
    it('pageSize=1 逐页翻完 6 页：最新在前、无重复无遗漏；第 7 页空', async () => {
      const seen: string[] = [];
      for (let page = 1; page <= 7; page++) {
        const r = await list({ page: String(page), pageSize: '1' }).expect(200);
        seen.push(...r.body.items.map((e: { eventId: string }) => e.eventId));
        if (page === 7) expect(r.body.items).toEqual([]);
        expect(r.body.total).toBe(6);
      }
      expect(new Set(seen).size).toBe(6);
      const all = await list({ pageSize: '100' }).expect(200);
      expect(seen).toEqual(
        all.body.items.map((e: { eventId: string }) => e.eventId),
      );
    });

    it('page=0 / -1 / 1.5 / abc、pageSize=0 / 101 → 400', async () => {
      for (const q of <Array<Record<string, string>>>[
        { page: '0' },
        { page: '-1' },
        { page: '1.5' },
        { page: 'abc' },
        { pageSize: '0' },
        { pageSize: '101' },
      ]) {
        expect((await list(q)).status).toBe(400);
      }
    });
  });

  describe('详情', () => {
    it('eventId 只在设备内唯一：本人两台设备上同号的事件，详情返回其中一条（不 500；按现状不保证是哪台）', async () => {
      const sameId = `edge_same_${run}`;
      await relay(http, owner.token, d1, [
        envelope(
          d1,
          'collision_risk',
          { riskLevel: 'low' },
          { eventId: sameId },
        ),
      ]).expect(202);
      await relay(http, owner.token, d2, [
        envelope(
          d2,
          'obstacle_risk',
          { riskLevel: 'low' },
          { eventId: sameId },
        ),
      ]).expect(202);
      const r = await request(http)
        .get(`/api/v1/events/${sameId}`)
        .set(auth(owner.token));
      expect(r.status).toBe(200);
      expect([d1, d2]).toContain(r.body.deviceId);
      // 两台各自的列表里都有，互不吞
      for (const d of [d1, d2]) {
        const l = await list({ pageSize: '100' }, d).expect(200);
        expect(
          l.body.items.map((e: { eventId: string }) => e.eventId),
        ).toContain(sameId);
      }
    });

    it('别人看不到（404）；不存在 / 超长 / 特殊字符的 eventId → 404', async () => {
      const any = (await list({ pageSize: '1' }).expect(200)).body.items[0]
        .eventId as string;
      const alien = await request(http)
        .get(`/api/v1/events/${any}`)
        .set(auth(other.token));
      expect(alien.status).toBe(404);
      expect(alien.body.code).toBe('NOT_FOUND');
      for (const id of ['nope', 'x'.repeat(3000), "1' OR '1'='1", '😀']) {
        const r = await request(http)
          .get(`/api/v1/events/${encodeURIComponent(id)}`)
          .set(auth(owner.token));
        expect(r.status).toBe(404);
      }
    });

    it('详情：payload 原样（含未知字段与嵌套）、media 为空数组、summary 是兜底文案', async () => {
      const eventId = `edge_detail_${run}`;
      const payload = {
        riskLevel: 'medium',
        direction: 'left',
        objectType: 'kangaroo',
        nested: { a: [1, { b: '中文😀' }] },
      };
      await relay(http, owner.token, d1, [
        envelope(d1, 'collision_risk', payload, { eventId }),
      ]).expect(202);
      const r = await request(http)
        .get(`/api/v1/events/${eventId}`)
        .set(auth(owner.token))
        .expect(200);
      expect(r.body.payload).toEqual(payload);
      expect(r.body.media).toEqual([]);
      expect(r.body.summary).toBe('碰撞风险 medium（left）');
    });
  });
});
