// 2026-10-16 边界测试发现 B1–B6、B8 的修复验证（详情见 test/edge-findings-1016.md）。
// 每条先按发现时的复现步骤打，再断言修复后的口径。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { adminGet, cleanupAdmins, createAdmin } from './helpers/audit-admin';
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
  addContact,
  buildSosApp,
  confirmSos,
  fallEnvelope,
  makeProviderMocks,
  sosByEvent,
  sosSmsCalls,
} from './helpers/audit-sos';

jest.setTimeout(120_000);

const mocks = makeProviderMocks();

describe('边界测试发现的修复 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  const admins: string[] = [];
  const run = Date.now();
  let seq = 0;

  const newUser = async (password?: string): Promise<TestUser> => {
    const u = await createUser(app, http, password);
    users.push(u);
    return u;
  };
  const newDevice = async (u: TestUser): Promise<string> => {
    seq += 1;
    const id = `edge_fix_${run}_${seq}`;
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
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await cleanupAdmins(prisma, admins);
    await app.close();
  });

  it('B1 page=1e20：所有分页接口 400 VALIDATION_FAILED（原 500）；page=2147483647 仍 200 空页', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    const admin = await createAdmin(prisma, http, `edge_fix_admin_${run}`);
    admins.push(admin.username);
    const range = {
      from: new Date(Date.now() - 3_600_000).toISOString(),
      to: new Date().toISOString(),
    };
    const hit = (page: string) =>
      Promise.all([
        request(http)
          .get(`/api/v1/devices/${d}/events`)
          .query({ page })
          .set(auth(u.token)),
        request(http)
          .get(`/api/v1/devices/${d}/accidents`)
          .query({ page })
          .set(auth(u.token)),
        request(http)
          .get(`/api/v1/devices/${d}/commands`)
          .query({ page })
          .set(auth(u.token)),
        request(http)
          .get(`/api/v1/devices/${d}/locations`)
          .query({ page, ...range })
          .set(auth(u.token)),
        adminGet(http, admin.token, '/users', { page }),
        adminGet(http, admin.token, '/devices', { page }),
        adminGet(http, admin.token, '/accidents', { page }),
        adminGet(http, admin.token, '/events', { page }),
      ]);
    for (const page of ['1e20', '2147483648', '9007199254740993']) {
      const rs = await hit(page);
      expect(rs.map((r) => r.status)).toEqual(Array(8).fill(400));
      expect(rs.every((r) => r.body.code === 'VALIDATION_FAILED')).toBe(true);
    }
    const max = await hit('2147483647');
    expect(max.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(
      max.every(
        (r) => Array.isArray(r.body.items) && r.body.items.length === 0,
      ),
    ).toBe(true);
  });

  it('B2 最新轨迹点是 (0,0) 时：快照跳过它取上一个真实点；只有 (0,0) 则空快照、短信写「暂不可用」', async () => {
    const u = await newUser();
    await addContact(http, u.token, '家人', '19100006001');
    // 有真实点在前、(0,0) 在后
    const d1 = await newDevice(u);
    await relay(http, u.token, d1, [
      envelope(d1, 'location_update', validLocation(3), {
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      }),
      envelope(d1, 'location_update', {
        ...validLocation(),
        latitude: 0,
        longitude: 0,
      }),
    ]).expect(202);
    const f1 = fallEnvelope(d1);
    await relay(http, u.token, d1, [f1]).expect(202);
    const c1 = (await sosByEvent(prisma, f1.eventId as string))!;
    expect(c1.locationSource).toBe('last_point');
    expect(c1.latitude).toBeCloseTo(31.2003, 6);
    expect(c1.longitude).toBeCloseTo(121.5003, 6);
    // 只有 (0,0)
    const d2 = await newDevice(u);
    await relay(http, u.token, d2, [
      envelope(d2, 'location_update', {
        ...validLocation(),
        latitude: 0,
        longitude: 0,
      }),
    ]).expect(202);
    const f2 = fallEnvelope(d2);
    await relay(http, u.token, d2, [f2]).expect(202);
    const c2 = (await sosByEvent(prisma, f2.eventId as string))!;
    expect(c2.latitude).toBeNull();
    expect(c2.locationSource).toBeNull();
    mocks.sms.send.mockClear();
    await confirmSos(http, u.token, c2.id).expect(200);
    expect(sosSmsCalls(mocks)[0][1]).toMatchObject({
      params: { locationText: '暂不可用' },
    });
    // 只差一个坐标为 0 的点（赤道上 / 本初子午线上）不算哨兵：照常当快照
    const d3 = await newDevice(u);
    await relay(http, u.token, d3, [
      envelope(d3, 'location_update', {
        ...validLocation(),
        latitude: 0,
        longitude: 9.5,
      }),
    ]).expect(202);
    const f3 = fallEnvelope(d3);
    await relay(http, u.token, d3, [f3]).expect(202);
    expect(await sosByEvent(prisma, f3.eventId as string)).toMatchObject({
      latitude: 0,
      longitude: 9.5,
      locationSource: 'last_point',
    });
  });

  it('B3 换绑后新主人的摔倒（事件不带位置）：不拿前主人的最后位置；新主人自己有点后才回落到自己的点', async () => {
    const a = await newUser();
    const b = await newUser();
    const d = await newDevice(a);
    await relay(http, a.token, d, [
      envelope(d, 'location_update', validLocation(7)),
    ]).expect(202);
    await request(http)
      .delete(`/api/v1/devices/${d}/binding`)
      .set(auth(a.token))
      .expect(204);
    await bindDevice(http, b.token, d);
    const f1 = fallEnvelope(d);
    await relay(http, b.token, d, [f1]).expect(202);
    const c1 = (await sosByEvent(prisma, f1.eventId as string))!;
    expect(c1.userId).toBe(b.id);
    expect(c1.latitude).toBeNull();
    expect(c1.locationSource).toBeNull();
    const detail = await request(http)
      .get(`/api/v1/accidents/${c1.id}`)
      .set(auth(b.token))
      .expect(200);
    expect(detail.body.location).toBeNull();
    await request(http)
      .post(`/api/v1/sos/${c1.id}/cancel`)
      .set(auth(b.token))
      .expect(200);
    // 新主人自己的点
    await relay(http, b.token, d, [
      envelope(d, 'location_update', validLocation(9)),
    ]).expect(202);
    const f2 = fallEnvelope(d);
    await relay(http, b.token, d, [f2]).expect(202);
    const c2 = (await sosByEvent(prisma, f2.eventId as string))!;
    expect(c2.locationSource).toBe('last_point');
    expect(c2.latitude).toBeCloseTo(31.2009, 6);
  });

  it('B3 同一人解绑再绑回：之前那段区间里的点仍可作快照（两段都是他的）', async () => {
    const a = await newUser();
    const d = await newDevice(a);
    await relay(http, a.token, d, [
      envelope(d, 'location_update', validLocation(5)),
    ]).expect(202);
    await request(http)
      .delete(`/api/v1/devices/${d}/binding`)
      .set(auth(a.token))
      .expect(204);
    await bindDevice(http, a.token, d);
    const f = fallEnvelope(d);
    await relay(http, a.token, d, [f]).expect(202);
    expect(await sosByEvent(prisma, f.eventId as string)).toMatchObject({
      locationSource: 'last_point',
    });
  });

  it('B4 timestamp 带 4–9 位小数秒：接受（原 invalid）；这样的摔倒照常建单', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    const base = new Date().toISOString().slice(0, 19);
    for (const frac of ['1234', '123456', '123456789']) {
      const r = await relay(http, u.token, d, [
        envelope(
          d,
          'device_status',
          { battery: 50 },
          { timestamp: `${base}.${frac}Z` },
        ),
      ]).expect(202);
      expect(r.body).toEqual({ accepted: 1, duplicate: 0, invalid: 0 });
    }
    const withOffset = await relay(http, u.token, d, [
      envelope(
        d,
        'device_status',
        { battery: 51 },
        { timestamp: '2026-10-15T11:00:00.123456+08:00' },
      ),
    ]).expect(202);
    expect(withOffset.body.accepted).toBe(1);
    // 10 位以上仍拒（不收无意义的超长精度）
    const tooLong = await relay(http, u.token, d, [
      envelope(
        d,
        'device_status',
        { battery: 52 },
        { timestamp: `${base}.1234567890Z` },
      ),
    ]).expect(202);
    expect(tooLong.body.invalid).toBe(1);
    const fall = fallEnvelope(d, {}, { timestamp: `${base}.654321Z` });
    await relay(http, u.token, d, [fall]).expect(202);
    const c = await sosByEvent(prisma, fall.eventId as string);
    expect(c).not.toBeNull();
    expect(c!.triggeredAt!.toISOString()).toBe(`${base}.654Z`);
  });

  it('B5 未知 schemaVersion / 未知 eventType：不出现在 App 事件历史，详情 404；Admin 事件查询照旧可见', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    const admin = await createAdmin(prisma, http, `edge_fix_admin5_${run}`);
    admins.push(admin.username);
    const v999 = envelope(
      d,
      'possible_fall',
      { confidence: 0.9 },
      { schemaVersion: 999 },
    );
    const unknown = envelope(d, `foo_type_${run}`, { a: 1 });
    const known = envelope(d, 'collision_risk', { riskLevel: 'high' });
    expect((await webhook(http, v999).expect(202)).body.invalid).toBe(true);
    expect((await webhook(http, unknown).expect(202)).body.invalid).toBe(false);
    await webhook(http, known).expect(202);
    const list = await request(http)
      .get(`/api/v1/devices/${d}/events`)
      .set(auth(u.token))
      .expect(200);
    expect(list.body.items.map((e: { eventId: string }) => e.eventId)).toEqual([
      known.eventId,
    ]);
    expect(list.body.total).toBe(1);
    for (const id of [v999.eventId, unknown.eventId]) {
      const r = await request(http)
        .get(`/api/v1/events/${id as string}`)
        .set(auth(u.token));
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('NOT_FOUND');
    }
    await request(http)
      .get(`/api/v1/events/${known.eventId as string}`)
      .set(auth(u.token))
      .expect(200);
    // 没建单（原口径不变）
    expect(await prisma.sosCase.count({ where: { deviceId: d } })).toBe(0);
    // Admin 排查：三条都在
    const adm = await adminGet(http, admin.token, '/events', {
      deviceId: d,
    }).expect(200);
    expect(
      adm.body.items.map((e: { eventId: string }) => e.eventId).sort(),
    ).toEqual([v999.eventId, unknown.eventId, known.eventId].sort());
  });

  it('B6 注销：密码超过 72 字节（前 72 字节正确）→ 400 VALIDATION_FAILED，账号原样；正确密码仍能注销', async () => {
    const pw = '密'.repeat(24); // 恰 72 字节
    const u = await newUser(pw);
    const r = await request(http)
      .delete('/api/v1/users/me')
      .set(auth(u.token))
      .send({ password: `${pw}多余的尾巴` });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_FAILED');
    await request(http).get('/api/v1/users/me').set(auth(u.token)).expect(200);
    await request(http)
      .delete('/api/v1/users/me')
      .set(auth(u.token))
      .send({ password: pw })
      .expect(204);
    users.push({ ...u, phone: `deleted:${u.id}` });
  });

  it('B8 EMQX 认证 / 授权回调：username / password / topic 非字符串 → 200 deny（原 500）', async () => {
    const token = process.env.EMQX_INTERNAL_TOKEN ?? 'edge_fix_internal_token';
    if (!process.env.EMQX_INTERNAL_TOKEN)
      process.env.EMQX_INTERNAL_TOKEN = token;
    seq += 1;
    const dev = `edge_fix_${run}_emqx_${seq}`;
    devices.push(dev);
    await prisma.device.create({
      data: {
        deviceId: dev,
        deviceSecretHash: createHash('sha256').update('s3cret').digest('hex'),
        bindCode: `bc_${dev}`,
      },
    });
    const authn = (body: Record<string, unknown>) =>
      request(http)
        .post('/api/v1/internal/emqx/authenticate')
        .set('X-Internal-Token', token)
        .send(body);
    for (const body of [
      { username: [dev], password: 's3cret' },
      { username: { equals: dev }, password: 's3cret' },
      { username: true, password: true },
      { username: dev, password: ['s3cret'] },
      { username: dev, password: 12345 },
      { username: dev, password: { toString: 's3cret' } },
    ]) {
      const r = await authn(body);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ result: 'deny' });
    }
    expect((await authn({ username: dev, password: 's3cret' })).body).toEqual({
      result: 'allow',
    });
  });

  it('B9 请求体嵌套 5000 层（约 25KB）：公开接口与带令牌的写接口一律 400 VALIDATION_FAILED（原 500 栈溢出）；设备入口 payload 嵌套 1990 层仍照收', async () => {
    const u = await newUser();
    const d = await newDevice(u);
    const deep = (n: number) => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
    const json = (r: request.Test, body: string) =>
      r.set('Content-Type', 'application/json').send(body);
    const d5000 = deep(5000);
    const rs = [
      await json(
        request(http).post('/api/v1/auth/login'),
        `{"phone":"13800000000","password":"x","junk":${d5000}}`,
      ),
      await json(
        request(http).post('/api/v1/auth/sms-code'),
        `{"phone":"13800000000","purpose":"register","junk":${d5000}}`,
      ),
      await json(
        request(http).post('/api/v1/admin/auth/login'),
        `{"username":"x","password":"y","junk":${d5000}}`,
      ),
      await json(
        request(http).patch('/api/v1/users/me').set(auth(u.token)),
        `{"nickname":"x","junk":${d5000}}`,
      ),
      await json(
        request(http).put(`/api/v1/devices/${d}/settings`).set(auth(u.token)),
        `{"settings":${d5000}}`,
      ),
      await json(
        request(http).post('/api/v1/ingest/app-relay').set(auth(u.token)),
        `{"deviceId":"${d}","envelopes":[${'['.repeat(5000)}${']'.repeat(5000)}]}`,
      ),
    ];
    expect(rs.map((r) => r.status)).toEqual(Array(6).fill(400));
    expect(rs.every((r) => r.body.code === 'VALIDATION_FAILED')).toBe(true);
    // 设备入口：payload 嵌套 1990 层（总深度约 1993，2000 上限之内）仍照收，且不栈溢出
    const eventId = `edge_fix_deep_${run}`;
    const ok = await json(
      request(http).post('/api/v1/ingest/app-relay').set(auth(u.token)),
      `{"deviceId":"${d}","envelopes":[{"schemaVersion":1,"eventId":"${eventId}","deviceId":"${d}","eventType":"device_status","timestamp":"${new Date().toISOString()}","firmwareVersion":"1","payload":${deep(1990)}}]}`,
    );
    expect(ok.status).toBe(202);
    expect(ok.body).toEqual({ accepted: 1, duplicate: 0, invalid: 0 });
    // 上限之内的深度不会把 Pipe 打爆：登录照常 401、设置照常按校验 400、资料照常 200
    const d1995 = deep(1995);
    const login = await json(
      request(http).post('/api/v1/auth/login'),
      `{"phone":"13800000000","password":"x","junk":${d1995}}`,
    );
    expect(login.status).toBe(401);
    const settings = await json(
      request(http).put(`/api/v1/devices/${d}/settings`).set(auth(u.token)),
      `{"settings":${d1995}}`,
    );
    expect(settings.status).toBe(400);
    const me = await json(
      request(http).patch('/api/v1/users/me').set(auth(u.token)),
      `{"nickname":"深","junk":${d1995}}`,
    );
    expect(me.status).toBe(200);
  });
});
