// 2026-09-13 全面测试审计 · contract 领域：文档（API.md / EVENTS.md）与实现的一致性探针。
// 每个 describe 断言的是 Contract 写明的行为；断言失败 = 文档与实现不一致（报告里编号 CONTRACT-xx）。
// 只用本套件自己创建的用户/设备，afterAll 只清理这些行。
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  provisionDevice,
  relay,
  sleep,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(60_000);

describe('audit-contract：API.md / EVENTS.md 与实现一致性', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  const users: TestUser[] = [];
  const deviceIds: string[] = [];
  const uid = `audit_c_${Date.now().toString(36)}`;

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
  });

  afterAll(async () => {
    await cleanupDevices(prisma, deviceIds);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  const newUser = async (): Promise<TestUser> => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };

  const newDevice = async (suffix: string): Promise<string> => {
    const deviceId = `${uid}_${suffix}`;
    await provisionDevice(prisma, deviceId);
    deviceIds.push(deviceId);
    return deviceId;
  };

  describe('CONTRACT-01 API.md §2：change-password 的 newPassword "与注册同规则（8–72）且 ≤72 字节"', () => {
    it('72 个汉字（216 字节）的新密码应 400 VALIDATION_FAILED（注册/找回同口径）', async () => {
      const u = await newUser();
      const cjk72 = '密'.repeat(72);
      // 对照：注册与找回密码入口对同一值都拒绝（@MaxBytes(72) 已落地）
      const reg = await request(http)
        .post('/api/v1/auth/register')
        .send({ phone: '19900000000', code: '000000', password: cjk72 });
      expect(reg.status).toBe(400);

      const res = await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(u.token))
        .send({ oldPassword: u.password, newPassword: cjk72 });
      // Contract：newPassword 与注册同规则 → 400；实现缺 @MaxBytes → 204
      expect(res.status).toBe(400);
    });

    it('（后果佐证）超 72 字节的新密码被 bcrypt 静默截断：前 24 个汉字 + 任意尾巴即可登录', async () => {
      const u = await newUser();
      const cjk72 = '码'.repeat(72);
      const changed = await request(http)
        .post('/api/v1/auth/change-password')
        .set(auth(u.token))
        .send({ oldPassword: u.password, newPassword: cjk72 });
      if (changed.status !== 204) {
        // 若上一条已修复（400），本条无需再证
        expect(changed.status).toBe(400);
        return;
      }
      const truncatedVariant = `${'码'.repeat(24)}${'x'.repeat(48)}`;
      const login = await request(http)
        .post('/api/v1/auth/login')
        .send({ phone: u.phone, password: truncatedVariant });
      // 正确行为：不同密码不能登录（401）；截断缺陷下这里会是 200
      expect(login.status).toBe(401);
    });
  });

  describe('CONTRACT-02 EVENTS.md §1/§9 & DEVICE_PROTOCOL §9：未知 schemaVersion "进原始事件表并告警，不进业务流程"', () => {
    it('schemaVersion=999 的 possible_fall 应只留档，不建 SOS 单', async () => {
      const u = await newUser();
      const deviceId = await newDevice('sv');
      await bindDevice(http, u.token, deviceId);
      const env = envelope(
        deviceId,
        'possible_fall',
        { confidence: 0.9 },
        { schemaVersion: 999 },
      );
      const res = await relay(http, u.token, deviceId, [env]).expect(202);
      // 原始留档必须存在（两种落法都算留档：原 eventId 或 _invalid 替身）
      const raw = await prisma.rawEvent.findFirst({
        where: {
          OR: [
            { eventId: env.eventId as string },
            { deviceId, eventType: '_invalid' },
          ],
        },
      });
      expect(raw).not.toBeNull();
      // Contract：不进业务流程 → 无 SOS 单
      await sleep(200);
      const sos = await prisma.sosCase.findFirst({
        where: { triggerEventId: env.eventId as string },
      });
      // 记录实际计数供报告

      console.log(
        `[CONTRACT-02] relay 响应=${JSON.stringify(res.body)} rawEventType=${raw?.eventType} sosCreated=${sos !== null}`,
      );
      expect(sos).toBeNull();
    });
  });

  describe('CONTRACT-03 决策 #39「设备历史数据按绑定区间归属」：battery-history 是否同口径', () => {
    it('换绑后新主的 battery-history 不应包含前主期间的心跳点', async () => {
      const a = await newUser();
      const b = await newUser();
      const deviceId = await newDevice('bh');
      await bindDevice(http, a.token, deviceId);
      await relay(http, a.token, deviceId, [
        envelope(deviceId, 'device_status', { battery: 77, charging: false }),
      ]).expect(202);
      await request(http)
        .delete(`/api/v1/devices/${deviceId}/binding`)
        .set(auth(a.token))
        .expect(204);
      await sleep(20);
      await bindDevice(http, b.token, deviceId);

      // 对照：§6 事件查询已按绑定区间过滤——新主看不到前主的 device_status
      const events = await request(http)
        .get(`/api/v1/devices/${deviceId}/events?type=device_status`)
        .set(auth(b.token))
        .expect(200);
      expect(events.body.total).toBe(0);

      const bh = await request(http)
        .get(`/api/v1/devices/${deviceId}/battery-history?hours=1`)
        .set(auth(b.token))
        .expect(200);

      console.log(
        `[CONTRACT-03] 新主 events.total=${events.body.total} battery-history.points=${JSON.stringify(bh.body.points)}`,
      );
      expect(bh.body.points).toHaveLength(0);
    });
  });

  describe('CONTRACT-04 API.md §8 / app devices.ts：PUT settings 响应形状', () => {
    it('202 响应只有 { commandId, status:"pending" }（App 侧 api<CommandPublic> 类型标注过宽）', async () => {
      const u = await newUser();
      const deviceId = await newDevice('ps');
      await bindDevice(http, u.token, deviceId);
      const res = await request(http)
        .put(`/api/v1/devices/${deviceId}/settings`)
        .set(auth(u.token))
        .send({ settings: { volume: 50 } })
        .expect(202);
      expect(Object.keys(res.body).sort()).toEqual(['commandId', 'status']);
      expect(res.body.status).toBe('pending');
    });
  });

  describe('CONTRACT-05 API.md §13：成员列表对象字段', () => {
    it('members 项含 joinedAt（shared/实现有、API.md 表述缺）且 phone 已脱敏', async () => {
      const u = await newUser();
      const ch = await request(http)
        .post('/api/v1/voice/channels')
        .set(auth(u.token))
        .send({ name: 'audit' })
        .expect(201);
      const members = await request(http)
        .get(`/api/v1/voice/channels/${ch.body.channelId}/members`)
        .set(auth(u.token))
        .expect(200);
      expect(Object.keys(members.body[0]).sort()).toEqual(
        ['avatarUrl', 'joinedAt', 'nickname', 'phone', 'userId'].sort(),
      );
      expect(members.body[0].phone).toMatch(/^\d{3}\*{4}\d{4}$/);
    });
  });

  describe('CONTRACT-06 API.md §10.1 / shared AdminDeviceRow extends DevicePublic', () => {
    it('admin 设备列表项不含 name/bindCode（与 §10.1 文档一致，与 shared 类型不一致）', async () => {
      const username = `${uid}_admin`;
      const bcrypt = await import('bcrypt');
      const admin = await prisma.adminUser.create({
        data: {
          username,
          passwordHash: await bcrypt.hash('audit_admin_pw', 4),
        },
      });
      try {
        const login = await request(http)
          .post('/api/v1/admin/auth/login')
          .send({ username, password: 'audit_admin_pw' })
          .expect(200);
        const deviceId = await newDevice('ad');
        const list = await request(http)
          .get(`/api/v1/admin/devices?keyword=${deviceId}`)
          .set(auth(login.body.accessToken))
          .expect(200);
        const row = list.body.items.find(
          (d: { deviceId: string }) => d.deviceId === deviceId,
        );
        expect(row).toBeDefined();
        // 文档口径：无 name / bindCode；shared AdminDeviceRow 却继承了这两个必有字段
        expect('name' in row).toBe(false);
        expect('bindCode' in row).toBe(false);
      } finally {
        await prisma.adminUser.delete({ where: { id: admin.id } });
      }
    });
  });

  describe('CONTRACT-07 API.md §1.2：数据库不可达时 /health 的 503 响应体', () => {
    it('文档写 { status:"error", database:"unreachable" }；统一过滤器会把它改写成 { code, message, requestId }', async () => {
      const spy = jest
        .spyOn(prisma, '$queryRaw')
        .mockRejectedValueOnce(new Error('audit: simulated db down'));
      try {
        const res = await request(http).get('/api/v1/health').expect(503);
        console.log(
          `[CONTRACT-07] /health 503 body=${JSON.stringify(res.body)}`,
        );
        expect(res.body).toMatchObject({
          status: 'error',
          database: 'unreachable',
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
