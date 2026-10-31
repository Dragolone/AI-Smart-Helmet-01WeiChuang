// 位置查询服务（API.md §5）：最新位置上界、24h / 32 天范围校验、绑定区间、抽稀与统计、行程列表的边界归属。
import { BindingScopeService } from '../devices/binding-scope.service';
import type { PrismaService } from '../prisma/prisma.service';
import { LocationsService, RIDES_BATCH_SIZE } from './locations.service';

const H = 3_600_000;
const T0 = Date.parse('2026-10-16T00:00:00Z');
const dbPoint = (i: number, atMs: number, meters = i * 50) => ({
  id: `p${i}`,
  eventId: `e${i}`,
  deviceId: 'helmet_001',
  latitude: 22.5 + (meters / 100) * 0.0009,
  longitude: 114,
  coordinateSystem: 'gcj02',
  accuracy: 5,
  speed: 5,
  heading: 0,
  altitude: null,
  timestamp: new Date(atMs),
  receivedAt: new Date(atMs + 1000),
});

type Where = Record<string, any>;
const cmp = (a: Date | string, b: Date | string) =>
  a instanceof Date
    ? a.getTime() - (b as Date).getTime()
    : a < b
      ? -1
      : a > b
        ? 1
        : 0;
/** 够用的 Prisma where 求值：AND / OR / deviceId 相等 / 字段的 gte gt lte lt；认不得的运算符一律不匹配，让测试大声失败 */
const matches = (row: Where, w: Where): boolean =>
  Object.entries(w).every(([k, v]) => {
    if (k === 'AND')
      return ((Array.isArray(v) ? v : [v]) as Where[]).every((x) =>
        matches(row, x),
      );
    if (k === 'OR') return (v as Where[]).some((x) => matches(row, x));
    if (k === 'deviceId') return row.deviceId === v;
    return Object.entries(v as Record<string, Date | string>).every(
      ([op, bound]) => {
        const c = cmp(row[k] as Date | string, bound);
        return op === 'gte'
          ? c >= 0
          : op === 'gt'
            ? c > 0
            : op === 'lte'
              ? c <= 0
              : op === 'lt'
                ? c < 0
                : false;
      },
    );
  });

