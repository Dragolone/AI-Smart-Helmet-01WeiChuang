// 命令状态机全路径集成测试（API.md §8 / DEVICE_PROTOCOL §7）：
// 下发→delivered、回执 success/failed 与设置生效时机、超时 offline、迟到回执覆盖、
// 重启接管、发布失败留 pending、归属与入参护栏。核心铁律逐条钉死：未回执绝不显示成功。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { MqttConsumerService } from '../src/ingest/mqtt-consumer.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CommandsService } from '../src/commands/commands.service';
import { CommandsSchedulerService } from '../src/commands/commands-scheduler.service';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('命令下发与回执状态机 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let commands: CommandsService;
  let scheduler: CommandsSchedulerService;

  const deviceId = `e2e_cmd_${Date.now()}`;
  let ownerToken: string;
  let otherToken: string;
  let ownerId: string;

  // 替换 MQTT 连接：e2e 不依赖真 Broker（EMQX 回调在测试环境不可用），
  // publish 行为脚本化；cmd_ack 处理经 CommandsService.handleAck 直接驱动（路由层极薄）。
  const publishCommand = jest.fn();
  const mqttStub = {
    publishCommand,
    setCmdAckHandler: jest.fn(),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
  };

  const ackOf = (
    commandId: string,
    result: 'success' | 'failed',
    extra: Record<string, unknown> = {},
  ): string =>
    JSON.stringify({
      commandId,
      result,
      executedAt: new Date().toISOString(),
      ...extra,
    });

  const putSettings = (
    token: string,
    settings: Record<string, unknown>,
  ): request.Test =>
    request(http)
      .put(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${token}`)
      .send({ settings });

  const getCommand = async (commandId: string) => {
    const res = await request(http)
      .get(`/api/v1/commands/${commandId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return res.body as { status: string; errorCode: string | null };
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
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    commands = app.get(CommandsService);
    scheduler = app.get(CommandsSchedulerService);

    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
        bindCode: `bc_${deviceId}`,
      },
    });
    const register = async (): Promise<{ token: string; id: string }> => {
      const res = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: randomPhone(), password: 'e2e_password_1' })
        .expect(201);
      return {
        token: res.body.accessToken as string,
        id: res.body.user.id as string,
      };
    };
    const owner = await register();
    ownerToken = owner.token;
    ownerId = owner.id;
    otherToken = (await register()).token;
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ deviceId, bindCode: `bc_${deviceId}` })
      .expect(200);
  });

  afterAll(async () => {
    await prisma.deviceCommand
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  it('初始设置为空对象，lastCommand 为 null', async () => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(res.body).toEqual({ settings: {}, lastCommand: null });
  });

  it('下发 → 202 pending 快照；PUBACK 后 delivered；MQTT 消息体含 commandId/params', async () => {
    const res = await putSettings(ownerToken, {
      beepVolume: 80,
      autoSleep: true,
    }).expect(202);
    expect(res.body.status).toBe('pending');
    const commandId = res.body.commandId as string;

    expect(publishCommand).toHaveBeenCalledTimes(1);
    const [dev, payload] = publishCommand.mock.calls[0] as [string, string];
    expect(dev).toBe(deviceId);
    expect(JSON.parse(payload)).toMatchObject({
      commandId,
      type: 'set_config',
      params: { beepVolume: 80, autoSleep: true },
    });

    // PUBACK 已回（stub resolve）→ delivered；设置尚未生效（未回执绝不显示成功）
    expect((await getCommand(commandId)).status).toBe('delivered');
    const settings = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(settings.body.settings).toEqual({});
    expect(settings.body.lastCommand.status).toBe('delivered');
  });

  it('success 回执 → 终态 + 设置生效；重复回执不双写', async () => {
    const created = await putSettings(ownerToken, { beepVolume: 60 }).expect(
      202,
    );
    const commandId = created.body.commandId as string;

    await commands.handleAck(deviceId, ackOf(commandId, 'success'));
    expect((await getCommand(commandId)).status).toBe('success');

    const settings = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(settings.body.settings).toEqual({ beepVolume: 60 });

    // 重复回执（QoS1 重复交付）：状态与设置都不再变
    await commands.handleAck(
      deviceId,
      ackOf(commandId, 'failed', { errorCode: 'LATE_DUP' }),
    );
    const after = await getCommand(commandId);
    expect(after.status).toBe('success');
    expect(after.errorCode).toBeNull();
  });

  it('failed 回执 → 终态 failed + errorCode；设置绝不合入', async () => {
    const created = await putSettings(ownerToken, { beepVolume: 999 }).expect(
      202,
    );
    const commandId = created.body.commandId as string;
    await commands.handleAck(
      deviceId,
      ackOf(commandId, 'failed', { errorCode: 'OUT_OF_RANGE' }),
    );
    const cmd = await getCommand(commandId);
    expect(cmd.status).toBe('failed');
    expect(cmd.errorCode).toBe('OUT_OF_RANGE');

    const settings = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    // 仍是上一次 success 的值
    expect(settings.body.settings).toEqual({ beepVolume: 60 });
  });

  it('无回执 → 扫描超时判 offline；迟到回执如实覆盖并生效设置', async () => {
    const created = await putSettings(ownerToken, { nightMode: true }).expect(
      202,
    );
    const commandId = created.body.commandId as string;

    // 超时窗口 1s：先扫一轮不该动，过期后再扫 → offline
    await scheduler.tick();
    expect((await getCommand(commandId)).status).toBe('delivered');
    await new Promise((r) => setTimeout(r, 1100));
    await scheduler.tick();
    expect((await getCommand(commandId)).status).toBe('offline');

    // 迟到回执：设备实际执行了 → 如实覆盖 offline，设置生效
    await commands.handleAck(deviceId, ackOf(commandId, 'success'));
    expect((await getCommand(commandId)).status).toBe('success');
    const settings = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(settings.body.settings).toEqual({ beepVolume: 60, nightMode: true });
  });

  it('发布失败（Broker 不可达）→ 留 pending → 超时 offline（重启接管同机制）', async () => {
    publishCommand.mockRejectedValueOnce(new Error('MQTT 未连接'));
    const created = await putSettings(ownerToken, { beepVolume: 40 }).expect(
      202,
    );
    const commandId = created.body.commandId as string;
    expect((await getCommand(commandId)).status).toBe('pending');

    await new Promise((r) => setTimeout(r, 1100));
    await scheduler.tick();
    expect((await getCommand(commandId)).status).toBe('offline');
    // 未执行的设置没有生效
    const settings = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(settings.body.settings.beepVolume).toBe(60);
  });

  it('脏回执防线：非法 JSON / 未知 commandId / 串线设备 一律忽略不炸', async () => {
    await commands.handleAck(deviceId, '{broken');
    await commands.handleAck(deviceId, ackOf(randomUUID(), 'success'));
    // 串线：别的设备回执我的命令
    const created = await putSettings(ownerToken, { x: 1 }).expect(202);
    await commands.handleAck(
      'evil_device',
      ackOf(created.body.commandId as string, 'success'),
    );
    expect((await getCommand(created.body.commandId as string)).status).toBe(
      'delivered',
    );
  });

  it('入参护栏：嵌套对象 / 空对象 / 超 20 键 / 非法值类型 → 400', async () => {
    const cases: Record<string, unknown>[] = [
      { nested: { a: 1 } },
      {},
      Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])),
      { fn: null },
    ];
    for (const settings of cases) {
      const res = await putSettings(ownerToken, settings).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('命令历史最新在前分页；归属：他人操作一律 404、未登录 401', async () => {
    const history = await request(http)
      .get(`/api/v1/devices/${deviceId}/commands`)
      .query({ pageSize: 3 })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(history.body.items).toHaveLength(3);
    expect(history.body.total).toBeGreaterThanOrEqual(6);
    const issued = history.body.items.map(
      (c: { issuedAt: string }) => c.issuedAt,
    );
    expect(issued).toEqual([...issued].sort().reverse());

    await putSettings(otherToken, { a: 1 }).expect(404);
    await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(http)
      .get(`/api/v1/commands/${history.body.items[0].commandId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(http).get(`/api/v1/devices/${deviceId}/settings`).expect(401);
    expect(ownerId).toBeTruthy();
  });
});
