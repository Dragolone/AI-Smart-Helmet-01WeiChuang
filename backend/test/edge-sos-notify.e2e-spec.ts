// 2026-10-16 边界测试：SOS 通知内容（API.md §7、决策 #46）。
// 短信模板参数（昵称回落 / 截断、北京时间跨日跨月跨年、坐标五位小数与负数）与本人推送里的头盔称呼、时刻。
// 直接造一张已 notified 的单与待投递的通知行，再调投递，时间点可精确控制。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SosNotifierService } from '../src/sos/sos-notifier.service';
import {
  auth,
  bindDevice,
  cleanupDevices,
  cleanupUsers,
  createUser,
  provisionDevice,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  buildSosApp,
  makeProviderMocks,
  resetMocks,
  sosSmsCalls,
} from './helpers/audit-sos';

jest.setTimeout(120_000);

const mocks = makeProviderMocks();

describe('边界：SOS 通知内容 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let notifier: SosNotifierService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  const run = Date.now();
  let seq = 0;

  const setup = async (
    opts: { nickname?: string | null; deviceName?: string } = {},
  ) => {
    const u = await createUser(app, http);
    users.push(u);
    if (opts.nickname !== undefined) {
      await request(http)
        .patch('/api/v1/users/me')
        .set(auth(u.token))
        .send({ nickname: opts.nickname })
        .expect(200);
    }
    seq += 1;
    const d = `edge_notify_${run}_${seq}`;
    devices.push(d);
    await provisionDevice(prisma, d);
    await bindDevice(http, u.token, d);
    if (opts.deviceName !== undefined) {
      await prisma.device.update({
        where: { deviceId: d },
        data: { name: opts.deviceName },
      });
    }
    return { u, d };
  };

  /** 造一张已终态化的单 + 一条短信行 + 一条推送行，投递后返回短信参数与推送正文 */
  const deliver = async (
    u: TestUser,
    d: string,
    c: {
      finalizedAt: Date;
      latitude?: number | null;
      longitude?: number | null;
    },
  ) => {
    const sos = await prisma.sosCase.create({
      data: {
        deviceId: d,
        userId: u.id,
        triggerEventId: `edge_notify_${randomUUID()}`,
        triggerType: 'possible_fall',
        status: 'notified',
        deadline: c.finalizedAt,
        finalizedAt: c.finalizedAt,
        latitude: c.latitude ?? null,
        longitude: c.longitude ?? null,
        coordinateSystem: c.latitude == null ? null : 'wgs84',
      },
    });
    await prisma.sosNotification.createMany({
      data: [
        {
          sosId: sos.id,
          channel: 'sms',
          target: '19100009001',
          contactName: '家人',
        },
        { sosId: sos.id, channel: 'push', target: `user:${u.id}` },
      ],
    });
    resetMocks(mocks);
    await notifier.deliverPending(sos.id);
    const [, msg] = sosSmsCalls(mocks)[0];
    if (msg.template !== 'sos_alert') throw new Error('expected sos_alert');
    const push = mocks.push.send.mock.calls[0];
    return { params: msg.params, pushTitle: push[1], pushBody: push[2] };
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '600', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
    notifier = app.get(SosNotifierService);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  describe('时间按北京时间写', () => {
    it('UTC 9 月 30 日 16:05 = 北京 10 月 1 日 00:05：短信参数「10-01 00:05」、推送「已于 00:05」（不是 24:05）', async () => {
      const { u, d } = await setup();
      const r = await deliver(u, d, {
        finalizedAt: new Date('2026-09-30T16:05:00Z'),
      });
      expect(r.params.triggeredAt).toBe('10-01 00:05');
      expect(r.pushBody).toContain('已于 00:05');
    });

    it('跨年：UTC 12 月 31 日 16:00 = 北京 1 月 1 日 00:00 → 「01-01 00:00」；北京中午 12:30 → 「12:30」', async () => {
      const { u, d } = await setup();
      const r1 = await deliver(u, d, {
        finalizedAt: new Date('2026-12-31T16:00:00Z'),
      });
      expect(r1.params.triggeredAt).toBe('01-01 00:00');
      expect(r1.pushBody).toContain('已于 00:00');
      const r2 = await deliver(u, d, {
        finalizedAt: new Date('2026-10-15T04:30:59Z'),
      });
      expect(r2.params.triggeredAt).toBe('10-15 12:30');
    });
  });

  describe('昵称参数', () => {
    it('没昵称 / 全空白昵称 → 回落脱敏手机号（191****xxxx 形）', async () => {
      for (const nickname of [null, '   ']) {
        const { u, d } = await setup({ nickname });
        const r = await deliver(u, d, { finalizedAt: new Date() });
        expect(r.params.nickname).toBe(
          `${u.phone.slice(0, 3)}****${u.phone.slice(-4)}`,
        );
      }
    });

    it('昵称先 trim 再截前 10 个字', async () => {
      const { u, d } = await setup({
        nickname: '  一二三四五六七八九十甲乙  ',
      });
      const r = await deliver(u, d, { finalizedAt: new Date() });
      expect(r.params.nickname).toBe('一二三四五六七八九十');
    });
  });

  describe('位置参数', () => {
    it('五位小数四舍五入；南纬 / 东经负数原样带符号；无快照写「暂不可用」', async () => {
      const { u, d } = await setup();
      const r1 = await deliver(u, d, {
        finalizedAt: new Date(),
        latitude: 31.123456789,
        longitude: 121.987654321,
      });
      expect(r1.params.locationText).toBe('31.12346,121.98765');
      const r2 = await deliver(u, d, {
        finalizedAt: new Date(),
        latitude: -33.868819,
        longitude: 151.209296,
      });
      expect(r2.params.locationText).toBe('-33.86882,151.20930');
      // toFixed 按二进制值舍入：151.209295 实际存的是 151.2092949…，写成 .20929（亚米级差异，按现状）
      const r2b = await deliver(u, d, {
        finalizedAt: new Date(),
        latitude: 0.5,
        longitude: 151.209295,
      });
      expect(r2b.params.locationText).toBe('0.50000,151.20929');
      const r3 = await deliver(u, d, { finalizedAt: new Date() });
      expect(r3.params.locationText).toBe('暂不可用');
    });
  });

  describe('推送里的头盔称呼', () => {
    it('起过名用名字（trim 后）；名字全空白回落设备编号', async () => {
      const named = await setup({ deviceName: '  张三的头盔 ' });
      const r1 = await deliver(named.u, named.d, { finalizedAt: new Date() });
      expect(r1.pushTitle).toBe('SOS 已通知紧急联系人');
      expect(r1.pushBody).toContain('头盔 张三的头盔 ');
      const blank = await setup({ deviceName: '   ' });
      const r2 = await deliver(blank.u, blank.d, { finalizedAt: new Date() });
      expect(r2.pushBody).toContain(`头盔 ${blank.d} `);
    });
  });
});
