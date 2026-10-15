// 2026-10-16 边界测试：事件进业务副表时的值域（EVENTS.md §4.1 / §4.2），以及电量历史的分桶边界（API.md §4）。
// location_update 逐字段的边界值与大小写、device_status 快照对越界值的容忍、补传旧事件对快照的影响。
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
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

const MIN = 60_000;

describe('边界：事件进业务表的值域 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let owner: TestUser;
  const run = Date.now();
  const devLoc = `edge_biz_loc_${run}`;
  const devStatus = `edge_biz_st_${run}`;
  const devBattery = `edge_biz_bat_${run}`;

  /** 投一条位置，返回它进没进轨迹表（以及进了的那一行） */
  const loc = async (payload: Record<string, unknown>) => {
    const e = envelope(devLoc, 'location_update', payload);
    const r = await relay(http, owner.token, devLoc, [e]).expect(202);
    expect(r.body.accepted).toBe(1);
    return prisma.locationPoint.findFirst({
      where: { deviceId: devLoc, eventId: e.eventId as string },
    });
  };
  const statusOf = async () =>
    (
      await request(http)
        .get(`/api/v1/devices/${devStatus}/status`)
        .set(auth(owner.token))
        .expect(200)
    ).body as {
      battery: number | null;
      charging: boolean | null;
      signalLevel: number | null;
      sleeping: boolean;
      firmwareVersion: string | null;
      online: boolean;
    };
  const heartbeat = (payload: Record<string, unknown>, overrides = {}) =>
    relay(http, owner.token, devStatus, [
      envelope(devStatus, 'device_status', payload, overrides),
    ]).expect(202);

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    owner = await createUser(app, http);
    for (const d of [devLoc, devStatus, devBattery]) {
      await provisionDevice(prisma, d);
      await bindDevice(http, owner.token, d);
    }
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [devLoc, devStatus, devBattery]);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  describe('location_update 值域', () => {
    it('边界值入表：纬度 ±90、经度 ±180、航向 0 / 360、速度 0、精度 0、海拔负数与 8848', async () => {
      for (const over of [
        { latitude: 90, longitude: 180 },
        { latitude: -90, longitude: -180 },
        { heading: 0 },
        { heading: 360 },
        { speed: 0 },
        { accuracy: 0 },
        { altitude: -430 },
        { altitude: 8848.86 },
      ]) {
        const row = await loc({ ...validLocation(), ...over });
        expect(row).not.toBeNull();
        for (const [k, v] of Object.entries(over)) {
          expect(row![k as keyof typeof row]).toBe(v);
        }
      }
    });

    it('越界一点点不入表（只留原始事件）：纬度 90.000001、经度 -180.000001、航向 360.0001 / -0.0001、速度 -0.1、精度 -1', async () => {
      for (const over of [
        { latitude: 90.000001 },
        { longitude: -180.000001 },
        { heading: 360.0001 },
        { heading: -0.0001 },
        { speed: -0.1 },
        { accuracy: -1 },
      ]) {
        expect(await loc({ ...validLocation(), ...over })).toBeNull();
      }
    });

    it('坐标系区分大小写：WGS84 / GCJ02 / bd09 / 缺失 → 不入表；wgs84 / gcj02 入表', async () => {
      for (const coordinateSystem of [
        'WGS84',
        'GCJ02',
        'Wgs84',
        'bd09',
        undefined,
      ]) {
        expect(await loc({ ...validLocation(), coordinateSystem })).toBeNull();
      }
      for (const coordinateSystem of ['wgs84', 'gcj02']) {
        const row = await loc({ ...validLocation(), coordinateSystem });
        expect(row?.coordinateSystem).toBe(coordinateSystem);
      }
    });

    it('数值写成字符串（"30.1"）/ 布尔 → 不入表；海拔非数字 → 点照常入表、altitude 为 null', async () => {
      expect(await loc({ ...validLocation(), latitude: '30.1' })).toBeNull();
      expect(await loc({ ...validLocation(), speed: true })).toBeNull();
      const row = await loc({ ...validLocation(), altitude: 'high' });
      expect(row).not.toBeNull();
      expect(row!.altitude).toBeNull();
      const noAlt = await loc({ ...validLocation(), altitude: undefined });
      expect(noAlt!.altitude).toBeNull();
    });

    it('载荷里多余字段不影响入表；超高精度小数原样保存（双精度）', async () => {
      const row = await loc({
        ...validLocation(),
        latitude: 31.12345678901234,
        satellites: 9,
        hdop: 0.8,
      });
      expect(row!.latitude).toBe(31.12345678901234);
    });
  });

  describe('device_status 快照', () => {
    it('电量 0 与 100 都写进快照；101 / -1 / 50.5 / "50" / null 按缺失保留上一次的值', async () => {
      await heartbeat({ battery: 0 });
      expect((await statusOf()).battery).toBe(0);
      await heartbeat({ battery: 100 });
      expect((await statusOf()).battery).toBe(100);
      for (const battery of [101, -1, 50.5, '50', null]) {
        await heartbeat({ battery });
        expect((await statusOf()).battery).toBe(100);
      }
    });

    it('信号 0–4 写入、5 / -1 忽略；charging / sleeping 只认布尔（"true" / 1 忽略）', async () => {
      await heartbeat({ signalLevel: 0, charging: false, sleeping: false });
      expect(await statusOf()).toMatchObject({
        signalLevel: 0,
        charging: false,
        sleeping: false,
      });
      await heartbeat({ signalLevel: 4, charging: true, sleeping: true });
      expect(await statusOf()).toMatchObject({
        signalLevel: 4,
        charging: true,
        sleeping: true,
      });
      await heartbeat({ signalLevel: 5, charging: 'false', sleeping: 0 });
      await heartbeat({ signalLevel: -1, charging: 0, sleeping: 'false' });
      expect(await statusOf()).toMatchObject({
        signalLevel: 4,
        charging: true,
        sleeping: true,
      });
    });

    it('补传的旧事件（2 小时前、旧固件号）也会刷新 lastSeenAt 与 firmwareVersion（快照取最后到达的，不比设备时间，按现状）', async () => {
      await heartbeat({ battery: 60 }, { firmwareVersion: '2.0.0' });
      expect((await statusOf()).firmwareVersion).toBe('2.0.0');
      await heartbeat(
        { battery: 40 },
        {
          firmwareVersion: '1.9.0',
          timestamp: new Date(Date.now() - 120 * MIN).toISOString(),
        },
      );
      const s = await statusOf();
      expect(s.online).toBe(true);
      expect(s.firmwareVersion).toBe('1.9.0');
      // 电量同样按到达顺序覆盖：补传的 40 盖掉了刚才实时的 60
      expect(s.battery).toBe(40);
    });

    it('固件号很长（2000 字符）/ 含中文与 emoji：原样进快照与设备列表，不截断不 500', async () => {
      const fw = `固件😀${'x'.repeat(2000)}`;
      await heartbeat({ battery: 50 }, { firmwareVersion: fw });
      expect((await statusOf()).firmwareVersion).toBe(fw);
      const list = await request(http)
        .get('/api/v1/devices')
        .set(auth(owner.token))
        .expect(200);
      expect(
        list.body.find((x: { deviceId: string }) => x.deviceId === devStatus)
          .firmwareVersion,
      ).toBe(fw);
    });
  });

  describe('电量历史分桶（10 分钟桶、取桶内最后一条）', () => {
    it('桶边界：xx:09:59.999 与 xx:10:00.000 分属两桶；同桶两条取时间更晚的那条', async () => {
      // 取 3 小时前的整 10 分钟做锚，全部在默认 24h 窗口内
      const anchor =
        Math.floor((Date.now() - 3 * 60 * MIN) / (10 * MIN)) * 10 * MIN;
      const at = (ms: number) => new Date(ms).toISOString();
      await relay(http, owner.token, devBattery, [
        envelope(
          devBattery,
          'device_status',
          { battery: 81 },
          { timestamp: at(anchor + 10 * MIN - 1) },
        ),
        envelope(
          devBattery,
          'device_status',
          { battery: 80 },
          { timestamp: at(anchor + 10 * MIN) },
        ),
        envelope(
          devBattery,
          'device_status',
          { battery: 79 },
          { timestamp: at(anchor + 15 * MIN) },
        ),
        envelope(
          devBattery,
          'device_status',
          { battery: 90 },
          { timestamp: at(anchor + 1000) },
        ),
      ]).expect(202);
      const r = await request(http)
        .get(`/api/v1/devices/${devBattery}/battery-history`)
        .set(auth(owner.token))
        .expect(200);
      expect(r.body.points).toEqual([
        { timestamp: at(anchor + 10 * MIN - 1), battery: 81, charging: null },
        { timestamp: at(anchor + 15 * MIN), battery: 79, charging: null },
      ]);
    });

    it('hours=1：59 分钟前的心跳在、61 分钟前的不在', async () => {
      const dev2 = `${devBattery}_h`;
      await provisionDevice(prisma, dev2);
      await bindDevice(http, owner.token, dev2);
      try {
        const now = Date.now();
        await relay(http, owner.token, dev2, [
          envelope(
            dev2,
            'device_status',
            { battery: 61 },
            { timestamp: new Date(now - 61 * MIN).toISOString() },
          ),
          envelope(
            dev2,
            'device_status',
            { battery: 59 },
            { timestamp: new Date(now - 59 * MIN).toISOString() },
          ),
        ]).expect(202);
        const r = await request(http)
          .get(`/api/v1/devices/${dev2}/battery-history`)
          .query({ hours: 1 })
          .set(auth(owner.token))
          .expect(200);
        expect(
          r.body.points.map((p: { battery: number }) => p.battery),
        ).toEqual([59]);
      } finally {
        await cleanupDevices(prisma, [dev2]);
      }
    });
  });
});
