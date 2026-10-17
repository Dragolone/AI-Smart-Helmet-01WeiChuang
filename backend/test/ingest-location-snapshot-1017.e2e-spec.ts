// 10-17 第二轮评审 r3：
// ① 位置点写库遇到瞬时故障被吞掉：入口回「已接受」，重传又回「重复」，这个点永远进不了轨迹；
// ② 5 分钟内乱序到达的旧心跳（重连时实时心跳先到、补传的几分钟前的心跳后到）覆盖设备快照，电量 / 充电回退成旧值。
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

jest.setTimeout(90_000);

describe('位置瞬时故障可补写 / 乱序心跳不覆盖快照 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  const run = Date.now();
  let seq = 0;

  const setup = async (): Promise<{ u: TestUser; d: string }> => {
    const u = await createUser(app, http);
    users.push(u);
    seq += 1;
    const d = `locsnap1017_${run}_${seq}`;
    devices.push(d);
    await provisionDevice(prisma, d);
    await bindDevice(http, u.token, d);
    return { u, d };
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS locsnap_lp_fail ON location_points',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS locsnap_lp_fail()');
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('位置点写库遇到瞬时故障（57P01）：入口回 5xx 让 App 重传，重传按重复处理时把点补上', async () => {
    const { u, d } = await setup();
    // 模拟数据库在两条 INSERT 之间重启 / 连接被掐：raw_events 写进去了，location_points 这一条失败
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION locsnap_lp_fail() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_id LIKE 'locsnap-%' THEN
          RAISE EXCEPTION 'injected admin shutdown' USING ERRCODE = '57P01';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER locsnap_lp_fail BEFORE INSERT ON location_points FOR EACH ROW EXECUTE FUNCTION locsnap_lp_fail()',
    );
    const loc = envelope(d, 'location_update', validLocation(1), {
      eventId: `locsnap-${randomUUID()}`,
    });
    const first = await relay(http, u.token, d, [loc]);
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS locsnap_lp_fail ON location_points',
    );
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(await prisma.locationPoint.count({ where: { deviceId: d } })).toBe(
      0,
    );

    // 数据库恢复后 App 按原 eventId 重传
    const retry = await relay(http, u.token, d, [loc]).expect(202);
    expect(retry.body).toEqual({ accepted: 0, duplicate: 1, invalid: 0 });
    expect(await prisma.locationPoint.count({ where: { deviceId: d } })).toBe(
      1,
    );
    expect(await prisma.rawEvent.count({ where: { deviceId: d } })).toBe(1);
  });

  it('乱序到达的旧心跳（3 分钟前、插着充电器时）排在实时心跳之后：快照保持新值', async () => {
    const { u, d } = await setup();
    const now = Date.now();
    await relay(http, u.token, d, [
      envelope(
        d,
        'device_status',
        { battery: 41, charging: false },
        {
          timestamp: new Date(now).toISOString(),
        },
      ),
    ]).expect(202);
    await relay(http, u.token, d, [
      envelope(
        d,
        'device_status',
        { battery: 47, charging: true },
        {
          timestamp: new Date(now - 3 * 60_000).toISOString(),
        },
      ),
    ]).expect(202);
    const res = await request(http)
      .get(`/api/v1/devices/${d}/status`)
      .set(auth(u.token))
      .expect(200);
    expect({ battery: res.body.battery, charging: res.body.charging }).toEqual({
      battery: 41,
      charging: false,
    });
    // 旧心跳照常留档，电量曲线里还在
    expect(await prisma.rawEvent.count({ where: { deviceId: d } })).toBe(2);
  });

  it('对照：按顺序到达（旧的先、新的后）照常刷新成新值', async () => {
    const { u, d } = await setup();
    const now = Date.now();
    await relay(http, u.token, d, [
      envelope(
        d,
        'device_status',
        { battery: 47, charging: true },
        {
          timestamp: new Date(now - 3 * 60_000).toISOString(),
        },
      ),
    ]).expect(202);
    await relay(http, u.token, d, [
      envelope(
        d,
        'device_status',
        { battery: 41, charging: false },
        {
          timestamp: new Date(now).toISOString(),
        },
      ),
    ]).expect(202);
    const res = await request(http)
      .get(`/api/v1/devices/${d}/status`)
      .set(auth(u.token))
      .expect(200);
    expect({ battery: res.body.battery, charging: res.body.charging }).toEqual({
      battery: 41,
      charging: false,
    });
  });
});
