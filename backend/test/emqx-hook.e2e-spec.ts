// EMQX 内部回调接口集成测试：内部令牌校验 + 认证/授权应答格式。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { PrismaService } from '../src/prisma/prisma.service';

describe('EMQX 内部回调 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  const deviceId = `e2e_emqx_${Date.now()}`;
  const secret = 'e2e_device_secret';
  const internalToken = process.env.EMQX_INTERNAL_TOKEN ?? '';

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
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256').update(secret).digest('hex'),
      },
    });
  });

  afterAll(async () => {
    await prisma.device.delete({ where: { deviceId } }).catch(() => undefined);
    await app.close();
  });

  it('缺内部令牌 → 401（EMQX 之外的来源一律拒绝）', async () => {
    await request(http)
      .post('/api/v1/internal/emqx/authenticate')
      .send({ username: deviceId, password: secret })
      .expect(401);
  });

  it('正确设备凭证 → allow；错误密钥 → deny', async () => {
    const ok = await request(http)
      .post('/api/v1/internal/emqx/authenticate')
      .set('x-internal-token', internalToken)
      .send({ username: deviceId, password: secret })
      .expect(200);
    expect(ok.body.result).toBe('allow');

    const bad = await request(http)
      .post('/api/v1/internal/emqx/authenticate')
      .set('x-internal-token', internalToken)
      .send({ username: deviceId, password: 'wrong' })
      .expect(200);
    expect(bad.body.result).toBe('deny');
  });

  it('授权：自己的 Topic allow，别人的 deny', async () => {
    const own = await request(http)
      .post('/api/v1/internal/emqx/authorize')
      .set('x-internal-token', internalToken)
      .send({
        username: deviceId,
        topic: `helmet/${deviceId}/event`,
        action: 'publish',
      })
      .expect(200);
    expect(own.body.result).toBe('allow');

    const cross = await request(http)
      .post('/api/v1/internal/emqx/authorize')
      .set('x-internal-token', internalToken)
      .send({
        username: deviceId,
        topic: 'helmet/other_device/event',
        action: 'publish',
      })
      .expect(200);
    expect(cross.body.result).toBe('deny');
  });
});
