// 设备绑定全链路集成测试：开通 → 绑定（错码/冲突/幂等）→ 状态 → 解绑。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { PrismaService } from '../src/prisma/prisma.service';
import { registerUser } from './helpers/register';

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

describe('设备绑定全链路 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  const deviceId = `e2e_dev_${Date.now()}`;
  const bindCode = '87654321';
  let tokenA: string;
  let tokenB: string;

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
    // RealtimeGateway 在模块图中，init 前必须装 WS 适配器（与 main.ts 一致）
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);

    // 开通一台测试设备（与 provision 脚本同机制）
    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256')
          .update('test_secret')
          .digest('hex'),
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
    tokenA = await register();
    tokenB = await register();
  });

  afterAll(async () => {
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  it('未登录绑定 → 401', async () => {
    await request(http)
      .post('/api/v1/devices/bind')
      .send({ deviceId, bindCode })
      .expect(401);
  });

  it('绑定码错误 → 403 BIND_CODE_INVALID', async () => {
    const res = await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ deviceId, bindCode: '00000000' })
      .expect(403);
    expect(res.body.code).toBe('BIND_CODE_INVALID');
  });

  it('用户 A 绑定成功（初始离线）', async () => {
    const res = await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ deviceId, bindCode })
      .expect(200);
    expect(res.body.deviceId).toBe(deviceId);
    expect(res.body.online).toBe(false);
  });

  it('A 重复绑定 → 幂等成功；B 绑定 → 409 DEVICE_ALREADY_BOUND', async () => {
    await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ deviceId, bindCode })
      .expect(200);

    const res = await request(http)
      .post('/api/v1/devices/bind')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ deviceId, bindCode })
      .expect(409);
    expect(res.body.code).toBe('DEVICE_ALREADY_BOUND');
  });

  it('B 查看 A 的设备 → 404（不泄露存在性）', async () => {
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
    expect(res.body.code).toBe('DEVICE_NOT_FOUND');
  });

  it('设备心跳后状态变为在线（快照 → status 链路）', async () => {
    // 模拟 Ingest 快照更新过 lastSeenAt
    await prisma.device.update({
      where: { deviceId },
      data: { lastSeenAt: new Date(), battery: 77 },
    });
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/status`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(res.body.online).toBe(true);
    expect(res.body.battery).toBe(77);
  });

  it('A 的设备列表包含该设备', async () => {
    const res = await request(http)
      .get('/api/v1/devices')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(res.body.map((d: { deviceId: string }) => d.deviceId)).toContain(
      deviceId,
    );
  });

  it('电量历史：device_status 心跳按 10 分钟桶聚合，仅本人可查', async () => {
    const now = Date.now();
    await prisma.rawEvent.createMany({
      data: [1, 2, 3, 25].map((minAgo, i) => ({
        eventId: `e2e-bat-${now}-${i}`,
        deviceId,
        eventType: 'device_status',
        timestamp: new Date(now - minAgo * 60_000),
        schemaVersion: 1,
        payload: { battery: 90 - i, charging: i === 3 },
        source: 'mqtt',
      })),
    });
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/battery-history?hours=1`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    // 前三条落在同一个 10 分钟桶（取最后一条 = 1 分钟前那条，battery 90），25 分钟前的单独一桶
    expect(res.body.points).toHaveLength(2);
    expect(res.body.points[0].battery).toBe(87);
    expect(res.body.points[0].charging).toBe(true);
    expect(res.body.points[1].battery).toBe(90);
    expect(new Date(res.body.from).getTime()).toBeLessThan(
      new Date(res.body.to).getTime(),
    );
    await request(http)
      .get(`/api/v1/devices/${deviceId}/battery-history?hours=0`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);
    await prisma.rawEvent.deleteMany({
      where: { eventId: { startsWith: `e2e-bat-${now}` } },
    });
  });

  it('解绑 → 204，列表清空，设备记录留档', async () => {
    await request(http)
      .delete(`/api/v1/devices/${deviceId}/binding`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(204);

    const list = await request(http)
      .get('/api/v1/devices')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(list.body).toHaveLength(0);

    const still = await prisma.device.findUnique({ where: { deviceId } });
    expect(still).not.toBeNull();
  });
});
