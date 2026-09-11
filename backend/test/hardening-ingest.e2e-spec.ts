// 上线前加固：统一 Ingest 入口（app-relay / webhook / 直接 ingestRaw）的边缘输入与并发。
// 原则：坏输入只能「留档 + 计数」，绝不能让接口 5xx；并发重复只存一次。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
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
  relay,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

describe('加固：Ingest 边缘输入与并发 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;

  const run = Date.now();
  const deviceId = `hard_ing_${run}`;
  const freshDevice = `hard_ing_fresh_${run}`;
  const unregistered = `hard_ing_unreg_${run}`;
  let owner: TestUser;
  let other: TestUser;
  const WEBHOOK_KEY = `wh_${run}`;

  beforeAll(async () => {
    process.env.SOS_COUNTDOWN_SECONDS = '600';
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    process.env.INGEST_WEBHOOK_API_KEY = WEBHOOK_KEY;
    ({ app, http, prisma } = await buildApp());
    ingest = app.get(IngestService);
    owner = await createUser(app, http);
    other = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
    await provisionDevice(prisma, freshDevice);
    await bindDevice(http, owner.token, deviceId);
    await bindDevice(http, owner.token, freshDevice);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId, freshDevice, unregistered]);
    await cleanupUsers(prisma, [owner, other]);
    await app.close();
  });

  describe('app-relay 入参护栏', () => {
    it('非对象 envelope 元素：全部按 invalid 计数，不 5xx', async () => {
      const res = await relay(http, owner.token, deviceId, [
        null,
        1,
        'str',
        [],
        {},
        { schemaVersion: 1 },
        true,
      ]).expect(202);
      expect(res.body).toEqual({ accepted: 0, duplicate: 0, invalid: 7 });
    });

    it('批量上限：101 条 400、0 条 400、非数组 400、缺 deviceId 400、deviceId 含斜杠 400', async () => {
      const many = Array.from({ length: 101 }, () =>
        envelope(deviceId, 'device_status', { battery: 50 }),
      );
      const r1 = await relay(http, owner.token, deviceId, many).expect(400);
      expect(r1.body.code).toBe('VALIDATION_FAILED');
      await relay(http, owner.token, deviceId, []).expect(400);
      await request(http)
        .post('/api/v1/ingest/app-relay')
        .set(auth(owner.token))
        .send({ deviceId, envelopes: 'x' })
        .expect(400);
      await request(http)
        .post('/api/v1/ingest/app-relay')
        .set(auth(owner.token))
        .send({ envelopes: [] })
        .expect(400);
      await relay(http, owner.token, `${deviceId}/x`, [
        envelope(deviceId, 'device_status', {}),
      ]).expect(400);
    });

    it('归属：非绑定用户 404、未注册设备 404', async () => {
      const r = await relay(http, other.token, deviceId, [
        envelope(deviceId, 'device_status', {}),
      ]).expect(404);
      expect(r.body.code).toBe('DEVICE_NOT_FOUND');
      await relay(http, owner.token, unregistered, [
        envelope(unregistered, 'device_status', {}),
      ]).expect(404);
    });

    it('同一批内重复 eventId：只存一次', async () => {
      const id = randomUUID();
      const e = envelope(
        deviceId,
        'device_status',
        { battery: 42 },
        { eventId: id },
      );
      const res = await relay(http, owner.token, deviceId, [e, e, e]).expect(
        202,
      );
      expect(res.body).toEqual({ accepted: 1, duplicate: 2, invalid: 0 });
      expect(await prisma.rawEvent.count({ where: { eventId: id } })).toBe(1);
    });

    it('并发 6 个相同批次（各 20 条）：总 accepted=20，其余 duplicate，无 5xx', async () => {
      const batch = Array.from({ length: 20 }, (_, i) =>
        envelope(deviceId, 'location_update', validLocation(i)),
      );
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          relay(http, owner.token, deviceId, batch),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => s === 202)).toBe(true);
      const accepted = results.reduce(
        (s, r) => s + (r.body.accepted as number),
        0,
      );
      const duplicate = results.reduce(
        (s, r) => s + (r.body.duplicate as number),
        0,
      );
      expect(accepted).toBe(20);
      expect(duplicate).toBe(100);
      const ids = batch.map((e) => e.eventId as string);
      expect(
        await prisma.rawEvent.count({ where: { eventId: { in: ids } } }),
      ).toBe(20);
      expect(
        await prisma.locationPoint.count({ where: { eventId: { in: ids } } }),
      ).toBe(20);
    });

    it('蓝牙版范围外类型（sleep_entered / video_ready）：留档为 invalid，不进业务', async () => {
      const e = envelope(deviceId, 'sleep_entered', {});
      const res = await relay(http, owner.token, deviceId, [e]).expect(202);
      expect(res.body.invalid).toBe(1);
      expect(
        await prisma.rawEvent.count({
          where: { eventId: e.eventId as string },
        }),
      ).toBe(0);
      const invalidRow = await prisma.rawEvent.findFirst({
        where: { deviceId, eventType: '_invalid' },
        orderBy: { receivedAt: 'desc' },
      });
      expect((invalidRow?.payload as { reason?: string }).reason).toBe(
        'event_type_not_allowed',
      );
    });

    it('envelope 内 deviceId 与外层不一致：invalid（设备只能以自己身份上报）', async () => {
      const e = envelope(freshDevice, 'device_status', { battery: 1 });
      const res = await relay(http, owner.token, deviceId, [e]).expect(202);
      expect(res.body.invalid).toBe(1);
    });
  });

  describe('envelope 字段极值', () => {
    it('timestamp 无时区 / 非 ISO / 数字：invalid', async () => {
      const bad = [
        envelope(
          deviceId,
          'device_status',
          {},
          { timestamp: '2026-09-10T03:00:00' },
        ),
        envelope(
          deviceId,
          'device_status',
          {},
          { timestamp: '2026/09/10 03:00:00Z' },
        ),
        envelope(deviceId, 'device_status', {}, { timestamp: 1757480400000 }),
        envelope(deviceId, 'device_status', {}, { timestamp: '' }),
      ];
      const res = await relay(http, owner.token, deviceId, bad).expect(202);
      expect(res.body).toEqual({ accepted: 0, duplicate: 0, invalid: 4 });
    });

    it('timestamp 为不存在的日历日（02-30 / 13 月）：invalid，不被 JS 静默回滚', async () => {
      const es = [
        envelope(
          deviceId,
          'device_status',
          {},
          { timestamp: '2026-02-30T00:00:00Z' },
        ),
        envelope(
          deviceId,
          'device_status',
          {},
          { timestamp: '2026-13-01T00:00:00Z' },
        ),
        envelope(
          deviceId,
          'device_status',
          {},
          { timestamp: '2028-02-29T00:00:00+08:00' },
        ),
      ];
      const res = await relay(http, owner.token, deviceId, es).expect(202);
      expect(res.body).toEqual({ accepted: 1, duplicate: 0, invalid: 2 });
    });

    it('timestamp 极值年份（0000 / 9999）：接口不得 5xx', async () => {
      const e0 = envelope(
        deviceId,
        'device_status',
        {},
        { timestamp: '0000-01-01T00:00:00Z' },
      );
      const e9 = envelope(
        deviceId,
        'device_status',
        {},
        { timestamp: '9999-12-31T23:59:59Z' },
      );
      const res = await relay(http, owner.token, deviceId, [e0, e9]);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: 1, duplicate: 0, invalid: 1 });
    });

    it('schemaVersion 超出 32 位整数 / 小数 / 字符串：接口不得 5xx', async () => {
      const es = [
        envelope(deviceId, 'device_status', {}, { schemaVersion: 2147483648 }),
        envelope(deviceId, 'device_status', {}, { schemaVersion: 1e18 }),
        envelope(deviceId, 'device_status', {}, { schemaVersion: 1.5 }),
        envelope(deviceId, 'device_status', {}, { schemaVersion: '1' }),
      ];
      const res = await relay(http, owner.token, deviceId, es);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: 0, duplicate: 0, invalid: 4 });
    });

    it('eventId 超长（5000 字符）与含换行：可入库', async () => {
      const longId = `long_${'x'.repeat(5000)}_${run}`;
      const nlId = `nl_${run}\nfake log line`;
      const res = await relay(http, owner.token, deviceId, [
        envelope(deviceId, 'device_status', {}, { eventId: longId }),
        envelope(deviceId, 'device_status', {}, { eventId: nlId }),
      ]);
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(2);
    });

    it('eventId / payload 含 NUL 字符（\\u0000）：接口不得 5xx', async () => {
      const es = [
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: `nul_${run}_\u0000` },
        ),
        envelope(deviceId, 'device_status', { note: 'a\u0000b' }),
      ];
      const res = await relay(http, owner.token, deviceId, es);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: 0, duplicate: 0, invalid: 2 });
    });

    it('payload 深度嵌套（200 层）与 500 个键：可入库', async () => {
      let nested: Record<string, unknown> = { leaf: 1 };
      for (let i = 0; i < 200; i += 1) nested = { n: nested };
      const wide: Record<string, unknown> = {};
      for (let i = 0; i < 500; i += 1) wide[`k${i}`] = i;
      const res = await relay(http, owner.token, deviceId, [
        envelope(deviceId, 'collision_risk', nested),
        envelope(deviceId, 'obstacle_risk', wide),
      ]);
      expect(res.status).toBe(202);
      expect(res.body.accepted).toBe(2);
    });

    it('单条 70KB payload：留档 invalid（payload_too_large）；整包超 100KB：JSON 格式的 413', async () => {
      const big = envelope(deviceId, 'collision_risk', {
        blob: 'x'.repeat(70_000),
      });
      const r1 = await relay(http, owner.token, deviceId, [big]).expect(202);
      expect(r1.body.invalid).toBe(1);
      const r2 = await relay(http, owner.token, deviceId, [big, big]);
      expect(r2.status).toBe(413);
      expect(r2.body.code).toBe('PAYLOAD_TOO_LARGE');
      expect(typeof r2.body.requestId).toBe('string');
    });
  });

  describe('业务副表对脏值的容忍', () => {
    it('device_status battery 为小数/超大/负数/字符串：事件入库，且 lastSeenAt 必须仍被刷新', async () => {
      const cases: Array<Record<string, unknown>> = [
        { battery: 55.5 },
        { battery: 1e12 },
        { battery: -1 },
        { battery: '80' },
        { signalLevel: 3.3 },
      ];
      for (const payload of cases) {
        await prisma.device.update({
          where: { deviceId: freshDevice },
          data: { lastSeenAt: null },
        });
        const res = await relay(http, owner.token, freshDevice, [
          envelope(freshDevice, 'device_status', payload),
        ]).expect(202);
        expect(res.body.accepted).toBe(1);
        const status = await request(http)
          .get(`/api/v1/devices/${freshDevice}/status`)
          .set(auth(owner.token))
          .expect(200);
        // 快照失败会让设备"看起来离线"——这是保命链路展示面，不允许
        expect({ payload, online: status.body.online }).toEqual({
          payload,
          online: true,
        });
      }
    });

    it('location_update 脏坐标：事件入库但不进轨迹表；合法边界值（heading=360、lat=-90）入表', async () => {
      const dirty = [
        envelope(freshDevice, 'location_update', {
          ...validLocation(),
          latitude: '31.2',
        }),
        envelope(freshDevice, 'location_update', {
          ...validLocation(),
          latitude: 90.0000001,
        }),
        envelope(freshDevice, 'location_update', {
          ...validLocation(),
          heading: 360.1,
        }),
        envelope(freshDevice, 'location_update', {
          ...validLocation(),
          coordinateSystem: 'bd09',
        }),
        envelope(freshDevice, 'location_update', {
          ...validLocation(),
          speed: -0.1,
        }),
        envelope(freshDevice, 'location_update', {}),
      ];
      const edge = [
        envelope(freshDevice, 'location_update', {
          ...validLocation(),
          heading: 360,
          latitude: -90,
          longitude: 180,
        }),
        envelope(freshDevice, 'location_update', {
          ...validLocation(),
          altitude: -400,
        }),
      ];
      const res = await relay(http, owner.token, freshDevice, [
        ...dirty,
        ...edge,
      ]).expect(202);
      expect(res.body.accepted).toBe(8);
      const dirtyIds = dirty.map((e) => e.eventId as string);
      const edgeIds = edge.map((e) => e.eventId as string);
      expect(
        await prisma.locationPoint.count({
          where: { eventId: { in: dirtyIds } },
        }),
      ).toBe(0);
      expect(
        await prisma.locationPoint.count({
          where: { eventId: { in: edgeIds } },
        }),
      ).toBe(2);
    });

    it('video_ready sizeBytes 超过 32 位整数（3GB 视频）：媒体元数据不得静默丢失', async () => {
      const e = envelope(deviceId, 'video_ready', {
        videoId: `vid_big_${run}`,
        duration: 3600,
        sizeBytes: 3_000_000_000,
        storageKey: `k/${run}`,
      });
      const outcome = await ingest.ingestRaw(
        JSON.stringify(e),
        deviceId,
        'mqtt',
      );
      expect(outcome).toBe('stored');
      const media = await prisma.media.findUnique({
        where: { deviceId_videoId: { deviceId, videoId: `vid_big_${run}` } },
      });
      expect(media).not.toBeNull();
    });
  });

  describe('未注册设备与 webhook 入口', () => {
    it('未注册设备事件：留档、不进业务、不抛错', async () => {
      const e = envelope(unregistered, 'possible_fall', {});
      const outcome = await ingest.ingestRaw(
        JSON.stringify(e),
        unregistered,
        'mqtt',
      );
      expect(outcome).toBe('stored');
      expect(
        await prisma.sosCase.count({ where: { deviceId: unregistered } }),
      ).toBe(0);
    });

    it('webhook：数组体 / 空对象 / 字符串体 / 非 JSON 体：不 5xx', async () => {
      const wh = () =>
        request(http)
          .post('/api/v1/ingest/webhook')
          .set('X-Api-Key', WEBHOOK_KEY);
      const r1 = await wh().send([envelope(deviceId, 'device_status', {})]);
      expect([202, 400]).toContain(r1.status);
      const r2 = await wh().send({});
      expect(r2.status).toBe(202);
      expect(r2.body).toEqual({
        eventId: null,
        duplicate: false,
        invalid: true,
      });
      const r3 = await wh()
        .set('Content-Type', 'application/json')
        .send('"just a string"');
      expect(r3.status).toBeLessThan(500);
      const r4 = await wh()
        .set('Content-Type', 'application/json')
        .send('{not json');
      expect(r4.status).toBe(400);
      expect(typeof r4.body.code).toBe('string');
    });

    it('webhook：缺 key / 错 key 401；eventType 为保留的 _invalid 时不进事件查询', async () => {
      await request(http).post('/api/v1/ingest/webhook').send({}).expect(401);
      await request(http)
        .post('/api/v1/ingest/webhook')
        .set('X-Api-Key', 'wrong')
        .send({})
        .expect(401);
      const e = envelope(deviceId, '_invalid', { fake: true });
      await request(http)
        .post('/api/v1/ingest/webhook')
        .set('X-Api-Key', WEBHOOK_KEY)
        .send(e)
        .expect(202);
      await request(http)
        .get(`/api/v1/events/${e.eventId as string}`)
        .set(auth(owner.token))
        .expect(404);
      const list = await request(http)
        .get(`/api/v1/devices/${deviceId}/events?pageSize=100`)
        .set(auth(owner.token))
        .expect(200);
      const ids = (list.body.items as Array<{ eventId: string }>).map(
        (i) => i.eventId,
      );
      expect(ids).not.toContain(e.eventId);
    });
  });
});
