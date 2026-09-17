// API.md §5 区间统计：里程/移动时长/最高速；范围校验与归属校验同 locations
import { INestApplication } from '@nestjs/common';
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

describe('GET /devices/:id/locations/summary (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  const deviceId = `sum_${Date.now()}`;
  let owner: TestUser;
  let other: TestUser;
  const base = Date.now() - 60_000;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    ingest = app.get(IngestService);
    owner = await createUser(app, http);
    other = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, owner.token, deviceId);
    // 6 个点、每 10 s 一个、纬度每步 ≈ 11 m（0.0001°），速度 3.2 m/s；最后一点速度 8
    for (let i = 0; i < 6; i++) {
      await ingest.ingestRaw(
        JSON.stringify(
          envelope(
            deviceId,
            'location_update',
            { ...validLocation(i), speed: i === 5 ? 8 : 3.2 },
            { timestamp: new Date(base + i * 10_000).toISOString() },
          ),
        ),
        deviceId,
        'app_relay',
      );
    }
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId]);
    await cleanupUsers(prisma, [owner, other]);
    await app.close();
  });

  const from = new Date(base - 1000).toISOString();
  const to = new Date(base + 100_000).toISOString();

  it('aggregates distance / moving time / max speed over the range', async () => {
    const res = await request(http)
      .get(
        `/api/v1/devices/${deviceId}/locations/summary?from=${from}&to=${to}`,
      )
      .set(auth(owner.token))
      .expect(200);
    expect(res.body.pointCount).toBe(6);
    // 5 段 × ~15.7 m（纬经各 0.0001°）≈ 78 m
    expect(res.body.distanceMeters).toBeGreaterThan(60);
    expect(res.body.distanceMeters).toBeLessThan(100);
    expect(res.body.movingSeconds).toBe(50);
    expect(res.body.maxSpeed).toBe(8);
    expect(res.body.firstAt).toBe(new Date(base).toISOString());
    expect(res.body.lastAt).toBe(new Date(base + 50_000).toISOString());
  });

  it('returns zeros/nulls for an empty range', async () => {
    const res = await request(http)
      .get(
        `/api/v1/devices/${deviceId}/locations/summary?from=${new Date(base + 200_000).toISOString()}&to=${new Date(base + 300_000).toISOString()}`,
      )
      .set(auth(owner.token))
      .expect(200);
    expect(res.body).toEqual({
      distanceMeters: 0,
      movingSeconds: 0,
      maxSpeed: null,
      pointCount: 0,
      firstAt: null,
      lastAt: null,
    });
  });

  it('rejects ranges over 24h and non-owners', async () => {
    await request(http)
      .get(
        `/api/v1/devices/${deviceId}/locations/summary?from=${new Date(base - 30 * 3_600_000).toISOString()}&to=${to}`,
      )
      .set(auth(owner.token))
      .expect(400);
    await request(http)
      .get(
        `/api/v1/devices/${deviceId}/locations/summary?from=${from}&to=${to}`,
      )
      .set(auth(other.token))
      .expect(404);
  });
});
