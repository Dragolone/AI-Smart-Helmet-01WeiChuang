// BLE 下行命令链集成测试（决策 #36 / API.md §8 relay-ack + §11 device_command）：
// WS 实时推送与连接补推（pending+delivered，不含 offline/终态）、relay-ack 全路径
// （delivered / executed success·failed / 幂等 / 迟到覆盖 offline / 归属 / 入参校验 /
// 非法 executedAt 兜底）。铁律不变：未回执绝不显示成功，蓝牙版与 4G 版状态机等价。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { MqttConsumerService } from '../src/ingest/mqtt-consumer.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CommandsSchedulerService } from '../src/commands/commands-scheduler.service';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `18${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

interface WsCommandMessage {
  type: string;
  data: {
    deviceId: string;
    commandId: string;
    type: string;
    params: Record<string, unknown>;
    issuedAt: string;
  };
  sentAt: string;
}

const waitOpen = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

/** 收集一段时间内到达的全部消息（补推是多条连发，单条等待不够用） */
const collectMessages = (
  ws: WebSocket,
  ms: number,
): Promise<WsCommandMessage[]> =>
  new Promise((resolve) => {
    const got: WsCommandMessage[] = [];
    const onMessage = (raw: unknown): void => {
      got.push(
        JSON.parse((raw as Buffer).toString('utf-8')) as WsCommandMessage,
      );
    };
    ws.on('message', onMessage);
    setTimeout(() => {
      ws.off('message', onMessage);
      resolve(got);
    }, ms);
  });

