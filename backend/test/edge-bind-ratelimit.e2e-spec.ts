// 设备绑定限频：绑定码是 8 位数字、deviceId 可枚举，且响应能区分「码错 403」与「已被绑 409」，
// 不限频时可以穷举。本文件在用例内临时去掉 RATE_LIMIT_DISABLED，验证真实限频行为。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  provisionDevice,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(60_000);

describe('设备绑定限频 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let attacker: TestUser;
  const deviceId = `edge_bindrl_${Date.now()}`;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    attacker = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId]);
    await cleanupUsers(prisma, [attacker]);
    await app.close();
  });

  it('同一来源连续猜绑定码：前 10 次 403，第 11 次起 429 RATE_LIMITED + Retry-After；此时正确的码也进不来', async () => {
    const saved = process.env.RATE_LIMIT_DISABLED;
    delete process.env.RATE_LIMIT_DISABLED;
    try {
      const guess = (bindCode: string): request.Test =>
        request(http)
          .post('/api/v1/devices/bind')
          .set(auth(attacker.token))
          .send({ deviceId, bindCode });
      const statuses: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        statuses.push((await guess(String(10_000_000 + i))).status);
      }
      expect(statuses).toEqual(Array<number>(10).fill(403));

      const limited = await guess('10000099');
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);

      // 限的是尝试次数：窗口内猜中也无效，设备仍未绑定
      expect((await guess(`bc_${deviceId}`)).status).toBe(429);
      const device = await prisma.device.findUniqueOrThrow({
        where: { deviceId },
      });
      expect(device.bindUserId).toBeNull();
    } finally {
      if (saved !== undefined) process.env.RATE_LIMIT_DISABLED = saved;
    }
  });

  it('限频关闭（联调 / 压力口径）时不受影响：正确的码照常绑定', async () => {
    process.env.RATE_LIMIT_DISABLED = '1';
    await request(http)
      .post('/api/v1/devices/bind')
      .set(auth(attacker.token))
      .send({ deviceId, bindCode: `bc_${deviceId}` })
      .expect(200);
  });
});
