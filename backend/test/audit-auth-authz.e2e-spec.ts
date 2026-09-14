// 2026-09-13 全面审计 §6（auth）：授权矩阵——两名用户 / 两台设备 / admin / 匿名 / 过期 / 伪造 / alg=none /
// 密钥串用 / 已注销 token，逐个打全部资源接口；资源 ID 枚举口径（404 vs 403）；PATCH /users/me 白名单。
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
  sleep,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  createAdmin,
  evidence,
  noneAlgToken,
  signUserJwt,
  signWithSecret,
} from './helpers/audit-auth';

jest.setTimeout(180_000);

const LOG = 'authz.log';
const run = Date.now().toString(36);

interface Probe {
  name: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  body?: Record<string, unknown>;
  /** A 自己访问时的期望（2xx） */
  ownerOk: number;
  /** 写操作在 owner 期望列里只做一次，避免改变状态；矩阵里对 owner 只探 GET */
  mutating?: boolean;
}

describe('审计 §6：授权矩阵 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let a: TestUser;
  let b: TestUser;
  let deletedUser: TestUser;
  let adminToken: string;
  let adminId: string;
  const d1 = `audit_authz_d1_${run}`;
  const d2 = `audit_authz_d2_${run}`;
  const ids = {
    riskEventA: '',
    riskEventB: '',
    sosA: '',
    contactA: '',
    channelA: '',
    commandA: '',
    mediaA: '',
    accidentA: '',
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    a = await createUser(app, http);
    b = await createUser(app, http);
    deletedUser = await createUser(app, http);
    await provisionDevice(prisma, d1);
    await provisionDevice(prisma, d2);
    await bindDevice(http, a.token, d1);
    await bindDevice(http, b.token, d2);

    // A 的资源：风险事件、SOS（possible_fall → pending）、联系人、频道、命令、媒体
    const riskA = envelope(d1, 'collision_risk', { riskLevel: 'high' });
    const fallA = envelope(d1, 'possible_fall', { confidence: 0.9 });
    await relay(http, a.token, d1, [
      envelope(d1, 'location_update', validLocation(1)),
      riskA,
      fallA,
    ]).expect(202);
    ids.riskEventA = riskA.eventId as string;
    const riskB = envelope(d2, 'obstacle_risk', {});
    await relay(http, b.token, d2, [riskB]).expect(202);
    ids.riskEventB = riskB.eventId as string;
    const active = await request(http)
      .get(`/api/v1/devices/${d1}/sos/active`)
      .set(auth(a.token))
      .expect(200);
    ids.sosA = active.body.sos.sosId as string;
    ids.accidentA = ids.sosA;
    const contact = await request(http)
      .post('/api/v1/users/me/emergency-contacts')
      .set(auth(a.token))
      .send({ name: '审计联系人', phone: '19900000001' })
      .expect(201);
    ids.contactA = contact.body.id as string;
    const channel = await request(http)
      .post('/api/v1/voice/channels')
      .set(auth(a.token))
      .send({ name: `audit_${run}` })
      .expect(201);
    ids.channelA = channel.body.channelId as string;
    const cmd = await request(http)
      .put(`/api/v1/devices/${d1}/settings`)
      .set(auth(a.token))
      .send({ settings: { volume: 5 } })
      .expect(202);
    ids.commandA = (cmd.body.command?.id ??
      cmd.body.id ??
      cmd.body.commandId) as string;
    // 媒体：直接建元数据行（video_ready 不在 BLE 中转白名单；与 MQTT 入口落库结果等价）
    const media = await prisma.media.create({
      data: {
        eventId: randomUUID(),
        deviceId: d1,
        videoId: `vid_${run}`,
        relatedEventId: ids.riskEventA,
        storageKey: `mock/${d1}/vid.mp4`,
        status: 'ready',
      },
    });
    ids.mediaA = media.id;

    // admin
    const admin = await createAdmin(prisma, http, run);
    adminToken = admin.token;
    adminId = admin.id;

    // 已注销用户的残留 token
    await request(http)
      .delete('/api/v1/users/me')
      .set(auth(deletedUser.token))
      .send({ password: deletedUser.password })
      .expect(204);
    evidence(
      LOG,
      `=== run ${run} 种子完成：sos=${ids.sosA} cmd=${ids.commandA} ===`,
    );
  });

  afterAll(async () => {
    await prisma.sosNotification
      .deleteMany({ where: { sos: { deviceId: { in: [d1, d2] } } } })
      .catch(() => undefined);
    await cleanupDevices(prisma, [d1, d2]);
    await prisma.voiceChannelMember
      .deleteMany({ where: { channelId: ids.channelA } })
      .catch(() => undefined);
    await prisma.voiceChannel
      .deleteMany({ where: { id: ids.channelA } })
      .catch(() => undefined);
    await cleanupUsers(prisma, [a, b, deletedUser]);
    await prisma.adminUser
      .deleteMany({ where: { id: adminId } })
      .catch(() => undefined);
    await app.close();
  });

  const probes = (): Probe[] => [
    { name: '设备详情', method: 'get', path: `/devices/${d1}`, ownerOk: 200 },
    {
      name: '设备状态',
      method: 'get',
      path: `/devices/${d1}/status`,
      ownerOk: 200,
    },
    {
      name: '电量历史',
      method: 'get',
      path: `/devices/${d1}/battery-history`,
      ownerOk: 200,
    },
    {
      name: '重命名',
      method: 'patch',
      path: `/devices/${d1}`,
      body: { name: 'x' },
      ownerOk: 200,
      mutating: true,
    },
    {
      name: '解绑',
      method: 'delete',
      path: `/devices/${d1}/binding`,
      ownerOk: 204,
      mutating: true,
    },
    {
      name: '轨迹 latest',
      method: 'get',
      path: `/devices/${d1}/locations/latest`,
      ownerOk: 200,
    },
    {
      name: '轨迹 range',
      method: 'get',
      path: `/devices/${d1}/locations?from=${new Date(Date.now() - 3600_000).toISOString()}&to=${new Date().toISOString()}`,
      ownerOk: 200,
    },
    {
      name: '事件列表',
      method: 'get',
      path: `/devices/${d1}/events`,
      ownerOk: 200,
    },
    {
      name: '事件详情',
      method: 'get',
      path: `/events/${ids.riskEventA}`,
      ownerOk: 200,
    },
    {
      name: '媒体 URL',
      method: 'get',
      path: `/media/${ids.mediaA}/url`,
      ownerOk: 200,
    },
    {
      name: 'SOS active',
      method: 'get',
      path: `/devices/${d1}/sos/active`,
      ownerOk: 200,
    },
    {
      name: '事故列表',
      method: 'get',
      path: `/devices/${d1}/accidents`,
      ownerOk: 200,
    },
    {
      name: '事故详情',
      method: 'get',
      path: `/accidents/${ids.accidentA}`,
      ownerOk: 200,
    },
    {
      name: 'SOS cancel',
      method: 'post',
      path: `/sos/${ids.sosA}/cancel`,
      ownerOk: 200,
      mutating: true,
    },
    {
      name: 'SOS confirm',
      method: 'post',
      path: `/sos/${ids.sosA}/confirm`,
      ownerOk: 200,
      mutating: true,
    },
    {
      name: '联系人改',
      method: 'patch',
      path: `/users/me/emergency-contacts/${ids.contactA}`,
      body: { name: 'y' },
      ownerOk: 200,
      mutating: true,
    },
    {
      name: '联系人删',
      method: 'delete',
      path: `/users/me/emergency-contacts/${ids.contactA}`,
      ownerOk: 204,
      mutating: true,
    },
    {
      name: '频道成员',
      method: 'get',
      path: `/voice/channels/${ids.channelA}/members`,
      ownerOk: 200,
    },
    {
      name: '频道 token',
      method: 'post',
      path: `/voice/channels/${ids.channelA}/token`,
      ownerOk: 201,
      mutating: true,
    },
    {
      name: '频道离开',
      method: 'delete',
      path: `/voice/channels/${ids.channelA}/membership`,
      ownerOk: 204,
      mutating: true,
    },
    {
      name: '设置读',
      method: 'get',
      path: `/devices/${d1}/settings`,
      ownerOk: 200,
    },
    {
      name: '设置写',
      method: 'put',
      path: `/devices/${d1}/settings`,
      body: { settings: { volume: 1 } },
      ownerOk: 202,
      mutating: true,
    },
    {
      name: '命令列表',
      method: 'get',
      path: `/devices/${d1}/commands`,
      ownerOk: 200,
    },
    {
      name: '命令详情',
      method: 'get',
      path: `/commands/${ids.commandA}`,
      ownerOk: 200,
    },
    {
      name: 'relay-ack',
      method: 'post',
      path: `/devices/${d1}/commands/${ids.commandA}/relay-ack`,
      body: { stage: 'delivered' },
      ownerOk: 200,
      mutating: true,
    },
    {
      name: 'app-relay 替他人设备中转',
      method: 'post',
      path: `/ingest/app-relay`,
      body: {
        deviceId: d1,
        envelopes: [envelope(d1, 'location_update', validLocation(2))],
      },
      ownerOk: 202,
      mutating: true,
    },
  ];

  const call = (p: Probe, token: string | null): request.Test => {
    let t = request(http)[p.method](`/api/v1${p.path}`);
    if (token !== null) t = t.set(auth(token));
    if (p.body) t = t.send(p.body);
    return t;
  };

  it('A 本人：全部只读探针 2xx（矩阵基线）', async () => {
    for (const p of probes().filter((x) => !x.mutating)) {
      const r = await call(p, a.token);
      evidence(LOG, `owner ${p.name} → ${r.status}`);
      expect(r.status).toBe(p.ownerOk);
    }
  });

  it('B（另一普通用户）访问 A 的全部资源：一律 404（不泄露存在性），无 403/5xx，状态不被改动', async () => {
    const statuses: Record<string, number> = {};
    for (const p of probes()) {
      const r = await call(p, b.token);
      statuses[p.name] = r.status;
      evidence(LOG, `cross-user ${p.name} → ${r.status} ${r.body?.code ?? ''}`);
    }
    const nonOk = Object.entries(statuses).filter(([, s]) => s !== 404);
    expect(nonOk).toEqual([]);
    // 状态未被越权改动
    const sos = await prisma.sosCase.findUnique({ where: { id: ids.sosA } });
    expect(sos?.status).toBe('pending');
    const cmd = await prisma.deviceCommand.findUnique({
      where: { id: ids.commandA },
    });
    expect(cmd?.status).toBe('pending');
    const contact = await prisma.emergencyContact.findUnique({
      where: { id: ids.contactA },
    });
    expect(contact?.deletedAt).toBeNull();
    expect(contact?.name).toBe('审计联系人');
    expect(
      await prisma.voiceChannelMember.count({
        where: { channelId: ids.channelA, userId: a.id },
      }),
    ).toBe(1);
    const dev = await prisma.device.findUnique({ where: { deviceId: d1 } });
    expect(dev?.bindUserId).toBe(a.id);
    expect(dev?.name).toBeNull();
  });

  it('跨设备 eventId / commandId：B 用自己的设备路径 + A 的 ID → 404', async () => {
    await request(http)
      .post(`/api/v1/devices/${d2}/commands/${ids.commandA}/relay-ack`)
      .set(auth(b.token))
      .send({ stage: 'delivered' })
      .expect(404);
    await request(http)
      .get(`/api/v1/events/${ids.riskEventB}`)
      .set(auth(a.token))
      .expect(404);
    await request(http)
      .get(`/api/v1/events/${ids.riskEventA}`)
      .set(auth(b.token))
      .expect(404);
  });

  it('匿名 / 过期 / 伪造签名 / alg=none / admin 密钥签的用户 token / 已注销用户 token：用户接口一律 401', async () => {
    const expired = await signUserJwt(app, { sub: a.id }, '-1s');
    const forged = `${a.token.slice(0, -6)}abcdef`;
    const none = noneAlgToken({ sub: a.id });
    const adminKeyed = signWithSecret(process.env.ADMIN_JWT_SECRET!, {
      sub: a.id,
    });
    const cases: Array<[string, string | null]> = [
      ['匿名', null],
      ['过期 access', expired],
      ['篡改签名', forged],
      ['alg=none', none],
      ['admin 密钥签的 sub=A', adminKeyed],
      ['已注销用户残留 access', deletedUser.token],
    ];
    for (const [label, token] of cases) {
      for (const p of probes()) {
        const r = await call(p, token);
        if (r.status !== 401)
          evidence(LOG, `!! ${label} ${p.name} → ${r.status}`);
        expect(`${label} ${p.name} ${r.status}`).toBe(`${label} ${p.name} 401`);
      }
      evidence(LOG, `${label}：${probes().length} 个探针全部 401`);
    }
  });

  it('Admin 隔离：用户 token / 用户密钥签 typ=admin / admin 密钥签无 typ → admin 接口 401；admin token 进用户接口 401', async () => {
    const adminRoutes = [
      '/admin/users',
      '/admin/devices',
      `/admin/devices/${d1}`,
      '/admin/accidents',
      '/admin/events',
      '/admin/stats/overview',
    ];
    const userKeyedAdmin = await signUserJwt(app, {
      sub: adminId,
      typ: 'admin',
    });
    const adminNoTyp = signWithSecret(process.env.ADMIN_JWT_SECRET!, {
      sub: adminId,
    });
    const bad: Array<[string, string | null]> = [
      ['用户 token', a.token],
      ['用户密钥 typ=admin', userKeyedAdmin],
      ['admin 密钥无 typ', adminNoTyp],
      ['匿名', null],
    ];
    for (const [label, token] of bad) {
      for (const path of adminRoutes) {
        let t = request(http).get(`/api/v1${path}`);
        if (token) t = t.set(auth(token));
        const r = await t;
        expect(`${label} ${path} ${r.status}`).toBe(`${label} ${path} 401`);
      }
    }
    for (const path of adminRoutes) {
      const r = await request(http).get(`/api/v1${path}`).set(auth(adminToken));
      expect(`${path} ${r.status}`).toBe(`${path} 200`);
    }
    // admin token 进用户接口
    for (const p of probes().filter((x) => !x.mutating)) {
      const r = await call(p, adminToken);
      expect(`${p.name} ${r.status}`).toBe(`${p.name} 401`);
    }
    // Admin 不受绑定区间限制（决策 #39）：能看到 d1 的事件与 A 的事故
    const adminEvents = await request(http)
      .get(`/api/v1/admin/events?deviceId=${d1}`)
      .set(auth(adminToken))
      .expect(200);
    evidence(
      LOG,
      `admin /admin/events?deviceId=d1 total=${adminEvents.body.total}`,
    );
  });

  it('PATCH /users/me 白名单：phone / passwordHash / deletedAt / id 传入被丢弃，只改昵称', async () => {
    const before = await prisma.user.findUnique({ where: { id: a.id } });
    const r = await request(http)
      .patch('/api/v1/users/me')
      .set(auth(a.token))
      .send({
        nickname: '审计昵称',
        phone: '19900000009',
        passwordHash: 'hacked',
        deletedAt: null,
        id: b.id,
        createdAt: '2000-01-01T00:00:00Z',
      })
      .expect(200);
    expect(r.body.phone).toBe(a.phone);
    const after = await prisma.user.findUnique({ where: { id: a.id } });
    expect(after?.phone).toBe(before?.phone);
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.nickname).toBe('审计昵称');
    expect(after?.createdAt.toISOString()).toBe(
      before?.createdAt.toISOString(),
    );
    // 联系人 / 设备重命名 / 频道 的 body 也走 whitelist：塞 userId/ownerId 不生效
    const c = await request(http)
      .patch(`/api/v1/users/me/emergency-contacts/${ids.contactA}`)
      .set(auth(a.token))
      .send({ name: '审计联系人', userId: b.id, id: 'x' })
      .expect(200);
    expect(c.body.id).toBe(ids.contactA);
    const contact = await prisma.emergencyContact.findUnique({
      where: { id: ids.contactA },
    });
    expect(contact?.userId).toBe(a.id);
    const dev = await request(http)
      .patch(`/api/v1/devices/${d1}`)
      .set(auth(a.token))
      .send({
        name: 'my helmet',
        bindUserId: b.id,
        bindCode: 'zzzz',
        settings: { volume: 9 },
      })
      .expect(200);
    expect(dev.body.name).toBe('my helmet');
    const devRow = await prisma.device.findUnique({ where: { deviceId: d1 } });
    expect(devRow?.bindUserId).toBe(a.id);
    expect(devRow?.bindCode).toBe(`bc_${d1}`);
    expect(devRow?.settings).toBeNull();
  });

  it('不存在的资源 ID 与他人资源同为 404（枚举口径一致）；sub 指向不存在用户的合法 token 不 5xx', async () => {
    const ghost = await signUserJwt(app, { sub: 'audit_ghost_user_id' });
    const results: string[] = [];
    for (const p of probes().filter((x) => !x.mutating)) {
      const r = await call(p, ghost);
      results.push(`${p.name}=${r.status}`);
      expect(r.status).toBeLessThan(500);
    }
    evidence(LOG, `ghost sub token 只读探针 → ${results.join(' ')}`);
    const missing = [
      `/devices/no_such_${run}`,
      `/events/${randomUUID()}`,
      `/media/no_such_${run}/url`,
      `/accidents/no_such_${run}`,
      `/commands/no_such_${run}`,
      `/voice/channels/no_such_${run}/members`,
    ];
    for (const path of missing) {
      const r = await request(http).get(`/api/v1${path}`).set(auth(a.token));
      expect(`${path} ${r.status}`).toBe(`${path} 404`);
    }
    await sleep(10);
  });
});
