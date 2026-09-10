// 上线前加固：WebSocket 通道的鉴权误用、连接风暴、垃圾帧、连接表清理。
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WebSocket } from 'ws';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import {
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  listenRandomPort,
  provisionDevice,
  sleep,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

const waitOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

const waitClose = (ws: WebSocket, timeoutMs = 3000): Promise<number> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待关闭超时')), timeoutMs);
    ws.once('close', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });

describe('加固：WebSocket 实时通道 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let gateway: RealtimeGateway;
  let jwt: JwtService;
  let wsBase: string;

  const run = Date.now();
  const deviceId = `hard_ws_${run}`;
  let owner: TestUser;
  let other: TestUser;
  const sockets: WebSocket[] = [];

  const connect = (token: string | null): WebSocket => {
    const ws = new WebSocket(
      token === null ? `${wsBase}/ws` : `${wsBase}/ws?token=${token}`,
    );
    sockets.push(ws);
    return ws;
  };

  const byUserSize = (userId: string): number =>
    (gateway as unknown as { byUser: Map<string, Set<WebSocket>> }).byUser.get(
      userId,
    )?.size ?? 0;

  const pushLocation = (i: number) =>
    ingest.ingestRaw(
      JSON.stringify(envelope(deviceId, 'location_update', validLocation(i))),
      deviceId,
      'mqtt',
    );

  beforeAll(async () => {
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    ({ app, http, prisma } = await buildApp());
    wsBase = await listenRandomPort(app);
    ingest = app.get(IngestService);
    gateway = app.get(RealtimeGateway);
    jwt = app.get(JwtService);
    owner = await createUser(app, http);
    other = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, owner.token, deviceId);
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await cleanupDevices(prisma, [deviceId]);
    await cleanupUsers(prisma, [owner, other]);
    await app.close();
  });

  it('无 token / 乱 token / 过期 token / admin 密钥 token / 用户密钥 typ=admin：均 4401', async () => {
    const expired = await jwt.signAsync(
      { sub: owner.id },
      { expiresIn: '-1s' },
    );
    const adminSigned = await jwt.signAsync(
      { sub: 'a', typ: 'admin' },
      { secret: process.env.ADMIN_JWT_SECRET },
    );
    for (const token of [null, 'garbage', expired, adminSigned]) {
      const ws = connect(token);
      expect(await waitClose(ws)).toBe(4401);
    }
    expect(byUserSize(owner.id)).toBe(0);
  });

  it('同一用户 300 个连接：全部收到同一条推送；关闭后连接表清空', async () => {
    const conns: WebSocket[] = [];
    for (let i = 0; i < 300; i += 1) conns.push(connect(owner.token));
    await Promise.all(conns.map(waitOpen));
    // 连接钩子（命令补推）是异步的，稍等让 handleConnection 全部完成
    await sleep(200);
    expect(byUserSize(owner.id)).toBe(300);

    const received = conns.map(
      (ws) =>
        new Promise<string>((resolve) => {
          ws.on('message', (raw) => {
            const msg = JSON.parse((raw as Buffer).toString('utf-8')) as {
              type: string;
            };
            if (msg.type === 'location_update') resolve(msg.type);
          });
        }),
    );
    const t0 = Date.now();
    await pushLocation(1);
    const types = await Promise.all(
      received.map((p) => Promise.race([p, sleep(5000).then(() => 'timeout')])),
    );
    console.log(`[ws fan-out 300 conns] ${Date.now() - t0}ms`);
    expect(types.filter((t) => t === 'location_update')).toHaveLength(300);

    conns.forEach((ws) => ws.close());
    await Promise.all(conns.map((ws) => waitClose(ws)));
    await sleep(100);
    expect(byUserSize(owner.id)).toBe(0);
  });

  it('客户端发垃圾帧（1MB 二进制 / 非 JSON 文本 / 伪造 device_command）：连接不断、服务不崩、后续推送正常', async () => {
    const ws = connect(owner.token);
    await waitOpen(ws);
    const spy = connect(other.token);
    await waitOpen(spy);
    const spyMessages: string[] = [];
    spy.on('message', (raw) =>
      spyMessages.push((raw as Buffer).toString('utf-8')),
    );

    ws.send(Buffer.alloc(1024 * 1024, 7));
    ws.send('not json at all');
    ws.send(
      JSON.stringify({
        type: 'device_command',
        data: { deviceId, commandId: 'fake' },
      }),
    );
    ws.send(JSON.stringify({ type: 'subscribe', userId: other.id }));
    await sleep(300);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const got = new Promise<string>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse((raw as Buffer).toString('utf-8')) as {
          type: string;
        };
        if (msg.type === 'location_update') resolve(msg.type);
      });
    });
    await pushLocation(2);
    expect(await Promise.race([got, sleep(3000).then(() => 'timeout')])).toBe(
      'location_update',
    );
    // 非绑定用户不会因为"订阅指令"收到任何东西
    await sleep(200);
    expect(spyMessages).toHaveLength(0);
    ws.close();
    spy.close();
  });

  it('推送瞬间客户端 terminate：不抛错，连接表最终清理', async () => {
    const ws = connect(owner.token);
    await waitOpen(ws);
    await sleep(50);
    ws.terminate();
    await Promise.all([pushLocation(3), pushLocation(4), pushLocation(5)]);
    await sleep(300);
    expect(byUserSize(owner.id)).toBe(0);
  });

  it('access token 到期即断开（4401），到期后不再收推送', async () => {
    const shortLived = await jwt.signAsync(
      { sub: owner.id },
      { expiresIn: '1s' },
    );
    const ws = connect(shortLived);
    await waitOpen(ws);
    const closed = waitClose(ws, 3000);
    expect(await closed).toBe(4401);
    // 客户端先收到关闭帧，服务端 handleDisconnect 紧随其后；给它一拍
    await sleep(200);
    expect(byUserSize(owner.id)).toBe(0);
  });
});
