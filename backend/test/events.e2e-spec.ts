// 事件查询集成测试（API.md §6）：列表过滤/排序/分页、_invalid 隔离、详情、归属，
// 以及 §11 WS risk_event / device_event 分流推送。
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
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface WsMsg {
  type: string;
  data: Record<string, unknown>;
  sentAt: string;
}

describe('事件查询 + WS 事件推送 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ingest: IngestService;

  const deviceId = `e2e_evt_${Date.now()}`;
  // 基准时间取 1 小时前（整秒）：排序与时间窗断言不依赖运行时刻。不能用固定的旧日期——比收到时早 72 小时以上的设备时间
  // 按时钟错乱处理、业务时间取收到时间（决策 #59），按设备时间写的时间窗就查不到了
  const base = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;
  let ownerToken: string;
  let otherToken: string;
  const userIds: string[] = [];

  let ownerWs: WebSocket;
  const wsMessages: WsMsg[] = [];

  const waitWs = async (
    predicate: (m: WsMsg) => boolean,
    timeoutMs = 3000,
  ): Promise<WsMsg> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = wsMessages.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `等待 WS 消息超时；已收到 ${JSON.stringify(wsMessages.map((m) => m.type))}`,
        );
      }
      await sleep(50);
    }
  };

  const envelope = (
    eventType: string,
    payload: Record<string, unknown>,
    offsetSec: number,
    eventId = randomUUID(),
  ): string =>
    JSON.stringify({
      schemaVersion: 1,
      eventId,
      deviceId,
      eventType,
      timestamp: new Date(base + offsetSec * 1000).toISOString(),
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
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    ingest = app.get(IngestService);

    await app.listen(0);
    const { port } = http.address() as AddressInfo;

    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
        bindCode: `bc_${deviceId}`,
      },
    });
    const register = async (): Promise<string> => {
      const res = await registerUser(app, http, {
        phone: randomPhone(),
        password: 'e2e_password_1',
      });
      userIds.push(res.body.user.id as string);
      return res.body.accessToken as string;
    };
    ownerToken = await register();
    otherToken = await register();
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ deviceId, bindCode: `bc_${deviceId}` })
      .expect(200);

    ownerWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(ownerToken)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ownerWs.once('open', resolve);
      ownerWs.once('error', reject);
    });
    ownerWs.on('message', (raw) => {
      wsMessages.push(JSON.parse((raw as Buffer).toString('utf-8')) as WsMsg);
    });
  });

  afterAll(async () => {
    ownerWs?.close();
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  const list = (
    token: string,
    query: Record<string, string | number> = {},
  ): request.Test =>
    request(http)
      .get(`/api/v1/devices/${deviceId}/events`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  it('Ingest 五类事件 + 一条坏报文：查询只见合法事件、最新在前、summary 在列', async () => {
    await ingest.ingestRaw(
      envelope(
        'collision_risk',
        {
          riskLevel: 'high',
          objectType: 'vehicle',
          direction: 'rear',
          distance: 12,
        },
        10,
      ),
      deviceId,
      'mqtt',
    );
    await ingest.ingestRaw(
      envelope('obstacle_risk', { riskLevel: 'medium' }, 20),
      deviceId,
      'mqtt',
    );
    await ingest.ingestRaw(envelope('risk_cleared', {}, 30), deviceId, 'mqtt');
    await ingest.ingestRaw(
      envelope('sleep_entered', { reason: 'inactivity', battery: 55 }, 40),
      deviceId,
      'mqtt',
    );
    await ingest.ingestRaw(
      envelope('bluetooth_lost', { disconnectDuration: 30 }, 50),
      deviceId,
      'mqtt',
    );
    // 坏报文：raw 留档为 _invalid，任何查询不得吐出
    await ingest.ingestRaw('{broken json', deviceId, 'mqtt');

    const res = await list(ownerToken).expect(200);
    expect(res.body.total).toBe(5);
    expect(
      res.body.items.map((i: { eventType: string }) => i.eventType),
    ).toEqual([
      'bluetooth_lost',
      'sleep_entered',
      'risk_cleared',
      'obstacle_risk',
      'collision_risk',
    ]);
    expect(res.body.items[4].summary).toContain('碰撞风险');
    expect(res.body.items[4].summary).toContain('high');
    // 列表项不含 payload（详情才有）
    expect(res.body.items[0].payload).toBeUndefined();
  });

  it('type 过滤：单值 / 逗号多值 / 未知值 400', async () => {
    const single = await list(ownerToken, { type: 'collision_risk' }).expect(
      200,
    );
    expect(single.body.total).toBe(1);

    const multi = await list(ownerToken, {
      type: 'collision_risk,obstacle_risk,risk_cleared',
    }).expect(200);
    expect(multi.body.total).toBe(3);

    const bad = await list(ownerToken, {
      type: 'collision_risk,exploded',
    }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
  });

  it('时间窗过滤（from/to 选填）与分页', async () => {
    const windowed = await list(ownerToken, {
      from: new Date(base + 15_000).toISOString(),
      to: new Date(base + 45_000).toISOString(),
    }).expect(200);
    expect(windowed.body.total).toBe(3); // 20/30/40s 三条

    const onlyFrom = await list(ownerToken, {
      from: new Date(base + 35_000).toISOString(),
    }).expect(200);
    expect(onlyFrom.body.total).toBe(2); // 40/50s

    const inverted = await list(ownerToken, {
      from: new Date(base + 45_000).toISOString(),
      to: new Date(base + 15_000).toISOString(),
    }).expect(400);
    expect(inverted.body.code).toBe('VALIDATION_FAILED');

    const page2 = await list(ownerToken, { page: 2, pageSize: 2 }).expect(200);
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.total).toBe(5);
  });

  it('详情：payload 原样 + media 空数组；_invalid 事件详情 404', async () => {
    const all = await list(ownerToken, { type: 'collision_risk' }).expect(200);
    const eventId = all.body.items[0].eventId as string;

    const res = await request(http)
      .get(`/api/v1/events/${eventId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body.payload).toMatchObject({
      riskLevel: 'high',
      objectType: 'vehicle',
      distance: 12,
    });
    expect(res.body.media).toEqual([]);

    // _invalid 占位事件即使拿到 eventId 也查不到
    const invalid = await prisma.rawEvent.findFirst({
      where: { deviceId, eventType: '_invalid' },
    });
    expect(invalid).not.toBeNull();
    await request(http)
      .get(`/api/v1/events/${invalid?.eventId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });

  it('归属：他人列表 404 DEVICE_NOT_FOUND、他人详情 404、未登录 401', async () => {
    const res = await list(otherToken).expect(404);
    expect(res.body.code).toBe('DEVICE_NOT_FOUND');

    const all = await list(ownerToken, { pageSize: 1 }).expect(200);
    await request(http)
      .get(`/api/v1/events/${all.body.items[0].eventId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(http).get(`/api/v1/devices/${deviceId}/events`).expect(401);
  });

  it('WS 分流：risk 三类推 risk_event（详情级），sleep/bluetooth 推 device_event（列表项级）', async () => {
    const risk = await waitWs(
      (m) => m.type === 'risk_event' && m.data.eventType === 'collision_risk',
    );
    // 详情级：payload 与 media 在列
    expect(risk.data.payload).toMatchObject({ riskLevel: 'high' });
    expect(risk.data.media).toEqual([]);
    expect(risk.data.summary).toContain('碰撞风险');

    await waitWs(
      (m) => m.type === 'risk_event' && m.data.eventType === 'risk_cleared',
    );

    const device = await waitWs(
      (m) => m.type === 'device_event' && m.data.eventType === 'sleep_entered',
    );
    // 列表项级：不带 payload
    expect(device.data.payload).toBeUndefined();
    expect(device.data.summary).toBe('进入休眠');
    await waitWs(
      (m) => m.type === 'device_event' && m.data.eventType === 'bluetooth_lost',
    );
  });
});
