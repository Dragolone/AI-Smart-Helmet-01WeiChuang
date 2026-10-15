// 2026-10-16 边界测试：WebSocket 实时通道（API.md §11）。
// 握手 token 的书写变体、换绑 / 解绑后推送对象的切换、原主解绑后处置旧单仍收到 sos_update、
// 不该推的事件（坏载荷、未知版本、未知类型）不推。
import { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import {
  collectWs,
  waitClose,
  waitFor,
  waitOpen,
  webhook,
  wsUrlOf,
} from './helpers/audit-ingest';
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

jest.setTimeout(120_000);

interface GatewayInternals {
  byUser: Map<string, Set<WebSocket>>;
}

describe('边界：实时通道 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let internals: GatewayInternals;
  const run = Date.now();
  const users: TestUser[] = [];
  const devices: string[] = [];
  const sockets: WebSocket[] = [];
  let seq = 0;

  const newUser = async (): Promise<TestUser> => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };
  const newDevice = async (u: TestUser): Promise<string> => {
    seq += 1;
    const id = `edge_ws_${run}_${seq}`;
    devices.push(id);
    await provisionDevice(prisma, id);
    await bindDevice(http, u.token, id);
    return id;
  };
  const rawConnect = (path: string): WebSocket => {
    const base = wsUrlOf(app, '').replace(/\/ws\?token=$/, '');
    const ws = new WebSocket(`${base}${path}`);
    sockets.push(ws);
    return ws;
  };
  /** 连上并等到服务端把连接登记进推送表（客户端 open ≠ 已订阅，见 audit-realtime 注释） */
  const connectReady = async (u: TestUser) => {
    const before = internals.byUser.get(u.id)?.size ?? 0;
    const ws = rawConnect(`/ws?token=${encodeURIComponent(u.token)}`);
    const box = collectWs<Record<string, unknown>>(ws);
    await waitOpen(ws);
    await waitFor(() => (internals.byUser.get(u.id)?.size ?? 0) > before);
    return { ws, messages: box.messages };
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    internals = app.get<RealtimeGateway, GatewayInternals>(RealtimeGateway);
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  describe('握手 token 变体', () => {
    it('token 为空 / 带 Bearer 前缀 / 首尾空格（编码后）/ 被截断一位 → 4401', async () => {
      const u = await newUser();
      for (const q of [
        'token=',
        `token=${encodeURIComponent(`Bearer ${u.token}`)}`,
        `token=${encodeURIComponent(` ${u.token}`)}`,
        `token=${u.token.slice(0, -1)}`,
      ]) {
        const ws = rawConnect(`/ws?${q}`);
        expect(await waitClose(ws)).toBe(4401);
      }
    });

    it('只放在 Authorization 头里、不带 query → 4401（只认查询参数，API.md §11）', async () => {
      const u = await newUser();
      const base = wsUrlOf(app, '').replace(/\?token=$/, '');
      const ws = new WebSocket(base, {
        headers: { Authorization: `Bearer ${u.token}` },
      });
      sockets.push(ws);
      expect(await waitClose(ws)).toBe(4401);
    });

    it('重复的 token 参数：取第一个——坏的在前 4401，好的在前正常连上', async () => {
      const u = await newUser();
      const bad = rawConnect(`/ws?token=garbage&token=${u.token}`);
      expect(await waitClose(bad)).toBe(4401);
      const before = internals.byUser.get(u.id)?.size ?? 0;
      const good = rawConnect(`/ws?token=${u.token}&token=garbage`);
      await waitOpen(good);
      await waitFor(() => (internals.byUser.get(u.id)?.size ?? 0) > before);
      good.close();
    });

    it('token 前后还有别的查询参数（?v=2&token=…&x=1）照常连上', async () => {
      const u = await newUser();
      const before = internals.byUser.get(u.id)?.size ?? 0;
      const ws = rawConnect(`/ws?v=2&token=${u.token}&x=1`);
      await waitOpen(ws);
      await waitFor(() => (internals.byUser.get(u.id)?.size ?? 0) > before);
      ws.close();
    });
  });

  describe('推送对象随绑定切换', () => {
    it('A 解绑、B 绑定后：location_update 只推给 B，A 的连接一条都收不到', async () => {
      const a = await newUser();
      const b = await newUser();
      const d = await newDevice(a);
      const wa = await connectReady(a);
      await relay(http, a.token, d, [
        envelope(d, 'location_update', validLocation(1)),
      ]).expect(202);
      await waitFor(() =>
        wa.messages.some((m) => m.type === 'location_update'),
      );
      await request(http)
        .delete(`/api/v1/devices/${d}/binding`)
        .set(auth(a.token))
        .expect(204);
      await bindDevice(http, b.token, d);
      const wb = await connectReady(b);
      const countA = wa.messages.length;
      await relay(http, b.token, d, [
        envelope(d, 'location_update', validLocation(2)),
      ]).expect(202);
      await waitFor(() =>
        wb.messages.some((m) => m.type === 'location_update'),
      );
      await sleep(200);
      expect(wa.messages.length).toBe(countA);
      wa.ws.close();
      wb.ws.close();
    });

    it('原主解绑后凭 sosId 取消旧单：sos_update(cancelled) 仍推给原主（推送跟单的建单用户走）', async () => {
      const a = await newUser();
      const d = await newDevice(a);
      const f = envelope(d, 'possible_fall', { confidence: 0.9 });
      await relay(http, a.token, d, [f]).expect(202);
      const c = await prisma.sosCase.findFirstOrThrow({
        where: { triggerEventId: f.eventId as string },
      });
      await request(http)
        .delete(`/api/v1/devices/${d}/binding`)
        .set(auth(a.token))
        .expect(204);
      const wa = await connectReady(a);
      await request(http)
        .post(`/api/v1/sos/${c.id}/cancel`)
        .set(auth(a.token))
        .expect(200);
      await waitFor(() =>
        wa.messages.some(
          (m) =>
            m.type === 'sos_update' &&
            (m.data as { sosId?: string }).sosId === c.id &&
            (m.data as { status?: string }).status === 'cancelled',
        ),
      );
      wa.ws.close();
    });
  });

  describe('不该推的不推', () => {
    it('坏载荷的 location_update、未知版本的 possible_fall、webhook 来的未知类型：都不推；随后一条正常心跳照推', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const w = await connectReady(u);
      await relay(http, u.token, d, [
        envelope(d, 'location_update', { ...validLocation(), latitude: 91 }),
        envelope(d, 'possible_fall', { confidence: 0.9 }, { schemaVersion: 2 }),
      ]).expect(202);
      await webhook(http, envelope(d, `unknown_${run}`, {})).expect(202);
      await relay(http, u.token, d, [
        envelope(d, 'device_status', { battery: 77 }),
      ]).expect(202);
      await waitFor(() => w.messages.some((m) => m.type === 'device_status'));
      expect(w.messages.map((m) => m.type)).toEqual(['device_status']);
      expect(await prisma.sosCase.count({ where: { deviceId: d } })).toBe(0);
      w.ws.close();
    });

    it('重复 eventId 的事件不重复推（幂等挡在推送之前）', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const w = await connectReady(u);
      const e = envelope(d, 'collision_risk', { riskLevel: 'high' });
      await relay(http, u.token, d, [e, e]).expect(202);
      await relay(http, u.token, d, [e]).expect(202);
      await waitFor(() => w.messages.some((m) => m.type === 'risk_event'));
      await sleep(200);
      expect(w.messages.filter((m) => m.type === 'risk_event')).toHaveLength(1);
      w.ws.close();
    });

    it('未绑定设备（无人可推）的事件：不抛错，接口照常 202', async () => {
      seq += 1;
      const free = `edge_ws_${run}_free_${seq}`;
      devices.push(free);
      await provisionDevice(prisma, free);
      const r = await webhook(
        http,
        envelope(free, 'collision_risk', { riskLevel: 'low' }),
      );
      expect(r.status).toBe(202);
      expect(r.body).toMatchObject({ duplicate: false, invalid: false });
    });
  });
});
