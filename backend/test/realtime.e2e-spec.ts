// WebSocket 实时通道集成测试：鉴权、绑定用户定向推送、非绑定用户不收（API.md §11）。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { registerUser } from './helpers/register';

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

interface ReceivedMessage {
  type: string;
  data: Record<string, unknown>;
  sentAt: string;
}

const nextMessage = (
  ws: WebSocket,
  timeoutMs = 3000,
): Promise<ReceivedMessage> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('等待 WS 消息超时')),
      timeoutMs,
    );
    ws.once('message', (raw) => {
      clearTimeout(timer);
      // 文本帧在 ws 中以 Buffer 交付
      resolve(JSON.parse((raw as Buffer).toString('utf-8')) as ReceivedMessage);
    });
  });

const waitOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

const waitClose = (ws: WebSocket): Promise<number> =>
  new Promise((resolve) => ws.once('close', (code) => resolve(code)));

describe('WebSocket 实时通道 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ingest: IngestService;
  let wsBase: string;

  const deviceId = `e2e_ws_${Date.now()}`;
  const bindCode = '24681357';
  let ownerToken: string;
  let otherToken: string;
  const sockets: WebSocket[] = [];

  const envelope = (
    eventType: string,
    payload: Record<string, unknown>,
  ): string =>
    JSON.stringify({
      schemaVersion: 1,
      eventId: randomUUID(),
      deviceId,
      eventType,
      timestamp: new Date().toISOString(),
      firmwareVersion: '0.1.0-e2e',
      payload,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(requestIdMiddleware);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new UnifiedExceptionFilter());
    // 与 main.ts 相同：原生 ws 适配器；WS 测试必须真实监听端口
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    wsBase = `ws://127.0.0.1:${address.port}/ws`;
    const http = app.getHttpServer();
    prisma = app.get(PrismaService);
    ingest = app.get(IngestService);

    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
        bindCode,
      },
    });
    const register = async (): Promise<string> => {
      const res = await registerUser(app, http, {
        phone: randomPhone(),
        password: 'e2e_password_1',
      });
      return res.body.accessToken as string;
    };
    ownerToken = await register();
    otherToken = await register();
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ deviceId, bindCode })
      .expect(200);
  });

  /**
   * 客户端 open ≠ 服务端已订阅：网关在登记连接前还要 await 一次 DB 查询，紧接 open 的推送可能漏掉
   * 这条连接（加速通道不补发；2026-09-18 CI 诊断）。推送前等注册计数到位。
   */
  const openRegistered = async (token: string): Promise<WebSocket> => {
    const { byUser } = app.get(RealtimeGateway);
    const userId = (
      JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'),
      ) as { sub: string }
    ).sub;
    const before = byUser.get(userId)?.size ?? 0;
    const ws = new WebSocket(`${wsBase}?token=${token}`);
    sockets.push(ws);
    await waitOpen(ws);
    const deadline = Date.now() + 10_000;
    while ((byUser.get(userId)?.size ?? 0) < before + 1) {
      if (Date.now() > deadline) {
        throw new Error('连接已 open 但服务端注册未到位');
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return ws;
  };

  afterAll(async () => {
    for (const ws of sockets) ws.close();
    await prisma.locationPoint
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  it('无 token / 错 token 连接 → 4401 关闭', async () => {
    const noToken = new WebSocket(wsBase);
    sockets.push(noToken);
    expect(await waitClose(noToken)).toBe(4401);

    const badToken = new WebSocket(`${wsBase}?token=not-a-jwt`);
    sockets.push(badToken);
    expect(await waitClose(badToken)).toBe(4401);
  });

  it('绑定用户实时收到 location_update 推送（含海拔与设备号）', async () => {
    const ws = await openRegistered(ownerToken);

    const waiting = nextMessage(ws);
    await ingest.ingestRaw(
      envelope('location_update', {
        latitude: 40.9505,
        longitude: 115.419,
        coordinateSystem: 'wgs84',
        accuracy: 6,
        speed: 15.2,
        heading: 30,
        altitude: 2050,
      }),
      deviceId,
      'mqtt',
    );
    const msg = await waiting;
    expect(msg.type).toBe('location_update');
    expect(msg.data.deviceId).toBe(deviceId);
    expect(msg.data.altitude).toBe(2050);
    expect(msg.sentAt).toBeTruthy();
  });

  it('device_status 事件推送 §4 status 对象', async () => {
    const ws = await openRegistered(ownerToken);

    const waiting = nextMessage(ws);
    await ingest.ingestRaw(
      envelope('device_status', { battery: 58, charging: true }),
      deviceId,
      'mqtt',
    );
    const msg = await waiting;
    expect(msg.type).toBe('device_status');
    expect(msg.data.deviceId).toBe(deviceId);
    expect(msg.data.battery).toBe(58);
    expect(msg.data.online).toBe(true);
  });

  it('非绑定用户收不到该设备的推送', async () => {
    const ws = new WebSocket(`${wsBase}?token=${otherToken}`);
    sockets.push(ws);
    await waitOpen(ws);

    const shouldTimeout = nextMessage(ws, 1200);
    await ingest.ingestRaw(
      envelope('device_status', { battery: 30 }),
      deviceId,
      'mqtt',
    );
    await expect(shouldTimeout).rejects.toThrow('等待 WS 消息超时');
  });
});