describe('LocationsService', () => {
  const prisma = {
    deviceBinding: { findMany: jest.fn() },
    locationPoint: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const svc = new LocationsService(
    prisma as unknown as PrismaService,
    new BindingScopeService(prisma as unknown as PrismaService),
  );
  const boundAt = new Date('2026-10-01T00:00:00Z');

  beforeEach(() => {
    jest.useRealTimers();
    for (const fn of [
      prisma.deviceBinding.findMany,
      ...Object.values(prisma.locationPoint),
    ])
      fn.mockReset();
    prisma.deviceBinding.findMany.mockResolvedValue([
      { boundAt, unboundAt: null },
    ]);
    prisma.locationPoint.findMany.mockResolvedValue([]);
  });
  afterAll(() => jest.useRealTimers());

  const findManyArg = (n = 0) =>
    (prisma.locationPoint.findMany.mock.calls[n] as [Record<string, any>])[0];

  describe('latest', () => {
    it('时间上界 = 现在 + 5 分钟（时钟跑到未来的点不算最新），按时间 + id 倒序取一条', async () => {
      jest.useFakeTimers({ now: T0 });
      prisma.locationPoint.findFirst.mockResolvedValue(dbPoint(1, T0 - 1000));
      const res = await svc.latest('u1', 'helmet_001');
      expect(res.location).toMatchObject({ coordinateSystem: 'gcj02' });
      expect(prisma.locationPoint.findFirst).toHaveBeenCalledWith({
        where: {
          deviceId: 'helmet_001',
          timestamp: { lte: new Date(T0 + 5 * 60_000) },
          AND: [{ OR: [{ receivedAt: { gte: boundAt } }] }],
        },
        orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      });
    });

    it('没有点：location=null', async () => {
      prisma.locationPoint.findFirst.mockResolvedValue(null);
      await expect(svc.latest('u1', 'helmet_001')).resolves.toEqual({
        location: null,
      });
    });
  });

  describe('范围校验（summary / track / list 共用 24h 上限）', () => {
    it.each([
      [
        'from = to',
        '2026-10-16T00:00:00Z',
        '2026-10-16T00:00:00Z',
        'from 必须早于 to',
      ],
      [
        'from 晚于 to',
        '2026-10-16T01:00:00Z',
        '2026-10-16T00:00:00Z',
        'from 必须早于 to',
      ],
      [
        '超过 24 小时 1 毫秒',
        '2026-10-15T00:00:00.000Z',
        '2026-10-16T00:00:00.001Z',
        '单次查询时间范围不能超过 24 小时',
      ],
    ])('%s：400', async (_n, from, to, message) => {
      await expect(
        svc.summaryRange('u1', 'helmet_001', from, to),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'VALIDATION_FAILED', message },
      });
      await expect(
        svc.track('u1', 'helmet_001', from, to, 100),
      ).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.locationPoint.findMany).not.toHaveBeenCalled();
    });

    it('恰好 24 小时：允许', async () => {
      await expect(
        svc.summaryRange(
          'u1',
          'helmet_001',
          '2026-10-15T00:00:00Z',
          '2026-10-16T00:00:00Z',
        ),
      ).resolves.toMatchObject({ pointCount: 0, firstAt: null, lastAt: null });
    });
  });

  describe('summary / track / listRange', () => {
    it('summary：只取统计要的四列，统计结果时间转 ISO', async () => {
      prisma.locationPoint.findMany.mockResolvedValue([
        dbPoint(0, T0),
        dbPoint(1, T0 + 10_000),
      ]);
      const s = await svc.summaryRange(
        'u1',
        'helmet_001',
        '2026-10-16T00:00:00Z',
        '2026-10-16T01:00:00Z',
      );
      expect(findManyArg().select).toEqual({
        latitude: true,
        longitude: true,
        speed: true,
        timestamp: true,
      });
      expect(s).toMatchObject({
        pointCount: 2,
        firstAt: '2026-10-16T00:00:00.000Z',
        lastAt: '2026-10-16T00:00:10.000Z',
      });
      expect(s.distanceMeters).toBeGreaterThan(40);
    });

    it('track：抽稀到 maxPoints（首尾保留），total 与统计用全部点', async () => {
      const pts = Array.from({ length: 10 }, (_, i) =>
        dbPoint(i, T0 + i * 10_000),
      );
      prisma.locationPoint.findMany.mockResolvedValue(pts);
      const t = await svc.track(
        'u1',
        'helmet_001',
        '2026-10-16T00:00:00Z',
        '2026-10-16T01:00:00Z',
        3,
      );
      expect(t.total).toBe(10);
      expect(t.points).toHaveLength(3);
      expect(t.points[0].timestamp).toBe(pts[0].timestamp.toISOString());
      expect(t.points[2].timestamp).toBe(pts[9].timestamp.toISOString());
      expect(t.summary.pointCount).toBe(10);
    });

    it('listRange：时间正序 + id 兜底，按页跳过', async () => {
      prisma.locationPoint.count.mockResolvedValue(150);
      prisma.locationPoint.findMany.mockResolvedValue([dbPoint(0, T0)]);
      const r = await svc.listRange(
        'u1',
        'helmet_001',
        '2026-10-16T00:00:00Z',
        '2026-10-16T01:00:00Z',
        2,
        100,
      );
      expect(r).toMatchObject({ total: 150, page: 2, pageSize: 100 });
      expect(findManyArg()).toMatchObject({
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
        skip: 100,
        take: 100,
      });
    });
  });

  describe('rides', () => {
    it.each([
      [
        'from = to',
        '2026-10-01T00:00:00Z',
        '2026-10-01T00:00:00Z',
        'from 必须早于 to',
      ],
      [
        '超过 32 天',
        '2026-10-01T00:00:00Z',
        '2026-11-02T00:00:01Z',
        '单次查询时间范围不能超过 32 天',
      ],
    ])('%s：400', async (_n, from, to, message) => {
      await expect(
        svc.rides('u1', 'helmet_001', from, to),
      ).rejects.toMatchObject({
        response: { message },
      });
    });

    it('取数窗口：from 往前 24 小时；往后 48 小时但不超过「现在 + 5 分钟」', async () => {
      jest.useFakeTimers({ now: Date.parse('2026-10-16T12:00:00Z') });
      await svc.rides(
        'u1',
        'helmet_001',
        '2026-10-16T00:00:00Z',
        '2026-10-17T00:00:00Z',
      );
      expect(findManyArg().where.timestamp).toEqual({
        gte: new Date('2026-10-15T00:00:00Z'),
        lte: new Date('2026-10-16T12:05:00Z'),
      });
      prisma.locationPoint.findMany.mockClear();
      await svc.rides(
        'u1',
        'helmet_001',
        '2026-09-01T00:00:00Z',
        '2026-09-02T00:00:00Z',
      );
      expect(findManyArg().where.timestamp.lte).toEqual(
        new Date('2026-09-04T00:00:00Z'),
      );
    });

    it('只留起点在 [from, to) 内、里程 ≥ 50 m 的行程，最新在前', async () => {
      jest.useFakeTimers({ now: Date.parse('2026-10-20T00:00:00Z') });
      const ride = (startMs: number, n: number, offset: number) =>
        Array.from({ length: n }, (_, i) =>
          dbPoint(offset + i, startMs + i * 10_000, i * 50),
        );
      const before = ride(T0 - 2 * H, 6, 0); // 起点在 from 之前：不算
      const a = ride(T0 + 1 * H, 6, 10); // 250 m
      const tiny = ride(T0 + 3 * H, 2, 20).map((p, i) => ({
        ...p,
        latitude: 22.5 + i * 0.0001, // ≈ 11 m，不到 50 m
      }));
      const b = ride(T0 + 5 * H, 6, 30);
      const after = ride(T0 + 25 * H, 6, 40); // 起点在 to 之后：不算
      prisma.locationPoint.findMany.mockResolvedValue([
        ...before,
        ...a,
        ...tiny,
        ...b,
        ...after,
      ]);
      const { rides } = await svc.rides(
        'u1',
        'helmet_001',
        new Date(T0).toISOString(),
        new Date(T0 + 24 * H).toISOString(),
      );
      expect(rides.map((r) => r.startAt)).toEqual([
        new Date(T0 + 5 * H).toISOString(),
        new Date(T0 + 1 * H).toISOString(),
      ]);
      expect(rides.every((r) => !r.ongoing)).toBe(true);
      expect(rides[0].distanceMeters).toBeGreaterThanOrEqual(50);
    });
  });
  describe('rides 分批取点（按 (timestamp, id) 键集翻页）', () => {
    const base = { deviceId: 'helmet_001', timestamp: { gte: new Date(0) } };
    type Row = ReturnType<typeof dbPoint>;
    // 真实 id 是 cuid：和时间先后无关。用 65537（素数）取模打乱，保证唯一又不随时间递增
    const row = (i: number, atMs: number): Row => ({
      ...dbPoint(i, atMs),
      id: `p${String((i * 48271) % 65537).padStart(6, '0')}`,
    });
    /** 假库：按 where 过滤、按 (timestamp, id) 排序、取 take 条；honorTake=false 时一次返回全部 */
    const fakeDb = (rows: Row[], honorTake = true) =>
      prisma.locationPoint.findMany.mockImplementation(
        (args: { where: Where; orderBy: unknown; take?: number }) => {
          expect(args.orderBy).toEqual([{ timestamp: 'asc' }, { id: 'asc' }]);
          const hit = rows
            .filter((r) => matches(r, args.where))
            .sort((a, b) => cmp(a.timestamp, b.timestamp) || cmp(a.id, b.id));
          return Promise.resolve(honorTake ? hit.slice(0, args.take) : hit);
        },
      );
    const ridePoints = (batchSize: number) =>
      (
        svc as unknown as {
          ridePoints: (w: Where, n: number) => Promise<Row[]>;
        }
      ).ridePoints(base, batchSize);

    // 10 个点：0-1 同刻，2-6 同刻（5 个并列），7-9 各自一刻——任何批大小都有一批断在并列中间
    const rows = [0, 0, 1, 1, 1, 1, 1, 2, 3, 4]
      .map((t, i) => row(i, T0 + t * 10_000))
      .sort((a, b) => cmp(a.timestamp, b.timestamp) || cmp(a.id, b.id));

    it.each([1, 2, 3, 4, 5, 6, 7, 9, 10, 11])(
      '批大小 %i：同一时间戳跨批不重不漏，顺序与单次查询一致',
      async (n) => {
        fakeDb(rows);
        const got = await ridePoints(n);
        expect(got.map((p) => p.id)).toEqual(rows.map((r) => r.id));
      },
    );

    it('第二批的条件：时间 ≥ 上批末点，且（时间更晚 或 同刻 id 更大）；不用 cursor / skip', async () => {
      fakeDb(rows);
      await ridePoints(4);
      expect(prisma.locationPoint.findMany).toHaveBeenCalledTimes(3);
      const [first, second] = prisma.locationPoint.findMany.mock.calls.map(
        (c) => c[0] as Where,
      );
      expect(first.where).toBe(base);
      expect(first.take).toBe(4);
      const last = rows[3]; // 第一批在 5 个并列点的中间断开
      expect(second.where).toEqual({
        AND: [
          base,
          { timestamp: { gte: last.timestamp } },
          {
            OR: [
              { timestamp: { gt: last.timestamp } },
              { id: { gt: last.id } },
            ],
          },
        ],
      });
      expect(second.take).toBe(4);
      for (const arg of [first, second]) {
        expect(arg.cursor).toBeUndefined();
        expect(arg.skip).toBeUndefined();
      }
    });

    it('少于一批：只发 1 个查询', async () => {
      fakeDb(rows.slice(0, 3));
      await expect(ridePoints(4)).resolves.toHaveLength(3);
      expect(prisma.locationPoint.findMany).toHaveBeenCalledTimes(1);
    });

    it('恰好整批：再发 1 个查询确认到头，结果不多不少', async () => {
      fakeDb(rows.slice(0, 8));
      await expect(ridePoints(4)).resolves.toHaveLength(8);
      expect(prisma.locationPoint.findMany).toHaveBeenCalledTimes(3);
    });

    it('空结果：1 个查询，返回空数组', async () => {
      fakeDb([]);
      await expect(ridePoints(4)).resolves.toEqual([]);
      expect(prisma.locationPoint.findMany).toHaveBeenCalledTimes(1);
    });

    it('rides()：每批 RIDES_BATCH_SIZE；跨批结果与一次取全的结果完全相同（含批界上的同刻点）', async () => {
      jest.useFakeTimers({ now: T0 + 60 * H });
      const n = 2 * RIDES_BATCH_SIZE + 5;
      // 每秒一点、每点约 22 m，中途断档 30 分钟 → 两趟；批界（第 RIDES_BATCH_SIZE 个点）前后 5 个点同一时刻
      const all = Array.from({ length: n }, (_, i) => {
        const gap = i >= n / 2 ? 30 * 60_000 : 0;
        const atMs =
          Math.abs(i - RIDES_BATCH_SIZE) <= 2
            ? T0 + H + (RIDES_BATCH_SIZE - 3) * 1000
            : T0 + H + i * 1000 + gap;
        return { ...row(i, atMs), latitude: 22.5 + i * 0.0002 };
      });
      const args = [
        'u1',
        'helmet_001',
        new Date(T0).toISOString(),
        new Date(T0 + 24 * H).toISOString(),
      ] as const;

      fakeDb(all);
      const batched = await svc.rides(...args);
      expect(prisma.locationPoint.findMany).toHaveBeenCalledTimes(3);
      expect(findManyArg().take).toBe(RIDES_BATCH_SIZE);

      prisma.locationPoint.findMany.mockReset();
      fakeDb(all, false);
      const single = await svc.rides(...args);
      expect(prisma.locationPoint.findMany).toHaveBeenCalledTimes(2);

      expect(batched.rides).toHaveLength(2);
      expect(JSON.stringify(batched)).toBe(JSON.stringify(single));
    });
  });
});
