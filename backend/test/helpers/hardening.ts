// 上线前加固测试公共辅助：起完整应用（与 main.ts 同管线）、造用户/设备、清理。
// 与各 e2e 套件的 boilerplate 等价，只是抽出来给 hardening-*/stress 套件复用。
import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../src/app.module';
import { UnifiedExceptionFilter } from '../../src/common/http-exception.filter';
import { requestIdMiddleware } from '../../src/common/request-id.middleware';
import { PrismaService } from '../../src/prisma/prisma.service';
import { registerUser } from './register';

export type Http = ReturnType<INestApplication['getHttpServer']>;

export const randomPhone = (): string =>
  `19${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface TestUser {
  id: string;
  phone: string;
  password: string;
  token: string;
  refreshToken: string;
}

export async function buildApp(
  customize?: (b: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<{ app: INestApplication; http: Http; prisma: PrismaService }> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (customize) builder = customize(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.use(requestIdMiddleware);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new UnifiedExceptionFilter());
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.init();
  return { app, http: app.getHttpServer(), prisma: app.get(PrismaService) };
}

/** 监听随机端口（WS 用例需要真实 TCP 端口），返回 ws://host:port */
export async function listenRandomPort(app: INestApplication): Promise<string> {
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

export async function createUser(
  app: INestApplication,
  http: Http,
  password = 'hardening_pw_1',
): Promise<TestUser> {
  const phone = randomPhone();
  const res = await registerUser(app, http, { phone, password });
  return {
    id: res.body.user.id as string,
    phone,
    password,
    token: res.body.accessToken as string,
    refreshToken: res.body.refreshToken as string,
  };
}

export async function provisionDevice(
  prisma: PrismaService,
  deviceId: string,
): Promise<{ deviceId: string; bindCode: string }> {
  const bindCode = `bc_${deviceId}`;
  await prisma.device.create({
    data: {
      deviceId,
      deviceSecretHash: createHash('sha256').update('hardening').digest('hex'),
      bindCode,
    },
  });
  return { deviceId, bindCode };
}

export async function bindDevice(
  http: Http,
  token: string,
  deviceId: string,
  bindCode = `bc_${deviceId}`,
): Promise<void> {
  await request(http)
    .post('/api/v1/devices/bind')
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId, bindCode })
    .expect(200);
}

export const envelope = (
  deviceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schemaVersion: 1,
  eventId: randomUUID(),
  deviceId,
  eventType,
  timestamp: new Date().toISOString(),
  firmwareVersion: '0.1.0-hardening',
  payload,
  ...overrides,
});

export const validLocation = (i = 0): Record<string, unknown> => ({
  latitude: 31.2 + i * 0.0001,
  longitude: 121.5 + i * 0.0001,
  coordinateSystem: 'gcj02',
  accuracy: 5,
  speed: 3.2,
  heading: 90,
  altitude: 12,
});

export const relay = (
  http: Http,
  token: string,
  deviceId: string,
  envelopes: unknown[],
): request.Test =>
  request(http)
    .post('/api/v1/ingest/app-relay')
    .set('Authorization', `Bearer ${token}`)
    .send({ deviceId, envelopes });

export const auth = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

/** 按设备清掉所有派生数据（与各 e2e 套件的 afterAll 同顺序） */
export async function cleanupDevices(
  prisma: PrismaService,
  deviceIds: string[],
): Promise<void> {
  if (deviceIds.length === 0) return;
  const where = { deviceId: { in: deviceIds } };
  const swallow = () => undefined;
  await prisma.sosNotification
    .deleteMany({ where: { sos: where } })
    .catch(swallow);
  await prisma.sosCase.deleteMany({ where }).catch(swallow);
  await prisma.deviceCommand.deleteMany({ where }).catch(swallow);
  await prisma.media.deleteMany({ where }).catch(swallow);
  await prisma.locationPoint.deleteMany({ where }).catch(swallow);
  await prisma.rawEvent.deleteMany({ where }).catch(swallow);
  await prisma.device.deleteMany({ where }).catch(swallow);
}

export async function cleanupUsers(
  prisma: PrismaService,
  users: Array<{ id: string; phone: string }>,
): Promise<void> {
  if (users.length === 0) return;
  const ids = users.map((u) => u.id);
  const phones = users.map((u) => u.phone);
  const swallow = () => undefined;
  await prisma.voiceChannelMember
    .deleteMany({ where: { userId: { in: ids } } })
    .catch(swallow);
  await prisma.voiceChannel
    .deleteMany({ where: { ownerId: { in: ids } } })
    .catch(swallow);
  await prisma.emergencyContact
    .deleteMany({ where: { userId: { in: ids } } })
    .catch(swallow);
  await prisma.refreshToken
    .deleteMany({ where: { userId: { in: ids } } })
    .catch(swallow);
  await prisma.smsCode
    .deleteMany({ where: { phone: { in: phones } } })
    .catch(swallow);
  await prisma.device
    .updateMany({
      where: { bindUserId: { in: ids } },
      data: { bindUserId: null, boundAt: null },
    })
    .catch(swallow);
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(swallow);
}

/** 简单并发统计：状态码直方图 */
export const histogram = (statuses: number[]): Record<string, number> =>
  statuses.reduce<Record<string, number>>((acc, s) => {
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

/** 分位数（ms） */
export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx];
};
