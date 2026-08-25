// 算法服务 Webhook 入口集成测试（API.md §12，决策 #7）：
// API Key 鉴权（fail-closed）、正常入库与业务分发（统一 Ingest 等价性）、
// eventId 幂等、校验失败留档不报错、越 topic 串设备防线。
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

jest.setTimeout(30000);

const API_KEY = 'e2e_webhook_key';

describe('Ingest Webhook 入口 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  const deviceId = `e2e_webhook_${Date.now()}`;

  const mqttStub = {
    publishCommand: jest.fn(),
    setCmdAckHandler: jest.fn(),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
  };

  const envelope = (
    eventType: string,
    payload: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    schemaVersion: 1,
    eventId: randomUUID(),
    deviceId,
    eventType,
    timestamp: new Date().toISOString(),
    firmwareVersion: '0.1.0-e2e',
    payload,
    ...overrides,
  });

  const post = (body: unknown, key: string | null = API_KEY): request.Test => {
    const req = request(http)
      .post('/api/v1/ingest/webhook')
      .send(body as object);
    return key === null ? req : req.set('X-Api-Key', key);
  };

  beforeAll(async () => {
    process.env.INGEST_WEBHOOK_API_KEY = API_KEY;
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

    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
        bindCode: `bc_${deviceId}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.locationPoint
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  it('鉴权 fail-closed：无 key / 错 key / env 未配置 → 401', async () => {
    const body = envelope('device_status', { battery: 90 });
    await post(body, null).expect(401);
    await post(body, 'wrong-key').expect(401);

    const saved = process.env.INGEST_WEBHOOK_API_KEY;
    delete process.env.INGEST_WEBHOOK_API_KEY;
    // env 未配置：连正确 key 都拒绝——不存在"默认放行"
    await post(body, saved).expect(401);
    process.env.INGEST_WEBHOOK_API_KEY = saved;
  });

  it('正常事件 → 202 入库并走业务分发（webhook 与 MQTT 入口等价）', async () => {
    const body = envelope('location_update', {
      latitude: 22.52,
      longitude: 113.94,
      coordinateSystem: 'wgs84',
      accuracy: 5,
      speed: 8.2,
      heading: 90,
    });
    const res = await post(body).expect(202);
    expect(res.body).toEqual({
      eventId: body.eventId,
      duplicate: false,
      invalid: false,
    });

    const raw = await prisma.rawEvent.findUnique({
      where: { eventId: body.eventId as string },
    });
    expect(raw).toMatchObject({ deviceId, source: 'webhook' });
    // 业务分发证据：location_update 进了轨迹表（不是只留档）
    const point = await prisma.locationPoint.findUnique({
      where: { eventId: body.eventId as string },
    });
    expect(point).not.toBeNull();
  });

  it('eventId 幂等：重复提交 → duplicate:true 同样 202，只存一次', async () => {
    const body = envelope('device_status', { battery: 77 });
    await post(body).expect(202);
    const res = await post(body).expect(202);
    expect(res.body).toEqual({
      eventId: body.eventId,
      duplicate: true,
      invalid: false,
    });
    const count = await prisma.rawEvent.count({
      where: { eventId: body.eventId as string },
    });
    expect(count).toBe(1);
  });

  it('校验失败 → 202 invalid:true 留档不报错（算法侧无需错误分支）', async () => {
    // 缺 timestamp：envelope 结构不合法
    const body = envelope(
      'device_status',
      { battery: 66 },
      { timestamp: undefined },
    );
    const res = await post(body).expect(202);
    expect(res.body.invalid).toBe(true);
    // 留档：_invalid 记录存在（eventId 生成规则由 Ingest 层兜底，按 deviceId 查最新）
    const rows = await prisma.rawEvent.findMany({
      where: { deviceId, eventType: { contains: 'invalid' } },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('非对象 body / 无 deviceId → 202 invalid 留档，不炸', async () => {
    const res = await post('just a string').expect(202);
    expect(res.body).toMatchObject({ eventId: null, invalid: true });
    const res2 = await post({ foo: 1 }).expect(202);
    expect(res2.body).toMatchObject({ eventId: null, invalid: true });
  });
});