describe('BLE 下行命令链：WS device_command + relay-ack (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let scheduler: CommandsSchedulerService;
  let wsBase: string;

  const deviceId = `e2e_relay_${Date.now()}`;
  const otherDeviceId = `e2e_relay_other_${Date.now()}`;
  let ownerToken: string;
  let otherToken: string;
  const sockets: WebSocket[] = [];

  const publishCommand = jest.fn();
  const mqttStub = {
    publishCommand,
    setCmdAckHandler: jest.fn(),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
  };

  const putSettings = (settings: Record<string, unknown>): Promise<string> =>
    request(http)
      .put(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ settings })
      .expect(202)
      .then((res) => res.body.commandId as string);

  const relayAck = (
    commandId: string,
    body: Record<string, unknown>,
    token = ownerToken,
    device = deviceId,
  ): request.Test =>
    request(http)
      .post(`/api/v1/devices/${device}/commands/${commandId}/relay-ack`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const getStatus = async (commandId: string): Promise<string> => {
    const res = await request(http)
      .get(`/api/v1/commands/${commandId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return res.body.status as string;
  };

  const connectWs = async (token: string): Promise<WebSocket> => {
    const ws = new WebSocket(`${wsBase}?token=${token}`);
    sockets.push(ws);
    await waitOpen(ws);
    return ws;
  };

  beforeAll(async () => {
    process.env.COMMAND_ACK_TIMEOUT_SECONDS = '1';
    process.env.COMMAND_SCAN_INTERVAL_MS = '600000'; // 手动 tick 驱动
    publishCommand.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MqttConsumerService)
      .useValue(mqttStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(requestIdMiddleware);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new UnifiedExceptionFilter());
    // WS 测试必须真实监听端口（与 realtime.e2e 同法）
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    wsBase = `ws://127.0.0.1:${address.port}/ws`;
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    scheduler = app.get(CommandsSchedulerService);

    for (const id of [deviceId, otherDeviceId]) {
      await prisma.device.create({
        data: {
          deviceId: id,
          deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
          bindCode: `bc_${id}`,
        },
      });
    }
    const register = async (): Promise<string> => {
      const res = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: randomPhone(), password: 'e2e_password_1' })
        .expect(201);
      return res.body.accessToken as string;
    };
    ownerToken = await register();
    otherToken = await register();
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ deviceId, bindCode: `bc_${deviceId}` })
      .expect(200);
    // 第二台设备绑给 other：验证「命令不属于该设备」的 404
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ deviceId: otherDeviceId, bindCode: `bc_${otherDeviceId}` })
      .expect(200);
  });

  afterAll(async () => {
    for (const ws of sockets) ws.close();
    await prisma.deviceCommand
      .deleteMany({ where: { deviceId: { in: [deviceId, otherDeviceId] } } })
      .catch(() => undefined);
    await prisma.device
      .deleteMany({ where: { deviceId: { in: [deviceId, otherDeviceId] } } })
      .catch(() => undefined);
    await app.close();
  });

  afterEach(async () => {
    // 每条用例独立：清掉本设备存量命令，补推断言不受先前用例污染
    await prisma.deviceCommand.deleteMany({ where: { deviceId } });
  });

  it('下发时 WS 在线 → 实时收到 device_command（双路：MQTT 也照发）', async () => {
    const ws = await connectWs(ownerToken);
    const waiting = collectMessages(ws, 800);
    const commandId = await putSettings({ beepVolume: 70 });

    const messages = (await waiting).filter((m) => m.type === 'device_command');
    expect(messages).toHaveLength(1);
    expect(messages[0].data).toMatchObject({
      deviceId,
      commandId,
      type: 'set_config',
      params: { beepVolume: 70 },
    });
    expect(typeof messages[0].data.issuedAt).toBe('string');
    // 双路下发：MQTT 同时照发，业务不感知设备形态
    expect(publishCommand).toHaveBeenCalled();
    ws.close();
  });

  it('连接补推：pending+delivered 按 issuedAt 升序推；offline/终态不推', async () => {
    // 预置四种状态各一条（直接入库，绕过下发路径以精确控制状态与时序）
    const seed = async (status: string, at: Date): Promise<string> => {
      const c = await prisma.deviceCommand.create({
        data: {
          deviceId,
          type: 'set_config',
          params: { seeded: status },
          status,
          issuedAt: at,
        },
      });
      return c.id;
    };
    const t0 = Date.now();
    const pendingId = await seed('pending', new Date(t0 - 3000));
    const deliveredId = await seed('delivered', new Date(t0 - 2000));
    await seed('offline', new Date(t0 - 1000));
    await seed('success', new Date(t0));

    const ws = await connectWs(ownerToken);
    const messages = (await collectMessages(ws, 800)).filter(
      (m) => m.type === 'device_command',
    );
    expect(messages.map((m) => m.data.commandId)).toEqual([
      pendingId,
      deliveredId,
    ]);
    ws.close();
  });

  it('连接补推只查本人绑定设备：非绑定用户连接收不到', async () => {
    await prisma.deviceCommand.create({
      data: { deviceId, type: 'set_config', params: {}, status: 'pending' },
    });
    const ws = await connectWs(otherToken);
    const messages = (await collectMessages(ws, 600)).filter(
      (m) => m.type === 'device_command' && m.data.deviceId === deviceId,
    );
    expect(messages).toHaveLength(0);
    ws.close();
  });

  it('relay-ack delivered → delivered + deliveredAt；重复 delivered 幂等', async () => {
    // 让 MQTT 发布失败以保住 pending（否则 PUBACK 先标 delivered，测不到本路径的状态推进）
    publishCommand.mockRejectedValueOnce(new Error('broker down'));
    const commandId = await putSettings({ nightMode: true });
    expect(await getStatus(commandId)).toBe('pending');

    const res = await relayAck(commandId, { stage: 'delivered' }).expect(200);
    expect(res.body).toEqual({ commandId, status: 'delivered' });
    const row = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: commandId },
    });
    expect(row.deliveredAt).not.toBeNull();

    // 重复 delivered：幂等返回现状，不报错不重写
    const again = await relayAck(commandId, { stage: 'delivered' }).expect(200);
    expect(again.body.status).toBe('delivered');
  });

  it('relay-ack executed success → 终态 + 设置合入（蓝牙版的"只认设备确认"）', async () => {
    const commandId = await putSettings({ beepVolume: 55, ecoMode: true });
    const res = await relayAck(commandId, {
      stage: 'executed',
      result: 'success',
      executedAt: new Date().toISOString(),
    }).expect(200);
    expect(res.body.status).toBe('success');

    const settings = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(settings.body.settings).toMatchObject({
      beepVolume: 55,
      ecoMode: true,
    });
  });

  it('relay-ack executed failed → failed + errorCode；设置绝不合入', async () => {
    const before = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const commandId = await putSettings({ dangerZoneAlert: false });
    await relayAck(commandId, {
      stage: 'executed',
      result: 'failed',
      errorCode: 'HELMET_BUSY',
    }).expect(200);
    expect(await getStatus(commandId)).toBe('failed');

    const after = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    // failed 不合入：设置与下发前完全一致
    expect(after.body.settings).toEqual(before.body.settings);
  });

  it('终态后再收 delivered/executed → 幂等返回现状，状态不回退不翻转', async () => {
    const commandId = await putSettings({ x: 1 });
    await relayAck(commandId, { stage: 'executed', result: 'success' }).expect(
      200,
    );

    const d = await relayAck(commandId, { stage: 'delivered' }).expect(200);
    expect(d.body.status).toBe('success');
    const e = await relayAck(commandId, {
      stage: 'executed',
      result: 'failed',
    }).expect(200);
    expect(e.body.status).toBe('success'); // 首个终态胜出，矛盾回执不翻转
  });

  it('offline 后迟到 executed → 如实覆盖（同 MQTT cmd_ack 语义）', async () => {
    publishCommand.mockRejectedValueOnce(new Error('broker down'));
    const commandId = await putSettings({ lateAck: true });
    await new Promise((r) => setTimeout(r, 1100)); // 超过 1s 回执窗口
    await scheduler.tick();
    expect(await getStatus(commandId)).toBe('offline');

    await relayAck(commandId, { stage: 'executed', result: 'success' }).expect(
      200,
    );
    expect(await getStatus(commandId)).toBe('success');
    const settings = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(settings.body.settings).toMatchObject({ lateAck: true });
  });

  it('归属：非绑定用户 404 DEVICE_NOT_FOUND；命令不属于该设备 404 NOT_FOUND', async () => {
    const commandId = await putSettings({ y: 2 });
    const before = await getStatus(commandId);
    const other = await relayAck(
      commandId,
      { stage: 'executed', result: 'success' },
      otherToken,
    ).expect(404);
    expect(other.body.code).toBe('DEVICE_NOT_FOUND');

    // other 拿自己的设备路径提交本设备的命令：设备归属过、命令不属于 → NOT_FOUND
    const crossed = await relayAck(
      commandId,
      { stage: 'executed', result: 'success' },
      otherToken,
      otherDeviceId,
    ).expect(404);
    expect(crossed.body.code).toBe('NOT_FOUND');
    // 两次越权都没有推进状态（更强断言：连 executed 都推不动）
    expect(await getStatus(commandId)).toBe(before);
  });

  it('入参校验：stage 非法 / executed 缺 result → 400 VALIDATION_FAILED', async () => {
    const commandId = await putSettings({ z: 3 });
    const bad = await relayAck(commandId, { stage: 'acked' }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const noResult = await relayAck(commandId, { stage: 'executed' }).expect(
      400,
    );
    expect(noResult.body.code).toBe('VALIDATION_FAILED');
  });

  it('非法 executedAt → 服务器时间兜底（设备/App 时钟不可信哲学）', async () => {
    const commandId = await putSettings({ w: 4 });
    await relayAck(commandId, {
      stage: 'executed',
      result: 'success',
      executedAt: 'not-a-date',
    }).expect(200);
    const row = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: commandId },
    });
    expect(row.status).toBe('success');
    expect(row.executedAt).not.toBeNull();
    expect(Number.isNaN(row.executedAt!.getTime())).toBe(false);
  });

  it('未登录 401；未知 commandId 404', async () => {
    await request(http)
      .post(`/api/v1/devices/${deviceId}/commands/nonexistent/relay-ack`)
      .send({ stage: 'delivered' })
      .expect(401);
    const res = await relayAck('nonexistent', { stage: 'delivered' }).expect(
      404,
    );
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
