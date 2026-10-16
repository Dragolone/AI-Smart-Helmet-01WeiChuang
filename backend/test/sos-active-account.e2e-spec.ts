// GET /users/me/sos/active（API.md §7，上线清单 B 线第 12 项）：本账号所有进行中的 SOS 一次拿全。
// 钉住：按到期先后、跨账号隔离、终态不列、头盔解绑后本人的单照样列、转手后不露新主人起的头盔名、
// 新主人的单不进前主人的列表（决策 #40 两单并存）、统一分页与参数校验。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { ActiveSosItem, Paginated } from '@helmet/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  cleanupDevices,
  cleanupUsers,
  createUser,
  provisionDevice,
  relay,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  buildSosApp,
  cancelSos,
  confirmSos,
  fallEnvelope,
  makeProviderMocks,
  manualEnvelope,
  sosByEvent,
  waitUntil,
} from './helpers/audit-sos';

jest.setTimeout(120_000);

const mocks = makeProviderMocks();

describe('账号级进行中 SOS 列表 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  const run = Date.now();
  let seq = 0;

  const newUser = async (): Promise<TestUser> => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };
  const newDevice = async (u: TestUser): Promise<string> => {
    seq += 1;
    const id = `sos_acct_${run}_${seq}`;
    devices.push(id);
    await provisionDevice(prisma, id);
    await bindDevice(http, u.token, id);
    return id;
  };
  const list = (u: TestUser, query = '') =>
    request(http).get(`/api/v1/users/me/sos/active${query}`).set(auth(u.token));
  const body = (r: request.Response) => r.body as Paginated<ActiveSosItem>;
  /** 经 App 中转上报一条摔倒 / 求救，等它建好单，返回单号 */
  const trigger = async (
    u: TestUser,
    deviceId: string,
    kind: 'fall' | 'manual' = 'fall',
  ): Promise<string> => {
    const env =
      kind === 'fall' ? fallEnvelope(deviceId) : manualEnvelope(deviceId);
    await relay(http, u.token, deviceId, [env]).expect(202);
    const sos = await waitUntil(
      () => sosByEvent(prisma, env.eventId as string),
      (s) => s !== null,
      5_000,
      50,
    );
    return sos!.id;
  };
  const rename = (u: TestUser, deviceId: string, name: string) =>
    request(http)
      .patch(`/api/v1/devices/${deviceId}`)
      .set(auth(u.token))
      .send({ name })
      .expect(200);

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
  });

  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('没登录 401；一单都没有时 200 items=[]（不是 404）', async () => {
    await request(http).get('/api/v1/users/me/sos/active').expect(401);
    const u = await newUser();
    const r = await list(u).expect(200);
    expect(body(r)).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('两顶头盔各一单：按到期先后列出，带头盔名（没起名为 null）；别的账号的单不列，反之亦然', async () => {
    const a = await newUser();
    const b = await newUser();
    const h1 = await newDevice(a);
    const h2 = await newDevice(a);
    const hb = await newDevice(b);
    await rename(a, h1, '  通勤\n头盔 ');
    const s1 = await trigger(a, h1);
    const s2 = await trigger(a, h2, 'manual');
    const sb = await trigger(b, hb);

    const mine = body(await list(a, '?pageSize=100').expect(200));
    expect(mine.total).toBe(2);
    expect(mine.items.map((i) => [i.sosId, i.deviceId, i.deviceName])).toEqual([
      [s1, h1, '通勤 头盔'],
      [s2, h2, null],
    ]);
    expect(mine.items[0]).toMatchObject({
      status: 'pending',
      triggerType: 'possible_fall',
    });
    expect(Date.parse(mine.items[0].deadline)).toBeLessThanOrEqual(
      Date.parse(mine.items[1].deadline),
    );
    expect(mine.items[1].triggerType).toBe('manual_sos');

    const theirs = body(await list(b).expect(200));
    expect(theirs.items.map((i) => i.sosId)).toEqual([sb]);
  });

  it('取消 / 立即求救之后不再列出', async () => {
    const u = await newUser();
    const h1 = await newDevice(u);
    const h2 = await newDevice(u);
    const s1 = await trigger(u, h1);
    const s2 = await trigger(u, h2);
    await cancelSos(http, u.token, s1).expect(200);
    expect(body(await list(u).expect(200)).items.map((i) => i.sosId)).toEqual([
      s2,
    ]);
    await confirmSos(http, u.token, s2).expect(200);
    expect(body(await list(u).expect(200))).toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('倒数中头盔被解绑：本人的单照样列出（解绑不影响处置权，逐台接口此时 404），头盔名不再给', async () => {
    const u = await newUser();
    const h = await newDevice(u);
    await rename(u, h, '我的头盔');
    const s = await trigger(u, h);
    await request(http)
      .delete(`/api/v1/devices/${h}/binding`)
      .set(auth(u.token))
      .expect(204);
    await request(http)
      .get(`/api/v1/devices/${h}/sos/active`)
      .set(auth(u.token))
      .expect(404);
    const r = body(await list(u).expect(200));
    expect(r.items.map((i) => [i.sosId, i.deviceName])).toEqual([[s, null]]);
    // 处置权还在：照样能取消
    await cancelSos(http, u.token, s).expect(200);
  });

  it('头盔转手：前主人的单留在前主人的列表、看不到新主人起的名字；新主人的新单只进新主人的列表（决策 #40 两单并存）', async () => {
    const prev = await newUser();
    const next = await newUser();
    const h = await newDevice(prev);
    const sPrev = await trigger(prev, h);
    await request(http)
      .delete(`/api/v1/devices/${h}/binding`)
      .set(auth(prev.token))
      .expect(204);
    await bindDevice(http, next.token, h);
    await rename(next, h, '老王的头盔');
    const sNext = await trigger(next, h);

    const p = body(await list(prev).expect(200));
    expect(p.items.map((i) => [i.sosId, i.deviceName])).toEqual([
      [sPrev, null],
    ]);
    const n = body(await list(next).expect(200));
    expect(n.items.map((i) => [i.sosId, i.deviceName])).toEqual([
      [sNext, '老王的头盔'],
    ]);
  });

  it('统一分页：pageSize=1 逐页取、total 是总数；越界页为空；pageSize 超 100 / page 为 0 → 400', async () => {
    const u = await newUser();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await trigger(u, await newDevice(u)));
    }
    const pages: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const r = body(await list(u, `?page=${page}&pageSize=1`).expect(200));
      expect(r).toMatchObject({ total: 3, page, pageSize: 1 });
      pages.push(r.items[0].sosId);
    }
    expect(pages).toEqual(ids);
    expect(body(await list(u, '?page=4&pageSize=1').expect(200))).toMatchObject(
      { items: [], total: 3 },
    );
    for (const q of ['?pageSize=101', '?page=0', '?pageSize=abc']) {
      const r = await list(u, q).expect(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
  });
});
