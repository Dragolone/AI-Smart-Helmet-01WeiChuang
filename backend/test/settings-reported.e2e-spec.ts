// 头盔实际设置上报（API.md §8 / 决策 #45）：App 在 BLE 握手后读回 0x20–0x2D 上报，
// 让云端「当前生效设置」与头盔一致。钉住：逐键校验、未完成/刚成功命令保护、
// 窗口过后照常校正、offline 命令不保护、并发上报不丢键、不产生命令、归属与入参护栏。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { MqttConsumerService } from '../src/ingest/mqtt-consumer.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CommandsService } from '../src/commands/commands.service';
import { CommandsSchedulerService } from '../src/commands/commands-scheduler.service';
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('头盔实际设置上报 settings/reported (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let commands: CommandsService;
  let scheduler: CommandsSchedulerService;

  const deviceId = `e2e_rep_${Date.now()}`;
  let ownerToken: string;
  let otherToken: string;

  const publishCommand = jest.fn();
  const mqttStub = {
    publishCommand,
    setCmdAckHandler: jest.fn(),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
  };

  const report = (settings: unknown, token = ownerToken) =>
    request(http)
      .post(`/api/v1/devices/${deviceId}/settings/reported`)
      .set('Authorization', `Bearer ${token}`)
      .send({ settings });

  const put = (settings: Record<string, unknown>) =>
    request(http)
      .put(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ settings })
      .expect(202)
      .then((r) => r.body.commandId as string);

  const ackSuccess = (commandId: string) =>
    commands.handleAck(
      deviceId,
      JSON.stringify({
        commandId,
        result: 'success',
        executedAt: new Date().toISOString(),
      }),
    );

  const effective = async (): Promise<Record<string, unknown>> => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return res.body.settings as Record<string, unknown>;
  };

  beforeAll(async () => {
    process.env.COMMAND_ACK_TIMEOUT_SECONDS = '1';
    process.env.COMMAND_SCAN_INTERVAL_MS = '600000';
    publishCommand.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
    const register = async () =>
      (
        await registerUser(app, http, {
          phone: randomPhone(),
          password: 'e2e_password_1',
        })
      ).body.accessToken as string;
    ownerToken = await register();
    otherToken = await register();
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

  it('首次上报：合法键全部采纳并成为生效设置；不创建命令、不改 lastCommand', async () => {
    const res = await report({ buzzer: true, vibration: 1 }).expect(200);
    expect(res.body).toEqual({
      settings: { buzzer: true, vibration: 1 },
      applied: ['buzzer', 'vibration'],
      skipped: [],
    });
    const got = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(got.body).toEqual({
      settings: { buzzer: true, vibration: 1 },
      lastCommand: null,
    });
    expect(await prisma.deviceCommand.count({ where: { deviceId } })).toBe(0);
  });

  it('逐键校验：清单外 / 类型不符 / 越界只跳过该键，其余照常采纳', async () => {
    const res = await report({
      light: 9,
      beepVolume: 1,
      buzzer: 1,
      sosButton: true,
    }).expect(200);
    expect(res.body.applied).toEqual(['sosButton']);
    expect(
      (res.body.skipped as { key: string; reason: string }[]).map((s) => [
        s.key,
        s.reason,
      ]),
    ).toEqual([
      ['light', 'invalid'],
      ['beepVolume', 'invalid'],
      ['buzzer', 'invalid'],
    ]);
    expect(await effective()).toEqual({
      buzzer: true,
      vibration: 1,
      sosButton: true,
    });
  });

  it('并发上报不同键：生效设置一个都不丢（读-合-写按设备串行化）', async () => {
    const batch: Record<string, number | boolean>[] = [
      { fallSensitivity: 3 },
      { radar: false },
      { radarDistance: 20 },
      { obstacleWarn: false },
      { disconnectBeep: true },
      { heartbeatPeriod: 30 },
      { locationPeriodMoving: 3 },
      { locationPeriodStill: 60 },
    ];
    const results = await Promise.all(batch.map((b) => report(b)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await effective()).toMatchObject(Object.assign({}, ...batch));
  });

  it('未完成命令碰过的键以命令为准；回执成功后 30 s 内仍受保护', async () => {
    const cmd = await put({ volume: 60 }); // stub PUBACK → delivered
    const res = await report({ volume: 80, fallDetect: false }).expect(200);
    expect(res.body.applied).toEqual(['fallDetect']);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({ key: 'volume', reason: 'recent_command' }),
    ]);

    await ackSuccess(cmd);
    expect((await effective()).volume).toBe(60);
    // 刚成功：App 可能是在写入前读的，旧值不得盖回
    const again = await report({ volume: 80 }).expect(200);
    expect(again.body.applied).toEqual([]);
    expect((await effective()).volume).toBe(60);
  });

  it('窗口过后照常校正：大灯下发成功后头盔重启回到关，上报把显示校正为关', async () => {
    const cmd = await put({ light: 1 });
    await ackSuccess(cmd);
    expect((await effective()).light).toBe(1);
    await prisma.deviceCommand.update({
      where: { id: cmd },
      data: { ackedAt: new Date(Date.now() - 60_000) },
    });
    const res = await report({ light: 0 }).expect(200);
    expect(res.body.applied).toEqual(['light']);
    expect((await effective()).light).toBe(0);
  });

  it('已判 offline 的命令不保护：头盔没执行，上报的实际值就是真相', async () => {
    publishCommand.mockRejectedValueOnce(new Error('MQTT 未连接'));
    const cmd = await put({ fallDetect: true });
    await new Promise((r) => setTimeout(r, 1100));
    await scheduler.tick();
    const row = await prisma.deviceCommand.findUniqueOrThrow({
      where: { id: cmd },
    });
    expect(row.status).toBe('offline');
    const res = await report({ fallDetect: false }).expect(200);
    expect(res.body.applied).toEqual(['fallDetect']);
    expect((await effective()).fallDetect).toBe(false);
  });

  it('入参护栏与归属：非对象 / 空 / 超 32 键 → 400；他人 404；未登录 401', async () => {
    for (const bad of [null, [], {}, 'x']) {
      const r = await report(bad);
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`k${i}`, 1]),
    );
    const tooMany = await report(many);
    expect([tooMany.status, tooMany.body.code]).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);

    const other = await report({ light: 0 }, otherToken);
    expect([other.status, other.body.code]).toEqual([404, 'DEVICE_NOT_FOUND']);
    await request(http)
      .post(`/api/v1/devices/${deviceId}/settings/reported`)
      .send({ settings: { light: 0 } })
      .expect(401);
  });
});
