// 蓝牙版 App 中转入口集成测试（API.md §12.1）：批量入库与计数、幂等补传、
// 类型白名单、业务等价性（中转的 fall 触发 SOS / location 入轨迹表）、归属与入参护栏。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { PrismaService } from '../src/prisma/prisma.service';
import { registerUser } from './helpers/register';

jest.setTimeout(30000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('App 中转入口（蓝牙版） (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  const deviceId = `e2e_relay_${Date.now()}`;
  let ownerToken: string;
  let otherToken: string;
  const userIds: string[] = [];

  const envelope = (
    eventType: string,
    payload: Record<string, unknown>,
    eventId = randomUUID(),
    devId = deviceId,
  ) => ({
    schemaVersion: 1,
    eventId,
    deviceId: devId,
    eventType,
    timestamp: new Date().toISOString(),
    firmwareVersion: '0.1.0-ble',
    payload,
  });

  const relay = (token: string, body: Record<string, unknown>): request.Test =>
    request(http)
      .post('/api/v1/ingest/app-relay')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  beforeAll(async () => {
    process.env.SOS_COUNTDOWN_SECONDS = '600'; // 本套件不测到期
    process.env.SOS_SCAN_INTERVAL_MS = '600000';

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
  });

  afterAll(async () => {
    await prisma.sosNotification
      .deleteMany({ where: { sos: { deviceId } } })
      .catch(() => undefined);
    await prisma.sosCase
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.locationPoint
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  it('批量中转 → 202 计数；source=app_relay；location 入轨迹表；fall 触发 SOS 状态机（业务等价）', async () => {
    const batch = [
      envelope('device_status', { battery: 77 }),
      envelope('location_update', {
        latitude: 22.52,
        longitude: 113.94,
        coordinateSystem: 'wgs84',
        accuracy: 8,
        speed: 3.1,
        heading: 90,
      }),
      envelope('possible_fall', {
        confidence: 0.9,
        location: {
          latitude: 22.52,
          longitude: 113.94,
          coordinateSystem: 'wgs84',
        },
      }),
    ];
    const res = await relay(ownerToken, { deviceId, envelopes: batch }).expect(
      202,
    );
    expect(res.body).toEqual({ accepted: 3, duplicate: 0, invalid: 0 });

    // 排查字段：来源标记为 app_relay
    const raws = await prisma.rawEvent.findMany({ where: { deviceId } });
    expect(raws).toHaveLength(3);
    expect(raws.every((r) => r.source === 'app_relay')).toBe(true);

    // 业务等价性①：位置入轨迹表
    expect(await prisma.locationPoint.count({ where: { deviceId } })).toBe(1);
    // 业务等价性②：摔倒触发 SOS 状态机（蓝牙版保命链路的核心断言）
    const sos = await prisma.sosCase.findFirst({
      where: { deviceId, status: 'pending' },
    });
    expect(sos).not.toBeNull();
    expect(sos?.triggerType).toBe('possible_fall');
    expect(sos?.locationSource).toBe('event');
    // 设备快照也照常更新（电量）
    const device = await prisma.device.findUniqueOrThrow({
      where: { deviceId },
    });
    expect(device.battery).toBe(77);
  });

  it('断线补传幂等：整批重发 → 全部 duplicate，不重复建单/入轨迹', async () => {
    const fixed = envelope('location_update', {
      latitude: 22.53,
      longitude: 113.95,
      coordinateSystem: 'wgs84',
      accuracy: 5,
      speed: 0,
      heading: 0,
    });
    await relay(ownerToken, { deviceId, envelopes: [fixed] }).expect(202);
    const again = await relay(ownerToken, {
      deviceId,
      envelopes: [fixed],
    }).expect(202);
    expect(again.body).toEqual({ accepted: 0, duplicate: 1, invalid: 0 });
    expect(await prisma.locationPoint.count({ where: { deviceId } })).toBe(2);
    expect(await prisma.sosCase.count({ where: { deviceId } })).toBe(1);
  });

  it('类型白名单：蓝牙版范围外（video_ready/sleep_entered）→ invalid 留档不进业务', async () => {
    const res = await relay(ownerToken, {
      deviceId,
      envelopes: [
        envelope('video_ready', { videoId: 'v1', storageKey: 'k' }),
        envelope('sleep_entered', {}),
      ],
    }).expect(202);
    expect(res.body).toEqual({ accepted: 0, duplicate: 0, invalid: 2 });
    // 媒体表没有入库（未进业务流程）
    expect(await prisma.media.count({ where: { deviceId } })).toBe(0);
    // 留档为 _invalid 供排查
    expect(
      await prisma.rawEvent.count({
        where: { deviceId, eventType: '_invalid' },
      }),
    ).toBe(2);
  });

  it('脏数据：内层 deviceId 不一致 / 缺字段 / 非对象元素 → invalid 计数不报错', async () => {
    const res = await relay(ownerToken, {
      deviceId,
      envelopes: [
        envelope('device_status', { battery: 1 }, randomUUID(), 'evil_device'),
        { schemaVersion: 1, eventType: 'device_status' },
        'not-an-object',
      ],
    }).expect(202);
    expect(res.body).toEqual({ accepted: 0, duplicate: 0, invalid: 3 });
  });

  it('归属：非绑定用户 404；未登录 401', async () => {
    const res = await relay(otherToken, {
      deviceId,
      envelopes: [envelope('device_status', { battery: 50 })],
    }).expect(404);
    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
    await request(http)
      .post('/api/v1/ingest/app-relay')
      .send({ deviceId, envelopes: [] })
      .expect(401);
  });

  it('入参护栏：空数组 / 超 100 条 / deviceId 非法 → 400', async () => {
    const cases: Record<string, unknown>[] = [
      { deviceId, envelopes: [] },
      {
        deviceId,
        envelopes: Array.from({ length: 101 }, () =>
          envelope('device_status', { battery: 1 }),
        ),
      },
      { deviceId: 'bad device!', envelopes: [{}] },
    ];
    for (const body of cases) {
      const res = await relay(ownerToken, body).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });
});
