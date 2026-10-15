// 2026-10-16 边界测试：轨迹 / 区间统计 / 抽稀轨迹 / 行程（API.md §5）。
// 时间范围的「正好等于 / 差 1 ms」、端点开闭、抽稀参数、绑定区间对四个查询的作用。
// 点直接写表（timestamp 精确可控；receivedAt 默认 now()，落在绑定区间内）。
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
  provisionDevice,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('边界：轨迹与行程查询 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let owner: TestUser;
  let other: TestUser;
  const run = Date.now();
  const dev = `edge_loc_${run}`;
  const devRide = `edge_loc_ride_${run}`;
  const devScope = `edge_loc_scope_${run}`;
  const devEmpty = `edge_loc_empty_${run}`;
  const devMonth = `edge_loc_month_${run}`;
  /** 固定在过去整点的锚：避开「最新」类查询对未来点的过滤 */
  const T0 = Math.floor((Date.now() - 3 * DAY) / HOUR) * HOUR;

  const point = (deviceId: string, i: number, at: number, extra = {}) => ({
    eventId: `${deviceId}_${i}`,
    deviceId,
    timestamp: new Date(at),
    latitude: 30 + i * 0.001,
    longitude: 120,
    coordinateSystem: 'wgs84',
    accuracy: 5,
    speed: 3,
    heading: 0,
    ...extra,
  });
  const get = (
    path: string,
    query: Record<string, string>,
    token = owner.token,
  ) =>
    request(http).get(`/api/v1/devices/${path}`).query(query).set(auth(token));

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    owner = await createUser(app, http);
    other = await createUser(app, http);
    for (const d of [dev, devRide, devScope, devEmpty, devMonth]) {
      await provisionDevice(prisma, d);
      await bindDevice(http, owner.token, d);
    }
    // dev：T0 起每 10 分钟一点，共 7 点（T0 … T0+60min）
    await prisma.locationPoint.createMany({
      data: Array.from({ length: 7 }, (_, i) =>
        point(dev, i, T0 + i * 10 * MIN),
      ),
    });
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [dev, devRide, devScope, devEmpty, devMonth]);
    await cleanupUsers(prisma, [owner, other]);
    await app.close();
  });

  describe('24 小时上限（轨迹 / 统计 / 抽稀轨迹同口径）', () => {
    it('恰好 24h → 200；24h + 1 ms → 400；from = to → 400；from > to → 400', async () => {
      for (const path of [
        `${dev}/locations`,
        `${dev}/locations/summary`,
        `${dev}/locations/track`,
      ]) {
        expect(
          (await get(path, { from: iso(T0), to: iso(T0 + DAY) })).status,
        ).toBe(200);
        const over = await get(path, { from: iso(T0), to: iso(T0 + DAY + 1) });
        expect(over.status).toBe(400);
        expect(over.body.code).toBe('VALIDATION_FAILED');
        expect((await get(path, { from: iso(T0), to: iso(T0) })).status).toBe(
          400,
        );
        expect(
          (await get(path, { from: iso(T0 + 1), to: iso(T0) })).status,
        ).toBe(400);
      }
    });

    it('毫秒精度的端点：from / to 带 .999 也按毫秒算跨度（23:59:59.999 + 1 ms 正好 24h）', async () => {
      const from = '2026-10-01T00:00:00.000Z';
      expect(
        (
          await get(`${dev}/locations/summary`, {
            from,
            to: '2026-10-02T00:00:00.000Z',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await get(`${dev}/locations/summary`, {
            from,
            to: '2026-10-02T00:00:00.001Z',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await get(`${dev}/locations/summary`, {
            from: '2026-09-30T23:59:59.999Z',
            to: '2026-10-01T23:59:59.999Z',
          })
        ).status,
      ).toBe(200);
    });

    it('时区偏移写法：+08:00 与 Z 等价换算，跨度按绝对时间算（+08:00 的 24h 窗口不因写法变成 32h）', async () => {
      const r = await get(`${dev}/locations`, {
        from: '2026-10-01T08:00:00+08:00',
        to: '2026-10-02T08:00:00+08:00',
      });
      expect(r.status).toBe(200);
      const over = await get(`${dev}/locations`, {
        from: '2026-10-01T00:00:00+08:00',
        to: '2026-10-02T00:00:00Z',
      });
      expect(over.status).toBe(400);
    });

    it('缺时区（2026-10-01T00:00:00）与只有日期（2026-10-01）也被接受：按服务器本地时区解析（文档写 UTC，未写拒收，按现状）', async () => {
      expect(
        (
          await get(`${dev}/locations`, {
            from: '2026-10-01T00:00:00',
            to: '2026-10-01T10:00:00',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await get(`${dev}/locations`, {
            from: '2026-10-01',
            to: '2026-10-02',
          })
        ).status,
      ).toBe(200);
    });

    it('非法时间：周 / 序数日期、闰秒 60、02-30、小写 t/z、负年份、空串、重复参数 → 400，不 500', async () => {
      const bad: Array<[string, string]> = [
        ['2026-W40', '2026-W41'],
        ['2026-274', '2026-275'],
        ['2026-10-01T23:59:60Z', '2026-10-02T00:00:00Z'],
        ['2026-02-30T00:00:00Z', '2026-03-01T00:00:00Z'],
        ['2026-10-01t00:00:00z', '2026-10-01t01:00:00z'],
        ['-2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z'],
        ['', '2026-10-01T01:00:00Z'],
      ];
      for (const [from, to] of bad) {
        const r = await get(`${dev}/locations`, { from, to });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      const dup = await request(http)
        .get(
          `/api/v1/devices/${dev}/locations?from=${iso(T0)}&from=${iso(T0 + 1)}&to=${iso(T0 + HOUR)}`,
        )
        .set(auth(owner.token));
      expect(dup.status).toBe(400);
    });
  });

  describe('端点开闭与分页', () => {
    it('轨迹分页：from / to 两端闭区间——正好落在 from 和 to 上的点都在结果里', async () => {
      const r = await get(`${dev}/locations`, {
        from: iso(T0 + 10 * MIN),
        to: iso(T0 + 30 * MIN),
      }).expect(200);
      expect(
        r.body.items.map((p: { timestamp: string }) => p.timestamp),
      ).toEqual([iso(T0 + 10 * MIN), iso(T0 + 20 * MIN), iso(T0 + 30 * MIN)]);
      // 往里收 1 ms，两端的点就都不在了
      const inner = await get(`${dev}/locations`, {
        from: iso(T0 + 10 * MIN + 1),
        to: iso(T0 + 30 * MIN - 1),
      }).expect(200);
      expect(inner.body.total).toBe(1);
    });

    it('pageSize=100 可用、101 → 400；page 超出总页数 → 200 空 items、total 不变', async () => {
      const q = { from: iso(T0), to: iso(T0 + DAY) };
      const p100 = await get(`${dev}/locations`, { ...q, pageSize: '100' });
      expect(p100.status).toBe(200);
      expect(p100.body.items).toHaveLength(7);
      expect(
        (await get(`${dev}/locations`, { ...q, pageSize: '101' })).status,
      ).toBe(400);
      const beyond = await get(`${dev}/locations`, {
        ...q,
        page: '5',
        pageSize: '2',
      });
      expect(beyond.status).toBe(200);
      expect(beyond.body).toMatchObject({
        items: [],
        total: 7,
        page: 5,
        pageSize: 2,
      });
      // 末页条数 = total - (页数 - 1) × pageSize
      const last = await get(`${dev}/locations`, {
        ...q,
        page: '4',
        pageSize: '2',
      });
      expect(last.body.items).toHaveLength(1);
    });
  });

  describe('抽稀轨迹 maxPoints', () => {
    it('maxPoints=2 → 只剩首尾两点；total 仍是全量、summary 用全部点算', async () => {
      const r = await get(`${dev}/locations/track`, {
        from: iso(T0),
        to: iso(T0 + DAY),
        maxPoints: '2',
      }).expect(200);
      expect(
        r.body.points.map((p: { timestamp: string }) => p.timestamp),
      ).toEqual([iso(T0), iso(T0 + 60 * MIN)]);
      expect(r.body.total).toBe(7);
      expect(r.body.summary.pointCount).toBe(7);
    });

    it('maxPoints ≥ 点数 → 原样全部返回；2000 上限可用', async () => {
      for (const maxPoints of ['7', '8', '2000']) {
        const r = await get(`${dev}/locations/track`, {
          from: iso(T0),
          to: iso(T0 + DAY),
          maxPoints,
        }).expect(200);
        expect(r.body.points).toHaveLength(7);
      }
    });

    it('maxPoints：1 / 0 / -1 / 2001 / 2.5 / abc / 空串 → 400', async () => {
      for (const maxPoints of ['1', '0', '-1', '2001', '2.5', 'abc', '']) {
        const r = await get(`${dev}/locations/track`, {
          from: iso(T0),
          to: iso(T0 + DAY),
          maxPoints,
        });
        expect(r.status).toBe(400);
      }
    });

    it('范围内没有点：points 空、total 0、summary 全零与 null', async () => {
      const r = await get(`${devEmpty}/locations/track`, {
        from: iso(T0),
        to: iso(T0 + HOUR),
      }).expect(200);
      expect(r.body).toEqual({
        points: [],
        total: 0,
        summary: {
          distanceMeters: 0,
          movingSeconds: 0,
          maxSpeed: null,
          pointCount: 0,
          firstAt: null,
          lastAt: null,
        },
      });
    });

    it('只有一个点：距离 0、移动 0 秒、firstAt = lastAt、maxSpeed 取该点速度', async () => {
      const r = await get(`${dev}/locations/summary`, {
        from: iso(T0 + 30 * MIN),
        to: iso(T0 + 31 * MIN),
      }).expect(200);
      expect(r.body).toMatchObject({
        distanceMeters: 0,
        movingSeconds: 0,
        pointCount: 1,
        maxSpeed: 3,
        firstAt: iso(T0 + 30 * MIN),
        lastAt: iso(T0 + 30 * MIN),
      });
    });
  });

  describe('行程列表 [from, to) 归属', () => {
    // devRide：两趟，每趟 1 分钟一个点、各 10 点、纬度每步 0.001°（约 111 m，约 1.85 m/s）
    const rideA = T0 + 2 * HOUR;
    const rideB = T0 + 5 * HOUR;
    beforeAll(async () => {
      await prisma.locationPoint.createMany({
        data: [
          ...Array.from({ length: 10 }, (_, i) =>
            point(devRide, i, rideA + i * MIN),
          ),
          ...Array.from({ length: 10 }, (_, i) =>
            point(devRide, 100 + i, rideB + i * MIN),
          ),
        ],
      });
    });
    const rides = (from: number, to: number) =>
      get(`${devRide}/rides`, { from: iso(from), to: iso(to) });

    it('起点正好等于 from → 归这一窗；起点正好等于 to → 不归这一窗，归下一窗（左闭右开）', async () => {
      const a = await rides(rideA, rideB).expect(200);
      expect(a.body.rides.map((x: { startAt: string }) => x.startAt)).toEqual([
        iso(rideA),
      ]);
      const b = await rides(rideB, rideB + HOUR).expect(200);
      expect(b.body.rides.map((x: { startAt: string }) => x.startAt)).toEqual([
        iso(rideB),
      ]);
      // 两窗拼起来不重不漏
      const all = await rides(rideA - HOUR, rideB + HOUR).expect(200);
      expect(all.body.rides.map((x: { startAt: string }) => x.startAt)).toEqual(
        [iso(rideB), iso(rideA)],
      );
    });

    it('起点在 from 之前 1 ms 的那趟不出现，哪怕它大部分在窗口里', async () => {
      const r = await rides(rideA + 1, rideA + HOUR).expect(200);
      expect(r.body.rides).toEqual([]);
    });

    it('范围恰好 32 天 → 200；32 天 + 1 ms → 400；from = to → 400', async () => {
      expect((await rides(T0 - 30 * DAY, T0 + 2 * DAY)).status).toBe(200);
      expect((await rides(T0 - 30 * DAY, T0 + 2 * DAY + 1)).status).toBe(400);
      expect((await rides(T0, T0)).status).toBe(400);
    });

    it('远古 / 未来窗口：1970 年与 9999 年 → 200 空列表，不 500', async () => {
      const r1 = await get(`${devRide}/rides`, {
        from: '1970-01-01T00:00:00Z',
        to: '1970-01-31T00:00:00Z',
      });
      expect(r1.status).toBe(200);
      expect(r1.body.rides).toEqual([]);
      const r2 = await get(`${devRide}/rides`, {
        from: '9999-12-01T00:00:00Z',
        to: '9999-12-31T23:59:59Z',
      });
      expect(r2.status).toBe(200);
      expect(r2.body.rides).toEqual([]);
      const t = await get(`${devRide}/locations/track`, {
        from: '9999-12-31T00:00:00Z',
        to: '9999-12-31T23:59:59Z',
      });
      expect(t.status).toBe(200);
    });
  });

  describe('跨日 / 跨月（App 按北京时间零点切窗口）', () => {
    // 北京时间 9 月 30 日 23:50 出发、10 月 1 日 00:20 到（UTC 15:50 → 16:20），每分钟一点、约 1.85 m/s
    const start = Date.parse('2026-09-30T15:50:00Z');
    beforeAll(async () => {
      await prisma.locationPoint.createMany({
        data: Array.from({ length: 31 }, (_, i) =>
          point(devMonth, i, start + i * MIN),
        ),
      });
    });
    const sep = {
      from: '2026-09-01T00:00:00+08:00',
      to: '2026-10-01T00:00:00+08:00',
    };
    const oct = {
      from: '2026-10-01T00:00:00+08:00',
      to: '2026-11-01T00:00:00+08:00',
    };

    it('跨月那一趟整趟归 9 月（起点所在的窗口），10 月的窗口里没有它；endAt 在 10 月也照算完整', async () => {
      const s = await get(`${devMonth}/rides`, sep).expect(200);
      expect(s.body.rides).toHaveLength(1);
      expect(s.body.rides[0].startAt).toBe(iso(start));
      expect(s.body.rides[0].endAt).toBe(iso(start + 30 * MIN));
      expect(s.body.rides[0].movingSeconds).toBe(30 * 60);
      const o = await get(`${devMonth}/rides`, oct).expect(200);
      expect(o.body.rides).toEqual([]);
    });

    it('按北京时间零点切的单日统计：9 月 30 日只算 23:50–24:00 的 11 个点，10 月 1 日算 00:00–00:20 的 21 个点（零点那个点两边都算，闭区间）', async () => {
      const d30 = await get(`${devMonth}/locations/summary`, {
        from: '2026-09-30T00:00:00+08:00',
        to: '2026-10-01T00:00:00+08:00',
      }).expect(200);
      const d01 = await get(`${devMonth}/locations/summary`, {
        from: '2026-10-01T00:00:00+08:00',
        to: '2026-10-02T00:00:00+08:00',
      }).expect(200);
      expect(d30.body.pointCount).toBe(11);
      expect(d01.body.pointCount).toBe(21);
      expect(d30.body.lastAt).toBe(d01.body.firstAt);
    });
  });

  describe('绑定区间（决策 #39）对统计 / 抽稀 / 行程同样生效', () => {
    it('receivedAt 早于本人 boundAt 的点：summary / track / rides / 分页 / latest 一律看不到', async () => {
      const binding = await prisma.deviceBinding.findFirstOrThrow({
        where: { deviceId: devScope, userId: owner.id, unboundAt: null },
      });
      const before = new Date(binding.boundAt.getTime() - 1000);
      await prisma.locationPoint.createMany({
        data: Array.from({ length: 10 }, (_, i) => ({
          ...point(devScope, i, T0 + i * MIN),
          receivedAt: before,
        })),
      });
      const q = { from: iso(T0 - HOUR), to: iso(T0 + 20 * HOUR) };
      const s = await get(`${devScope}/locations/summary`, q).expect(200);
      expect(s.body.pointCount).toBe(0);
      const t = await get(`${devScope}/locations/track`, q).expect(200);
      expect(t.body.total).toBe(0);
      const l = await get(`${devScope}/locations`, q).expect(200);
      expect(l.body.total).toBe(0);
      const r = await get(`${devScope}/rides`, q).expect(200);
      expect(r.body.rides).toEqual([]);
      const latest = await request(http)
        .get(`/api/v1/devices/${devScope}/locations/latest`)
        .set(auth(owner.token))
        .expect(200);
      expect(latest.body.location).toBeNull();
    });

    it('非本人：四个查询 + latest 一律 404 DEVICE_NOT_FOUND', async () => {
      const q = { from: iso(T0), to: iso(T0 + HOUR) };
      for (const path of [
        `${dev}/locations`,
        `${dev}/locations/summary`,
        `${dev}/locations/track`,
        `${dev}/rides`,
        `${dev}/locations/latest`,
      ]) {
        const r = await get(path, q, other.token);
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('DEVICE_NOT_FOUND');
      }
    });
  });

  describe('最新位置', () => {
    it('精确 (0,0) 的点照常入轨迹表并成为「最新位置」（F15：App 侧已把 (0,0) 当无位置；后端文档未写，按现状）', async () => {
      await prisma.locationPoint.create({
        data: point(devEmpty, 900, Date.now() - MIN, {
          latitude: 0,
          longitude: 0,
        }),
      });
      const r = await request(http)
        .get(`/api/v1/devices/${devEmpty}/locations/latest`)
        .set(auth(owner.token))
        .expect(200);
      expect(r.body.location).toMatchObject({ latitude: 0, longitude: 0 });
    });

    it('设备时间超前 4 分钟（阈值内）的点参与最新；超前 6 分钟的点不参与（但按范围仍可查到）', async () => {
      const now = Date.now();
      await prisma.locationPoint.createMany({
        data: [
          point(devEmpty, 901, now + 4 * MIN, { latitude: 31 }),
          point(devEmpty, 902, now + 6 * MIN, { latitude: 32 }),
        ],
      });
      const r = await request(http)
        .get(`/api/v1/devices/${devEmpty}/locations/latest`)
        .set(auth(owner.token))
        .expect(200);
      expect(r.body.location.latitude).toBe(31);
      const range = await get(`${devEmpty}/locations`, {
        from: iso(now),
        to: iso(now + HOUR),
      }).expect(200);
      expect(
        range.body.items.map((p: { latitude: number }) => p.latitude),
      ).toEqual([31, 32]);
    });
  });
});
