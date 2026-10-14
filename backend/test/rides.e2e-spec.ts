// API.md §5 行程列表 + 抽稀轨迹：按「一趟」切分、跨查询边界的归属、范围校验与归属校验
import { INestApplication } from '@nestjs/common';
import type { RideSummary } from '@helmet/shared';
import request from 'supertest';
import { IngestService } from '../src/ingest/ingest.service';
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
  type Http,
  type TestUser,
  validLocation,
} from './helpers/hardening';

jest.setTimeout(60_000);

describe('GET /devices/:id/rides + /locations/track (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  const deviceId = `ride_${Date.now()}`;
  /** 不停地骑了 26 小时的那台（常驻模拟设备的样子），和上面那台分开，免得两边的点串在一起 */
  const loopDeviceId = `ride_loop_${Date.now()}`;
  let owner: TestUser;
  let other: TestUser;
  const MIN = 60_000;
  // 两趟：第一趟 3 小时前（已结束），第二趟刚刚（进行中）。中间隔了两个多小时没有点
  const firstAt = Date.now() - 180 * MIN;
  const secondAt = Date.now() - 2 * MIN;

  const ingestRide = async (
    startMs: number,
    points: number,
    offset: number,
  ) => {
    // 每 10 s 一个点，纬经各走 0.0001°（≈ 15.7 m，约 1.6 m/s）
    for (let i = 0; i < points; i++) {
      await ingest.ingestRaw(
        JSON.stringify(
          envelope(
            deviceId,
            'location_update',
            { ...validLocation(offset + i), speed: i === 3 ? 6 : 1.6 },
            { timestamp: new Date(startMs + i * 10_000).toISOString() },
          ),
        ),
        deviceId,
        'app_relay',
      );
    }
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    ingest = app.get(IngestService);
    owner = await createUser(app, http);
    other = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, owner.token, deviceId);
    await ingestRide(firstAt, 12, 0);
    await ingestRide(secondAt, 8, 100);

    await provisionDevice(prisma, loopDeviceId);
    await bindDevice(http, owner.token, loopDeviceId);
    // 26 小时前到 30 分钟前，每 60 s 一个点、每步纬度 0.001°（约 111 m）：直接写表，逐条走 Ingest 太慢
    const loopFrom = Date.now() - 26 * 60 * MIN;
    await prisma.locationPoint.createMany({
      data: Array.from({ length: 26 * 60 - 30 + 1 }, (_, i) => ({
        eventId: `${loopDeviceId}_${i}`,
        deviceId: loopDeviceId,
        timestamp: new Date(loopFrom + i * MIN),
        latitude: 22.5 + (i % 600) * 0.001,
        longitude: 114 + Math.floor(i / 600) * 0.001,
        coordinateSystem: 'wgs84',
        accuracy: 5,
        speed: 2.6,
        heading: 0,
      })),
    });
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId, loopDeviceId]);
    await cleanupUsers(prisma, [owner, other]);
    await app.close();
  });

  const iso = (ms: number) => new Date(ms).toISOString();
  const rides = (from: number, to: number, token = owner.token) =>
    request(http)
      .get(`/api/v1/devices/${deviceId}/rides?from=${iso(from)}&to=${iso(to)}`)
      .set(auth(token));

  it('lists rides newest first, with per-ride stats and the ongoing flag', async () => {
    const res = await rides(firstAt - 60 * MIN, Date.now() + MIN).expect(200);
    expect(res.body.rides).toHaveLength(2);
    const [latest, earlier] = res.body.rides;

    expect(latest.ongoing).toBe(true);
    expect(latest.startAt).toBe(iso(secondAt));
    expect(latest.endAt).toBe(iso(secondAt + 7 * 10_000));

    expect(earlier.ongoing).toBe(false);
    expect(earlier.startAt).toBe(iso(firstAt));
    expect(earlier.endAt).toBe(iso(firstAt + 11 * 10_000));
    // 11 段 × ~15.7 m ≈ 173 m
    expect(earlier.distanceMeters).toBeGreaterThan(150);
    expect(earlier.distanceMeters).toBeLessThan(200);
    expect(earlier.movingSeconds).toBe(110);
    expect(earlier.maxSpeed).toBe(6);
  });

  it('assigns a ride to the window that contains its start (no gaps, no duplicates when paging)', async () => {
    // 边界落在第一趟中间：它的起点在前一个区间里
    const boundary = firstAt + 50_000;
    const before = await rides(firstAt - 60 * MIN, boundary).expect(200);
    const after = await rides(boundary, Date.now() + MIN).expect(200);
    expect(
      before.body.rides.map((r: { startAt: string }) => r.startAt),
    ).toEqual([iso(firstAt)]);
    // 前一个区间里拿到的仍是完整的一趟，不是被边界截断的半趟
    expect(before.body.rides[0].endAt).toBe(iso(firstAt + 11 * 10_000));
    expect(after.body.rides.map((r: { startAt: string }) => r.startAt)).toEqual(
      [iso(secondAt)],
    );
  });

  it('returns an empty list when nothing started in the window', async () => {
    const res = await rides(firstAt - 300 * MIN, firstAt - 200 * MIN).expect(
      200,
    );
    expect(res.body).toEqual({ rides: [] });
  });

  it('rejects ranges over 32 days, reversed ranges and non-owners', async () => {
    await rides(Date.now() - 40 * 24 * 60 * MIN, Date.now()).expect(400);
    await rides(Date.now(), Date.now() - MIN).expect(400);
    await rides(firstAt - 60 * MIN, Date.now(), other.token).expect(404);
  });

  it('rejects ISO 8601 forms that Date cannot parse (week / ordinal / compact) with 400, not 500', async () => {
    const to = iso(Date.now());
    for (const bad of ['20261007', '2026-W41', '2026-280']) {
      for (const path of [
        `devices/${deviceId}/rides?from=${bad}&to=${to}`,
        `devices/${deviceId}/locations/track?from=${bad}&to=${to}`,
        `devices/${deviceId}/locations?from=${bad}&to=${to}`,
        `devices/${deviceId}/locations/summary?from=${bad}&to=${to}`,
        `devices/${deviceId}/events?from=${bad}`,
      ]) {
        const res = await request(http)
          .get(`/api/v1/${path}`)
          .set(auth(owner.token));
        expect([path, res.status, res.body.code]).toEqual([
          path,
          400,
          'VALIDATION_FAILED',
        ]);
      }
    }
  });

  it('cuts a ride that has been going for over 24h at `from`, so it still shows up in the current window', async () => {
    // 这一趟的起点在 26 小时前；不切的话它不属于 [2 小时前, 现在) 这个区间，列表是空的
    const from = Date.now() - 120 * MIN;
    const res = await request(http)
      .get(
        `/api/v1/devices/${loopDeviceId}/rides?from=${iso(from)}&to=${iso(Date.now() + MIN)}`,
      )
      .set(auth(owner.token))
      .expect(200);
    expect(res.body.rides).toHaveLength(1);
    const [ride] = res.body.rides as RideSummary[];
    const startMs = new Date(ride.startAt).getTime();
    // 新的一趟从 from 之后的第一个点开始
    expect(startMs).toBeGreaterThanOrEqual(from);
    expect(startMs).toBeLessThan(from + MIN);
    // 30 分钟前就停了：不是进行中
    expect(ride.ongoing).toBe(false);
    // 约 89 步 × 111 m ≈ 9.9 km
    expect(ride.distanceMeters).toBeGreaterThan(9_000);
    expect(ride.distanceMeters).toBeLessThan(11_000);
  });

  it('returns a thinned track with stats computed from every point', async () => {
    const from = iso(firstAt - 1000);
    const to = iso(firstAt + 200_000);
    const full = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations/track?from=${from}&to=${to}`)
      .set(auth(owner.token))
      .expect(200);
    expect(full.body.total).toBe(12);
    expect(full.body.points).toHaveLength(12);
    expect(full.body.summary.pointCount).toBe(12);

    const thinned = await request(http)
      .get(
        `/api/v1/devices/${deviceId}/locations/track?from=${from}&to=${to}&maxPoints=4`,
      )
      .set(auth(owner.token))
      .expect(200);
    expect(thinned.body.total).toBe(12);
    expect(thinned.body.points).toHaveLength(4);
    // 首尾保留
    expect(thinned.body.points[0].timestamp).toBe(iso(firstAt));
    expect(thinned.body.points[3].timestamp).toBe(iso(firstAt + 11 * 10_000));
    // 统计用的是全部 12 个点，和不抽稀时一样
    expect(thinned.body.summary).toEqual(full.body.summary);
  });

  it('validates maxPoints, the 24h cap and ownership on the track', async () => {
    const from = iso(firstAt - 1000);
    const to = iso(firstAt + 200_000);
    const track = (query: string, token = owner.token) =>
      request(http)
        .get(`/api/v1/devices/${deviceId}/locations/track?${query}`)
        .set(auth(token));
    await track(`from=${from}&to=${to}&maxPoints=1`).expect(400);
    await track(`from=${from}&to=${to}&maxPoints=5000`).expect(400);
    await track(`from=${iso(firstAt - 30 * 60 * MIN)}&to=${to}`).expect(400);
    await track(`from=${from}&to=${to}`, other.token).expect(404);
  });
});
