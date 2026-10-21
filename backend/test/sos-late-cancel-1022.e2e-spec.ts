// 求救单的两条时序口径（上线清单 B 线 25 / 15，2026-10-22）：
// ① 截止后、到期扫描处理前发来的取消仍然有效——取消只看状态不看时间（决策 #63）；扫描处理过的再取消 409。
// ② 改密码撤销其他会话后，手里的 access token 到期前照常能取消：正在倒数的那台手机不会因为改密而失效
//   （access 15 分钟远长于 60 秒倒计时；守卫只查注销，不查会话撤销）。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UnifiedExceptionFilter } from '../src/common/http-exception.filter';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SMS_PROVIDER, type SmsMessage } from '../src/providers/sms.provider';
import { SosSchedulerService } from '../src/sos/sos-scheduler.service';
import { settleSosDelivery } from './helpers/audit-sos';
import { registerUser } from './helpers/register';

jest.setTimeout(60000);

const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const deviceId = `helmet_lc${randomUUID().replace(/-/g, '').slice(0, 6)}`;
const bindCode = `bc_${deviceId}`;

describe('求救取消的时序口径：截止后扫描前仍可取消；改密后旧 access token 仍可取消 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ingest: IngestService;
  let scheduler: SosSchedulerService;
  let token: string;
  let refreshToken: string;
  const smsMock = { send: jest.fn<Promise<void>, [string, SmsMessage]>() };

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const cancelPath = (sosId: string) => `/api/v1/sos/${sosId}/cancel`;
  /** 求救相关的短信（排除注册验证码） */
  const sosSmsCalls = () =>
    smsMock.send.mock.calls.filter(([, m]) => m.template !== 'verify_code');

  const newCase = async () => {
    const eventId = randomUUID();
    await ingest.ingestRaw(
      JSON.stringify({
        schemaVersion: 1,
        eventId,
        deviceId,
        eventType: 'possible_fall',
        timestamp: new Date().toISOString(),
        firmwareVersion: '0.1.0-e2e',
        payload: {
          confidence: 0.9,
          location: {
            latitude: 40.94901,
            longitude: 115.41802,
            coordinateSystem: 'wgs84',
            accuracy: 6,
          },
        },
      }),
      deviceId,
      'mqtt',
    );
    return prisma.sosCase.findFirstOrThrow({
      where: { triggerEventId: eventId },
    });
  };

  beforeAll(async () => {
    // 1 秒倒计时；扫描间隔调大，到期处理全部由测试手动 tick 驱动
    process.env.SOS_COUNTDOWN_SECONDS = '1';
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    smsMock.send.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SMS_PROVIDER)
      .useValue(smsMock)
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
    ingest = app.get(IngestService);
    scheduler = app.get(SosSchedulerService);

    await prisma.device.create({
      data: {
        deviceId,
        deviceSecretHash: createHash('sha256').update('e2e').digest('hex'),
        bindCode,
      },
    });
    const res = await registerUser(app, http, {
      phone: randomPhone(),
      password: 'e2e_password_1',
    });
    token = res.body.accessToken as string;
    refreshToken = res.body.refreshToken as string;
    await request(http)
      .post('/api/v1/devices/bind')
      .set(auth())
      .send({ deviceId, bindCode })
      .expect(200);
    await request(http)
      .post('/api/v1/users/me/emergency-contacts')
      .set(auth())
      .send({ name: '家人', phone: '13800007777' })
      .expect(201);
  });

  afterEach(() => settleSosDelivery(app));

  afterAll(async () => {
    await prisma.sosNotification
      .deleteMany({ where: { sos: { deviceId } } })
      .catch(() => undefined);
    await prisma.sosCase
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await prisma.rawEvent
      .deleteMany({ where: { deviceId } })
      .catch(() => undefined);
    await app.close();
  });

  it('截止后、扫描处理前的取消仍然有效：单子变 cancelled，之后扫描不再通知、没有发出求救短信（决策 #63）', async () => {
    const sosCase = await newCase();
    expect(sosCase.status).toBe('pending');
    await sleep(1200);
    expect(sosCase.deadline.getTime()).toBeLessThan(Date.now());

    const res = await request(http)
      .post(cancelPath(sosCase.id))
      .set(auth())
      .expect(200);
    expect(res.body.status).toBe('cancelled');

    await scheduler.tick();
    await scheduler.tick();
    expect(
      (await prisma.sosCase.findUniqueOrThrow({ where: { id: sosCase.id } }))
        .status,
    ).toBe('cancelled');
    expect(sosSmsCalls()).toHaveLength(0);
  });

  it('扫描已把它通知出去的再取消：409 SOS_ALREADY_FINALIZED，短信已发', async () => {
    const sosCase = await newCase();
    await sleep(1200);
    await scheduler.tick();
    await scheduler.tick();
    const res = await request(http)
      .post(cancelPath(sosCase.id))
      .set(auth())
      .expect(409);
    expect(res.body.code).toBe('SOS_ALREADY_FINALIZED');
    expect(
      (await prisma.sosCase.findUniqueOrThrow({ where: { id: sosCase.id } }))
        .status,
    ).toBe('notified');
    expect(sosSmsCalls().length).toBeGreaterThan(0);
  });

  it('改密码撤销其他会话后：旧 refresh token 已失效，但手里的 access token 到期前照常能取消（B 线 15 评估结论）', async () => {
    await request(http)
      .post('/api/v1/auth/change-password')
      .set(auth())
      .send({ oldPassword: 'e2e_password_1', newPassword: 'e2e_password_2' })
      .expect(204);
    await request(http)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    const sosCase = await newCase();
    const active = await request(http)
      .get('/api/v1/users/me/sos/active')
      .set(auth())
      .expect(200);
    expect(active.body.items.map((i: { sosId: string }) => i.sosId)).toContain(
      sosCase.id,
    );
    const res = await request(http)
      .post(cancelPath(sosCase.id))
      .set(auth())
      .expect(200);
    expect(res.body.status).toBe('cancelled');
  });
});
