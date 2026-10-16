// 10-17 后端评审数据接入一路的真库复现：
// HIGH-1 瞬时数据库错误（死锁 / 后端被杀）把摔倒改记成随机 eventId 的 _invalid、202 回给 App，求救永久丢失；
// R4-1 头盔转手后前主人占了号，新主人的摔倒被当重复、不建单；MEDIUM-2 换算到 UTC 是 10000 年的时间戳让列表 500；
// MEDIUM-3 风险事件 payload 里的怪对象让事件列表 500；LOW-4 Webhook 超长 deviceId 500；观察项 16 补传的旧心跳把电量写回旧值。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { webhook } from './helpers/audit-ingest';
import {
  auth,
  bindDevice,
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
  buildSosApp,
  fallEnvelope,
  makeProviderMocks,
  sosByEvent,
} from './helpers/audit-sos';

jest.setTimeout(90_000);

const mocks = makeProviderMocks();

describe('数据接入边界（10-17 评审）', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  const run = Date.now();
  let seq = 0;

  const newUser = async () => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };
  const newDevice = async (u: TestUser) => {
    seq += 1;
    const id = `ingfix_${run}_${seq}`;
    devices.push(id);
    await provisionDevice(prisma, id);
    await bindDevice(http, u.token, id);
    return id;
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS ingfix_deadlock ON raw_events',
    );
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS ingfix_deadlock()');
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('HIGH-1 入库遇到死锁（40P01）：入口回 5xx 让 App 重传，不把摔倒改记成 _invalid；数据库恢复后重传照常建单', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ingfix_deadlock() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_id LIKE 'deadlock-%' THEN
          RAISE EXCEPTION 'injected deadlock' USING ERRCODE = '40P01';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER ingfix_deadlock BEFORE INSERT ON raw_events FOR EACH ROW EXECUTE FUNCTION ingfix_deadlock()',
    );
    const fall = fallEnvelope(d, {}, { eventId: `deadlock-${randomUUID()}` });
    const res = await relay(http, u.token, d, [fall]);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(
      await prisma.rawEvent.count({
        where: { deviceId: d, eventType: '_invalid' },
      }),
    ).toBe(0);
    await prisma.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS ingfix_deadlock ON raw_events',
    );
    const retry = await relay(http, u.token, d, [fall]).expect(202);
    expect(retry.body).toMatchObject({ accepted: 1, invalid: 0 });
    expect((await sosByEvent(prisma, fall.eventId as string))?.status).toBe(
      'pending',
    );
  });

  it('R4-1 头盔转手：前主人中转过同号的位置事件，新主人的摔倒照常建单（原来当重复、不建单）', async () => {
    const prev = await newUser();
    const next = await newUser();
    const d = await newDevice(prev);
    const eventId = randomUUID();
    await relay(http, prev.token, d, [
      envelope(d, 'location_update', validLocation(), { eventId }),
    ]).expect(202);
    await request(http)
      .delete(`/api/v1/devices/${d}/binding`)
      .set(auth(prev.token))
      .expect(204);
    await bindDevice(http, next.token, d);
    const fall = fallEnvelope(d, {}, { eventId });
    const res = await relay(http, next.token, d, [fall]).expect(202);
    expect(res.body).toMatchObject({ accepted: 1, duplicate: 0 });
    const cases = await prisma.sosCase.findMany({ where: { deviceId: d } });
    expect(cases).toHaveLength(1);
    expect(cases[0].userId).toBe(next.id);
    expect(cases[0].triggerEventId.startsWith(`${eventId}~`)).toBe(true);
    // 同一条摔倒再重传：按重复跳过，不建第二单
    const again = await relay(http, next.token, d, [fall]).expect(202);
    expect(again.body).toMatchObject({ accepted: 0, duplicate: 1 });
    expect(await prisma.sosCase.count({ where: { deviceId: d } })).toBe(1);
  });

  it('MEDIUM-2 换算到 UTC 是 10000 年的时间戳：判无效；本人的进行中求救列表仍 200', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    const res = await relay(http, u.token, d, [
      fallEnvelope(d, {}, { timestamp: '9999-12-31T24:00:00Z' }),
    ]).expect(202);
    expect(res.body).toMatchObject({ accepted: 0, invalid: 1 });
    await request(http)
      .get('/api/v1/users/me/sos/active')
      .set(auth(u.token))
      .expect(200);
    await request(http)
      .get(`/api/v1/devices/${d}/events`)
      .set(auth(u.token))
      .expect(200);
  });

  it('MEDIUM-3 风险事件 riskLevel 是 {"toString":1}：事件列表照常 200（原来之后一直 500）', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    await webhook(
      http,
      envelope(d, 'collision_risk', { riskLevel: { toString: 1 } }),
    ).expect(202);
    const list = await request(http)
      .get(`/api/v1/devices/${d}/events`)
      .set(auth(u.token))
      .expect(200);
    expect(list.body.items[0].summary).toBe('碰撞风险');
  });

  it('LOW-4 Webhook deviceId 4 KB：202 按无效留档（原来连留档都写不进索引 → 500）', async () => {
    const huge = 'x'.repeat(4096);
    const res = await webhook(
      http,
      envelope(huge, 'device_status', { battery: 50 }),
    ).expect(202);
    expect(res.body.invalid).toBe(true);
  });

  it('观察项 16 补传的 2 小时前的心跳：照常入库，但不把电量写回旧值', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    await relay(http, u.token, d, [
      envelope(d, 'device_status', { battery: 80 }),
    ]).expect(202);
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const res = await relay(http, u.token, d, [
      envelope(d, 'device_status', { battery: 10 }, { timestamp: old }),
    ]).expect(202);
    expect(res.body).toMatchObject({ accepted: 1 });
    const status = await request(http)
      .get(`/api/v1/devices/${d}/status`)
      .set(auth(u.token))
      .expect(200);
    expect(status.body.battery).toBe(80);
  });
});
