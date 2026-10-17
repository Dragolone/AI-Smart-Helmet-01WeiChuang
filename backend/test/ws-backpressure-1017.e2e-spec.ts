// 不读数据的 WS 连接：服务端发送缓冲原来无上限增长（10-17 第二轮评审 r3：一个账号一条连接加自己头盔的中转，
// 每 100 次中转涨约 5.8 MiB，连接一直 OPEN），现在积压超过 WS_MAX_BUFFERED_BYTES 就断开。
import { INestApplication } from '@nestjs/common';
import type { Socket } from 'node:net';
import { WebSocket } from 'ws';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RealtimeGateway,
  WS_MAX_BUFFERED_BYTES,
} from '../src/realtime/realtime.gateway';
import {
  buildApp,
  cleanupUsers,
  createUser,
  type Http,
  type TestUser,
} from './helpers/hardening';
import { waitFor, waitOpen, wsUrlOf } from './helpers/audit-ingest';

jest.setTimeout(60_000);

interface GatewayInternals {
  byUser: Map<string, Set<WebSocket>>;
}

describe('WS 发送积压上限 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let gateway: RealtimeGateway;
  const users: TestUser[] = [];

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    gateway = app.get(RealtimeGateway);
  });
  afterAll(async () => {
    await cleanupUsers(prisma, users);
    await app.close();
  });

  const connectPaused = async (u: TestUser) => {
    const ws = new WebSocket(wsUrlOf(app, u.token));
    await waitOpen(ws);
    const internals = gateway as unknown as GatewayInternals;
    await waitFor(() => (internals.byUser.get(u.id)?.size ?? 0) === 1, 10_000);
    const server = [...(internals.byUser.get(u.id) ?? [])][0];
    return { ws, server, internals };
  };

  it('客户端停止读取：积压超过上限后服务端断开并清掉登记，不再无限往缓冲里塞', async () => {
    const u = await createUser(app, http);
    users.push(u);
    const { ws, server, internals } = await connectPaused(u);
    // 真实场景是恶意脚本暂停读取，或进了隧道的半开 TCP 连接
    (ws as unknown as { _socket: Socket })._socket.pause();

    const big = {
      type: 'risk_event',
      data: { note: 'x'.repeat(60_000) },
    } as never;
    let peak = 0;
    for (let i = 0; i < 400 && server.readyState === WebSocket.OPEN; i += 1) {
      gateway.pushToUser(u.id, big);
      peak = Math.max(peak, server.bufferedAmount);
      // 让出事件循环，内核发送缓冲填满后积压才会留在 ws 里
      if (i % 20 === 0) await new Promise((r) => setImmediate(r));
    }
    await waitFor(() => !internals.byUser.has(u.id), 10_000);
    expect(server.readyState).not.toBe(WebSocket.OPEN);
    // 断开前积压不会远超上限（最后一条消息约 60 KB）
    expect(peak).toBeLessThanOrEqual(WS_MAX_BUFFERED_BYTES + 128 * 1024);
    ws.terminate();
  });

  it('正常读取的连接：同样的推送量照收不误，连接保持', async () => {
    const u = await createUser(app, http);
    users.push(u);
    const { ws, server, internals } = await connectPaused(u);
    let received = 0;
    ws.on('message', () => (received += 1));
    const big = {
      type: 'risk_event',
      data: { note: 'x'.repeat(60_000) },
    } as never;
    for (let i = 0; i < 100; i += 1) {
      gateway.pushToUser(u.id, big);
      await new Promise((r) => setImmediate(r));
    }
    await waitFor(() => received === 100, 20_000);
    expect(server.readyState).toBe(WebSocket.OPEN);
    expect(internals.byUser.get(u.id)?.size).toBe(1);
    ws.terminate();
  });
});
