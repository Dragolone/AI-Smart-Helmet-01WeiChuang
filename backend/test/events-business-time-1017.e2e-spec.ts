// 事件历史按业务时间（决策 #59，10-17 第二轮评审 r2）：原来按头盔自报时间排序 / 过滤——
// RTC 归零报 1970 的最新事件沉到列表底（App 安全页每台只取前 5 条，看不到），行程时间窗查不到它；
// 报 2099 的永远排第一。现在列表与时间窗按 business_time，返回的 timestamp 是业务时间，设备原值在 deviceTimestamp。
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

jest.setTimeout(60_000);

const RISK = { riskLevel: 'high', objectType: 'vehicle', direction: 'rear' };

describe('事件历史按业务时间 (e2e)', () => {
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
    const d = `evbt1017_${run}_${seq}`;
    devices.push(d);
    await provisionDevice(prisma, d);
    await bindDevice(http, u.token, d);
    return { u, d };
  };
  const list = (u: TestUser, d: string, query: Record<string, unknown>) =>
    request(http)
      .get(`/api/v1/devices/${d}/events`)
      .query({ type: 'collision_risk', ...query })
      .set(auth(u.token))
      .expect(200);

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });
  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('头盔 RTC 归零后报 1970：最新到达的这条排第一，timestamp 是收到时间，设备原值在 deviceTimestamp', async () => {
    const { u, d } = await setup();
    const earlier = envelope(d, 'collision_risk', RISK, {
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    await relay(http, u.token, d, [earlier]).expect(202);
    const reset = envelope(d, 'collision_risk', RISK, {
      timestamp: '1970-01-01T00:00:42.000Z',
    });
    await relay(http, u.token, d, [reset]).expect(202);

    const res = await list(u, d, { pageSize: 1 });
    expect(res.body.total).toBe(2);
    const [top] = res.body.items as Array<Record<string, string>>;
    expect(top.eventId).toBe(reset.eventId);
    expect(top.deviceTimestamp).toBe('1970-01-01T00:00:42.000Z');
    expect(top.timestamp).toBe(top.receivedAt);

    // 详情同口径
    const detail = await request(http)
      .get(`/api/v1/events/${reset.eventId as string}`)
      .set(auth(u.token))
      .expect(200);
    expect(detail.body).toMatchObject({
      timestamp: top.timestamp,
      deviceTimestamp: '1970-01-01T00:00:42.000Z',
    });
    // 原始时间照常留档
    const row = await prisma.rawEvent.findFirstOrThrow({
      where: { deviceId: d, eventId: reset.eventId as string },
    });
    expect(row.timestamp.toISOString()).toBe('1970-01-01T00:00:42.000Z');
  });

  it('按时间窗查（App 行程页）：「最近 1 小时」能查到时钟错乱的那条', async () => {
    const { u, d } = await setup();
    const reset = envelope(d, 'collision_risk', RISK, {
      timestamp: '1970-01-01T00:00:42.000Z',
    });
    await relay(http, u.token, d, [reset]).expect(202);
    const res = await list(u, d, {
      from: new Date(Date.now() - 3_600_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(
      (res.body.items as Array<{ eventId: string }>).map((i) => i.eventId),
    ).toEqual([reset.eventId]);
  });

  it('报 2099 的不再永远排第一：之后到达的正常事件排在它前面', async () => {
    const { u, d } = await setup();
    const future = envelope(d, 'collision_risk', RISK, {
      timestamp: '2099-01-01T00:00:00.000Z',
    });
    await relay(http, u.token, d, [future]).expect(202);
    await new Promise((r) => setTimeout(r, 20));
    const later = envelope(d, 'collision_risk', RISK);
    await relay(http, u.token, d, [later]).expect(202);
    const res = await list(u, d, {});
    expect(
      (res.body.items as Array<{ eventId: string }>).map((i) => i.eventId),
    ).toEqual([later.eventId, future.eventId]);
  });

  it('时钟正常 / 正常补传（几小时前）：timestamp 与 deviceTimestamp 相同，仍按设备时间排', async () => {
    const { u, d } = await setup();
    const backfill = envelope(d, 'collision_risk', RISK, {
      timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    });
    const live = envelope(d, 'collision_risk', RISK);
    // 先到实时的、后到补传的：补传那条照旧排在后面
    await relay(http, u.token, d, [live]).expect(202);
    await relay(http, u.token, d, [backfill]).expect(202);
    const res = await list(u, d, {});
    const items = res.body.items as Array<Record<string, string>>;
    expect(items.map((i) => i.eventId)).toEqual([
      live.eventId,
      backfill.eventId,
    ]);
    for (const i of items) expect(i.timestamp).toBe(i.deviceTimestamp);
  });
});
