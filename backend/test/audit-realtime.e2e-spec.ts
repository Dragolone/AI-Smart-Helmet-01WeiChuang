// 2026-09-13 交付审计 §7：WebSocket 实时通道（API.md §11）——鉴权关闭码、token 到期、重连后 REST 兜底、
// 慢客户端不拖慢广播、垃圾帧、断开清理（网关私有 Map）、多连接广播、注销账号已建连接、连接补推。
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { Socket } from 'node:net';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  sleep,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  collectWs,
  waitClose,
  waitFor,
  waitOpen,
  wsUrlOf,
} from './helpers/audit-ingest';

jest.setTimeout(120_000);

interface GatewayInternals {
  byUser: Map<string, Set<WebSocket>>;
  clientUser: Map<WebSocket, string>;
  expiryTimers: Map<WebSocket, NodeJS.Timeout>;
}

describe('审计 §7：WebSocket 实时通道 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let jwt: JwtService;
  let internals: GatewayInternals;

  const run = Date.now();
  const deviceId = `audit_ws_${run}`;
  let owner: TestUser;
  let other: TestUser;
  const sockets: WebSocket[] = [];
  const users: TestUser[] = [];

  const connect = (token: string | null): WebSocket => {
    const url =
      token === null
        ? wsUrlOf(app, '').replace('?token=', '')
        : wsUrlOf(app, token);
    const ws = new WebSocket(url);
    sockets.push(ws);
    return ws;
  };

  const pushLocation = (i: number) =>
    ingest.ingestRaw(
      JSON.stringify(envelope(deviceId, 'location_update', validLocation(i))),
      deviceId,
      'app_relay',
    );

  beforeAll(async () => {
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    process.env.COMMAND_SCAN_INTERVAL_MS = '600000';
    ({ app, http, prisma } = await buildApp());
    ingest = app.get(IngestService);
    jwt = app.get(JwtService);
    internals = app.get(RealtimeGateway);
    owner = await createUser(app, http);
    other = await createUser(app, http);
    users.push(owner, other);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, owner.token, deviceId);
  });

  // 网关的三张 Map 以服务端侧 socket 为键，客户端对象不可作键：一律按计数/用户条目断言。
  // 每个用例结束把本用例的连接全部收掉并等网关清空，避免上一用例残留影响计数。
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await waitFor(() => internals.clientUser.size === 0, 5000).catch(
      () => undefined,
    );
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await cleanupDevices(prisma, [deviceId]);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  it('缺失 / 乱码 / 伪造签名 / 已过期 token：均以 4401 关闭，且不进入连接表', async () => {
    const forged = await new JwtService({
      secret: 'not_the_real_secret',
    }).signAsync({
      sub: owner.id,
    });
    const expired = await jwt.signAsync(
      { sub: owner.id },
      { expiresIn: '-5s' },
    );
    const codes = await Promise.all(
      [null, 'garbage.token.value', forged, expired].map((t) =>
        waitClose(connect(t)),
      ),
    );
    expect(codes).toEqual([4401, 4401, 4401, 4401]);
    expect(internals.byUser.get(owner.id)?.size ?? 0).toBe(0);
  });

  it('短 exp token：到期即 4401 关闭；定时器与连接表同步清理；到期前推送正常', async () => {
    const timersBefore = internals.expiryTimers.size;
    const short = await jwt.signAsync({ sub: owner.id }, { expiresIn: '2s' });
    const ws = connect(short);
    await waitOpen(ws);
    const loc = collectWs(ws, 'location_update');
    await pushLocation(1);
    await waitFor(() => loc.messages.length === 1);
    expect(internals.expiryTimers.size).toBe(timersBefore + 1);
    expect(internals.byUser.get(owner.id)?.size).toBe(1);
    const t0 = Date.now();
    const code = await waitClose(ws, 5000);
    expect(code).toBe(4401);
    expect(Date.now() - t0).toBeLessThan(3000);
    await waitFor(
      () =>
        internals.expiryTimers.size === timersBefore &&
        internals.clientUser.size === 0,
    );
    expect(internals.byUser.has(owner.id)).toBe(false);
  });

  it('重连语义：断线期间的推送不补发（加速通道）；重连后 REST latest/轨迹 能拿到全部点（兜底）', async () => {
    const ws1 = connect(owner.token);
    await waitOpen(ws1);
    const c1 = collectWs<{ latitude: number }>(ws1, 'location_update');
    await pushLocation(10);
    await waitFor(() => c1.messages.length === 1);
    ws1.close();
    await waitClose(ws1);
    // 离线期间两条
    await pushLocation(11);
    await pushLocation(12);
    const ws2 = connect(owner.token);
    await waitOpen(ws2);
    const c2 = collectWs<{ latitude: number }>(ws2, 'location_update');
    await sleep(200);
    expect(c2.messages).toHaveLength(0); // 不补发历史
    await pushLocation(13);
    await waitFor(() => c2.messages.length === 1);
    expect(c1.messages).toHaveLength(1);

    const latest = await request(http)
      .get(`/api/v1/devices/${deviceId}/locations/latest`)
      .set(auth(owner.token))
      .expect(200);
    expect(latest.body.location.latitude).toBeCloseTo(31.2 + 13 * 0.0001, 6);
    const to = new Date(Date.now() + 60_000).toISOString();
    const from = new Date(Date.now() - 60_000).toISOString();
    const track = await request(http)
      .get(
        `/api/v1/devices/${deviceId}/locations?from=${from}&to=${to}&pageSize=100`,
      )
      .set(auth(owner.token))
      .expect(200);
    const lats = (track.body.items as Array<{ latitude: number }>).map(
      (p) => p.latitude,
    );
    for (const i of [10, 11, 12, 13]) {
      expect(lats.some((l) => Math.abs(l - (31.2 + i * 0.0001)) < 1e-6)).toBe(
        true,
      );
    }
    ws2.close();
  });

  it('慢客户端（socket 暂停不读）不拖慢同用户其他连接：推送入库后服务端对其他连接全部刷出、其他连接全收；慢连接仍在线且未消费', async () => {
    const slow = connect(owner.token);
    await waitOpen(slow);
    const fast = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const ws = connect(owner.token);
        await waitOpen(ws);
        return ws;
      }),
    );
    const collectors = fast.map((ws) => collectWs(ws, 'location_update'));
    // 暂停慢客户端的底层 socket：内核接收缓冲填满后服务端 send 只能堆在用户态缓冲
    (slow as unknown as { _socket: Socket })._socket.pause();
    const slowCollector = collectWs(slow, 'location_update');

    // 40 条：足以暴露"逐连接串行等待"类的队头阻塞，又让每个客户端收到的总量（≈10KB）低于
    // ws 客户端 Receiver 的 16KB 水位——超过水位会走 socket.pause/drain 流控，在 GitHub 2 核 runner 上
    // 曾出现 2/5 个客户端停在 198/200 再也不动（2026-09-18 CI，服务端 send 无一失败）。
    // 那是测试进程里 ws 客户端的流控边界，不是服务端行为，本用例不该踩它。
    const N = 40;
    for (let i = 0; i < N; i += 1) {
      await pushLocation(1000 + i);
    }
    // 服务端视角的隔离性：其他连接的发送缓冲已全部刷进内核（服务端没有被慢连接拖住）
    const serverSockets = [...(internals.byUser.get(owner.id) ?? [])];
    expect(serverSockets).toHaveLength(6);
    await waitFor(
      () => serverSockets.filter((ws) => ws.bufferedAmount === 0).length >= 5,
      5000,
    ).catch((err: Error) => {
      throw new Error(
        `${err.message}：服务端各连接 bufferedAmount=${serverSockets.map((ws) => ws.bufferedAmount).join('/')}`,
      );
    });
    // 客户端视角：其他连接收齐。不对耗时设上限——若服务端真有队头阻塞，慢连接暂停期间这里永远收不齐，
    // 多长预算都会超时（超时即缺陷）；预算只是给慢 runner 的余量
    const t0 = Date.now();
    await waitFor(
      () => collectors.every((c) => c.messages.length >= N),
      30_000,
    ).catch((err: Error) => {
      throw new Error(
        `${err.message}：快连接各收 ${collectors.map((c) => c.messages.length).join('/')} 条，慢连接 ${slowCollector.messages.length} 条，byUser=${internals.byUser.get(owner.id)?.size ?? 0}`,
      );
    });
    console.log(`慢客户端用例：快连接收齐 ${N} 条耗时 ${Date.now() - t0}ms`);
    // 慢连接没有拖住主流程：服务端仍认为它在线（未被踢），推送尚未被它消费
    expect(internals.byUser.get(owner.id)?.size).toBe(6);
    expect(slowCollector.messages.length).toBeLessThan(N);
    (slow as unknown as { _socket: Socket })._socket.resume();
    await waitFor(() => slowCollector.messages.length >= N, 10_000);
    for (const ws of [slow, ...fast]) ws.close();
    await waitFor(() => (internals.byUser.get(owner.id)?.size ?? 0) === 0);
  });

  it('客户端上行垃圾帧：1MB 二进制 / 非 JSON / 伪造 device_command / 伪造 sos_update → 连接不断、不产生命令或 SOS、后续推送正常', async () => {
    const ws = connect(owner.token);
    await waitOpen(ws);
    const loc = collectWs(ws, 'location_update');
    const cmdBefore = await prisma.deviceCommand.count({ where: { deviceId } });
    const sosBefore = await prisma.sosCase.count({ where: { deviceId } });
    ws.send(Buffer.alloc(1024 * 1024, 7));
    ws.send('not json at all');
    ws.send(
      JSON.stringify({
        type: 'device_command',
        data: {
          deviceId,
          commandId: 'forged',
          type: 'set_config',
          params: { volume: 1 },
        },
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'sos_update',
        data: { deviceId, status: 'notified' },
      }),
    );
    ws.send(
      JSON.stringify({
        event: 'subscribe',
        data: { deviceId: 'someone_else' },
      }),
    );
    await sleep(300);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await pushLocation(2000);
    await waitFor(() => loc.messages.length === 1);
    expect(await prisma.deviceCommand.count({ where: { deviceId } })).toBe(
      cmdBefore,
    );
    expect(await prisma.sosCase.count({ where: { deviceId } })).toBe(sosBefore);
    ws.close();
    await waitClose(ws);
  });

  it('多连接广播与断开清理：同用户 4 连接全收、他人 0 收；close/terminate 混合断开后三张私有 Map 均无残留', async () => {
    const mine = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const ws = connect(owner.token);
        await waitOpen(ws);
        return ws;
      }),
    );
    const theirs = connect(other.token);
    await waitOpen(theirs);
    const mineC = mine.map((ws) => collectWs(ws, 'location_update'));
    const theirsC = collectWs(theirs, 'location_update');
    await pushLocation(3000);
    await waitFor(() => mineC.every((c) => c.messages.length === 1));
    await sleep(200);
    expect(theirsC.messages).toHaveLength(0);
    expect(internals.byUser.get(owner.id)?.size).toBe(4);

    mine[0].close();
    mine[1].terminate();
    mine[2].close();
    mine[3].terminate();
    theirs.close();
    await waitFor(
      () =>
        !internals.byUser.has(owner.id) &&
        !internals.byUser.has(other.id) &&
        internals.clientUser.size === 0 &&
        internals.expiryTimers.size === 0,
    );
  });

  it('连接补推：绑定设备 pending/delivered 命令按 issuedAt 升序补推；offline / success 不补推；他人连接不收', async () => {
    const base = Date.now();
    const mk = (status: string, offsetMs: number) =>
      prisma.deviceCommand.create({
        data: {
          deviceId,
          type: 'set_config',
          params: { k: status },
          issuedBy: owner.id,
          status,
          issuedAt: new Date(base + offsetMs),
        },
      });
    const delivered = await mk('delivered', 0);
    const pending = await mk('pending', 10);
    await mk('offline', 20);
    await mk('success', 30);
    try {
      const ws = connect(owner.token);
      const cmds = collectWs<{ commandId: string }>(ws, 'device_command');
      await waitOpen(ws);
      await waitFor(() => cmds.messages.length >= 2);
      await sleep(200);
      expect(cmds.messages.map((m) => m.data.commandId)).toEqual([
        delivered.id,
        pending.id,
      ]);
      const ws2 = connect(other.token);
      const cmds2 = collectWs(ws2, 'device_command');
      await waitOpen(ws2);
      await sleep(200);
      expect(cmds2.messages).toHaveLength(0);
      ws.close();
      ws2.close();
    } finally {
      await prisma.deviceCommand.deleteMany({ where: { deviceId } });
    }
  });

  // 【INGEST-04 缺陷断言】API.md §11「连接不比凭证活得久」+ §2 注销撤销全部会话（PR #61：残留 token 全接口 401）。
  // 网关只在握手时查 deletedAt，注销时不遍历已建连接——注销后同一 token 的旧连接会继续收到推送直到 exp（≤15min）。
  it('【INGEST-04 缺陷断言】注销账号：已建立的 WS 连接应在注销后被服务端以 4401 关闭；同 token 重连 4401', async () => {
    const victim = await createUser(app, http);
    users.push(victim);
    const vDevice = `audit_wsdel_${run}`;
    await provisionDevice(prisma, vDevice);
    await bindDevice(http, victim.token, vDevice);
    const ws = connect(victim.token);
    await waitOpen(ws);
    const closeCode = waitClose(ws, 3000).catch(() => 'still_open' as const);
    await request(http)
      .delete('/api/v1/users/me')
      .set(auth(victim.token))
      .send({ password: victim.password })
      .expect(204);
    // 注销后的新连接必须被拒（握手时校验 deletedAt）——这条应通过
    const recon = connect(victim.token);
    expect(await waitClose(recon)).toBe(4401);
    const outcome = await closeCode;
    await cleanupDevices(prisma, [vDevice]);
    expect(outcome).toBe(4401);
  });
});
