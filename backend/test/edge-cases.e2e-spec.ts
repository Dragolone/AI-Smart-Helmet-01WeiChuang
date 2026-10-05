// 边缘情况补测（2026-10-03）：前两轮加固/审计没覆盖到的边界——
// 回执时间戳「JS 合法但数据库存不下」、WS 握手期间断开、验证码并发猜测、
// 7 天电量历史截断、查询时间极值、未来时钟的位置点、并列时间戳分页、Ingest 的 NUL 误判与孤立代理项。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { SmsCodeService } from '../src/auth/sms-code.service';
import { CommandsService } from '../src/commands/commands.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import {
  adminGet,
  cleanupAdmins,
  createAdmin,
  type TestAdmin,
} from './helpers/audit-admin';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  listenRandomPort,
  provisionDevice,
  randomPhone,
  relay,
  sleep,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';
import { lastCodeFor, spyOnSms } from './helpers/register';

jest.setTimeout(120_000);

/** JS 能解析、PostgreSQL timestamp 存不下的时间（年份 0000） */
const YEAR_ZERO = '0000-01-01T00:00:00Z';

describe('边缘情况补测 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let commands: CommandsService;
  let gateway: RealtimeGateway;
  let wsBase: string;

  const run = Date.now();
  const deviceId = `edge_dev_${run}`;
  const batteryDeviceId = `edge_bat_${run}`;
  const clockDeviceId = `edge_clk_${run}`;
  let owner: TestUser;
  let admin: TestAdmin;
  const extraPhones: string[] = [];

  beforeAll(async () => {
    // 扫描任务不参与本套件：避免周期 tick 把刚建的命令判 offline、把 SOS 提前终态化
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    process.env.COMMAND_SCAN_INTERVAL_MS = '600000';
    ({ app, http, prisma } = await buildApp());
    wsBase = await listenRandomPort(app);
    commands = app.get(CommandsService);
    gateway = app.get(RealtimeGateway);
    spyOnSms(app);
    owner = await createUser(app, http);
    admin = await createAdmin(prisma, http, `edge_admin_${run}`);
    for (const id of [deviceId, batteryDeviceId, clockDeviceId]) {
      await provisionDevice(prisma, id);
      await bindDevice(http, owner.token, id);
    }
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId, batteryDeviceId, clockDeviceId]);
    await cleanupUsers(prisma, [owner]);
    await prisma.smsCode.deleteMany({ where: { phone: { in: extraPhones } } });
    await cleanupAdmins(prisma, [admin.username]);
    await app.close();
  });

  describe('命令回执：executedAt 是合法日期但数据库存不下', () => {
    const issue = async (): Promise<string> => {
      const res = await request(http)
        .put(`/api/v1/devices/${deviceId}/settings`)
        .set(auth(owner.token))
        .send({ settings: { volume: 3 } })
        .expect(202);
      return res.body.commandId as string;
    };

    it('relay-ack executed 带年份 0000：200 且命令终态 success，executedAt 取服务器时间', async () => {
      const commandId = await issue();
      const before = Date.now();
      const res = await request(http)
        .post(`/api/v1/devices/${deviceId}/commands/${commandId}/relay-ack`)
        .set(auth(owner.token))
        .send({ stage: 'executed', result: 'success', executedAt: YEAR_ZERO });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      const row = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: commandId },
      });
      expect(row.executedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('MQTT cmd_ack 带年份 0000：回执不能被吞掉（否则设备已执行却被判 offline）', async () => {
      const commandId = await issue();
      await commands.handleAck(
        deviceId,
        JSON.stringify({ commandId, result: 'success', executedAt: YEAR_ZERO }),
      );
      const row = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: commandId },
      });
      expect(row.status).toBe('success');
    });

    it('executedAt 为 9999 年、errorCode 一万字符：不 5xx', async () => {
      const commandId = await issue();
      const res = await request(http)
        .post(`/api/v1/devices/${deviceId}/commands/${commandId}/relay-ack`)
        .set(auth(owner.token))
        .send({
          stage: 'executed',
          result: 'failed',
          errorCode: 'E'.repeat(10_000),
          executedAt: '9999-12-31T23:59:59Z',
        });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
    });
  });

  describe('WS：握手完成前客户端就断开', () => {
    it('open 即 terminate 的 20 个连接：连接表、反查表、到期定时器都不留残留', async () => {
      const internals = gateway as unknown as {
        byUser: Map<string, Set<WebSocket>>;
        clientUser: Map<WebSocket, string>;
        expiryTimers: Map<WebSocket, NodeJS.Timeout>;
      };
      const before = {
        clientUser: internals.clientUser.size,
        expiryTimers: internals.expiryTimers.size,
      };
      const conns = Array.from(
        { length: 20 },
        () => new WebSocket(`${wsBase}/ws?token=${owner.token}`),
      );
      await Promise.all(
        conns.map(
          (ws) =>
            new Promise<void>((resolve) => {
              ws.on('open', () => ws.terminate());
              ws.on('error', () => undefined);
              ws.on('close', () => resolve());
            }),
        ),
      );
      // 服务端的注册在一次数据库查询之后才发生：等它全部走完再看
      await sleep(500);
      expect(internals.byUser.get(owner.id)?.size ?? 0).toBe(0);
      expect(internals.clientUser.size).toBe(before.clientUser);
      expect(internals.expiryTimers.size).toBe(before.expiryTimers);
    });
  });

  describe('验证码：并发猜测不能突破错误次数上限', () => {
    it('同一验证码并发 30 次错码：实际被比对的次数不超过上限 5', async () => {
      const phone = randomPhone();
      extraPhones.push(phone);
      await request(http)
        .post('/api/v1/auth/sms-code')
        .send({ phone, purpose: 'register' })
        .expect(204);
      const code = lastCodeFor(app, phone);
      const wrongCodes = Array.from({ length: 30 }, (_, i) =>
        String(100_000 + i),
      ).filter((c) => c !== code);
      // 直接并发打服务层：30 个校验在同一拍发出，全部先读到 attempts=0（HTTP 层的并发度不稳定，复现不了）
      const smsCodes = app.get(SmsCodeService);
      const results = await Promise.allSettled(
        wrongCodes.map((c) => smsCodes.verifyAndConsume(phone, 'register', c)),
      );
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      const row = await prisma.smsCode.findFirstOrThrow({
        where: { phone, purpose: 'register' },
        orderBy: { createdAt: 'desc' },
      });
      // attempts 即「被拿去比对的次数」：占不到名额的请求不比对
      expect(row.attempts).toBe(5);
      // 上限耗尽后正确码同样失效
      await request(http)
        .post('/api/v1/auth/register')
        .send({ phone, code, password: 'edge_case_pw_1' })
        .expect(400);
    });
  });

  describe('电量历史：7 天窗口', () => {
    it('60 秒心跳 × 7 天（10080 条）：曲线必须覆盖到最近 10 分钟，而不是只有最早的一段', async () => {
      const now = Date.now();
      // 绑定区间回拨到 8 天前，让这 7 天心跳都在本人区间内
      await prisma.deviceBinding.updateMany({
        where: { deviceId: batteryDeviceId, userId: owner.id },
        data: { boundAt: new Date(now - 8 * 24 * 3_600_000) },
      });
      const rows = Array.from({ length: 10_080 }, (_, i) => {
        const at = new Date(now - (i + 1) * 60_000);
        return {
          eventId: `edge-bat-${run}-${i}`,
          deviceId: batteryDeviceId,
          eventType: 'device_status',
          timestamp: at,
          receivedAt: at,
          schemaVersion: 1,
          payload: { battery: 100 - (i % 100), charging: false },
          source: 'app_relay',
        };
      });
      await prisma.rawEvent.createMany({ data: rows });
      const res = await request(http)
        .get(`/api/v1/devices/${batteryDeviceId}/battery-history?hours=168`)
        .set(auth(owner.token))
        .expect(200);
      const points = res.body.points as { timestamp: string }[];
      const last = new Date(points[points.length - 1].timestamp).getTime();
      const first = new Date(points[0].timestamp).getTime();
      expect(now - last).toBeLessThanOrEqual(10 * 60_000);
      expect(now - first).toBeGreaterThanOrEqual(167 * 3_600_000);
      // 10 分钟一个桶：7 天 1008 个桶（窗口两端各可能多半个桶）
      expect(points.length).toBeGreaterThanOrEqual(1007);
      expect(points.length).toBeLessThanOrEqual(1009);
      // 按时间升序
      const times = points.map((p) => new Date(p.timestamp).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });
  });

  describe('电量历史：越界值', () => {
    it('电量不是 0–100 的整数（255 / -1 / 55.5 / 字符串）按缺失跳过，不截成 100% 画出来；同桶取最后一条合法的', async () => {
      const now = Date.now();
      // receivedAt 取当前（在绑定区间内）；timestamp 每条错开 11 分钟，各占一个 10 分钟桶
      const heartbeat = (minutesAgo: number, battery: unknown) => ({
        eventId: `edge-batv-${run}-${minutesAgo}-${String(battery)}`,
        deviceId,
        eventType: 'device_status',
        timestamp: new Date(now - minutesAgo * 60_000),
        receivedAt: new Date(now),
        schemaVersion: 1,
        payload: { battery, charging: false } as object,
        source: 'app_relay',
      });
      await prisma.rawEvent.createMany({
        data: [
          heartbeat(55, 255),
          heartbeat(44, -1),
          heartbeat(33, 55.5),
          heartbeat(22, '80'),
          // 同一个桶：先一条合法的 60，后一条越界的 255 → 该桶取 60
          heartbeat(12, 60),
          heartbeat(11, 255),
          heartbeat(1, 100),
        ],
      });
      const res = await request(http)
        .get(`/api/v1/devices/${deviceId}/battery-history?hours=1`)
        .set(auth(owner.token))
        .expect(200);
      const batteries = (
        res.body.points as { battery: number; timestamp: string }[]
      )
        .filter((p) => now - new Date(p.timestamp).getTime() <= 56 * 60_000)
        .map((p) => p.battery);
      expect(batteries).toEqual([60, 100]);
    });
  });

  describe('查询时间极值：年份 0000（ISO 合法、数据库存不下）', () => {
    it('事件 / 轨迹 / 轨迹统计 / Admin 事件：一律 400 VALIDATION_FAILED，不得 500', async () => {
      const responses = await Promise.all([
        request(http)
          .get(`/api/v1/devices/${deviceId}/events`)
          .query({ from: YEAR_ZERO })
          .set(auth(owner.token)),
        request(http)
          .get(`/api/v1/devices/${deviceId}/events`)
          .query({ to: YEAR_ZERO })
          .set(auth(owner.token)),
        request(http)
          .get(`/api/v1/devices/${deviceId}/locations`)
          .query({ from: YEAR_ZERO, to: '0000-01-01T01:00:00Z' })
          .set(auth(owner.token)),
        request(http)
          .get(`/api/v1/devices/${deviceId}/locations/summary`)
          .query({ from: YEAR_ZERO, to: '0000-01-01T01:00:00Z' })
          .set(auth(owner.token)),
        adminGet(http, admin.token, '/events', { from: YEAR_ZERO }),
        adminGet(http, admin.token, '/events', { to: YEAR_ZERO }),
      ]);
      expect(responses.map((r) => r.status)).toEqual([
        400, 400, 400, 400, 400, 400,
      ]);
      expect(responses.every((r) => r.body.code === 'VALIDATION_FAILED')).toBe(
        true,
      );
    });
  });

  describe('设备时钟跑到未来的位置点', () => {
    it('一条两年后的位置点不能把「最新位置」和 SOS 位置快照永久钉死', async () => {
      const future = new Date(Date.now() + 2 * 365 * 24 * 3_600_000);
      const bogus = envelope(
        clockDeviceId,
        'location_update',
        { ...validLocation(), latitude: 10, longitude: 10 },
        { timestamp: future.toISOString() },
      );
      const real = envelope(clockDeviceId, 'location_update', validLocation());
      const relayed = await relay(http, owner.token, clockDeviceId, [
        bogus,
        real,
      ]).expect(202);
      expect(relayed.body.accepted).toBe(2);

      const latest = await request(http)
        .get(`/api/v1/devices/${clockDeviceId}/locations/latest`)
        .set(auth(owner.token))
        .expect(200);
      expect(latest.body.location.latitude).toBeCloseTo(31.2, 3);

      // 摔倒事件不带位置 → 回落最新轨迹点，同样不能取到未来那条
      await relay(http, owner.token, clockDeviceId, [
        envelope(clockDeviceId, 'possible_fall', { confidence: 0.9 }),
      ]).expect(202);
      const sos = await prisma.sosCase.findFirstOrThrow({
        where: { deviceId: clockDeviceId },
      });
      expect(sos.locationSource).toBe('last_point');
      expect(sos.latitude).toBeCloseTo(31.2, 3);
    });
  });

  describe('事件历史分页：并列时间戳', () => {
    it('30 条同一 timestamp 的事件翻 3 页 × 10：无重复无遗漏', async () => {
      const at = new Date();
      await prisma.rawEvent.createMany({
        data: Array.from({ length: 30 }, (_, i) => ({
          eventId: `edge-tie-${run}-${i}`,
          deviceId,
          eventType: 'collision_risk',
          timestamp: at,
          schemaVersion: 1,
          payload: { riskLevel: 'high' },
          source: 'app_relay',
        })),
      });
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const res = await request(http)
          .get(`/api/v1/devices/${deviceId}/events`)
          .query({ type: 'collision_risk', page, pageSize: 10 })
          .set(auth(owner.token))
          .expect(200);
        expect(res.body.total).toBe(30);
        seen.push(
          ...(res.body.items as { eventId: string }[]).map((e) => e.eventId),
        );
      }
      expect(new Set(seen).size).toBe(30);
    });
  });

  describe('Ingest：NUL 误判与孤立代理项', () => {
    it('payload 里的字面量反斜杠 + u0000（不是 NUL 字符）不应被当成 NUL 拒收', async () => {
      const res = await relay(http, owner.token, deviceId, [
        // JS 字符串 '\\u0000' = 反斜杠 u 0 0 0 0 六个可见字符
        envelope(deviceId, 'device_status', { battery: 50, note: 'a\\u0000b' }),
      ]).expect(202);
      expect(res.body).toEqual({ accepted: 1, duplicate: 0, invalid: 0 });
    });

    it('真正的 NUL 字符仍然按 invalid 留档', async () => {
      const res = await relay(http, owner.token, deviceId, [
        envelope(deviceId, 'device_status', { battery: 50, note: 'a\u0000b' }),
      ]).expect(202);
      expect(res.body).toEqual({ accepted: 0, duplicate: 0, invalid: 1 });
    });

    it('payload 含孤立代理项（\\ud800）：不 5xx，且不拖累同批后面的 possible_fall', async () => {
      const fallId = randomUUID();
      const res = await relay(http, owner.token, deviceId, [
        envelope(deviceId, 'device_status', { battery: 50, note: '\ud800' }),
        envelope(
          deviceId,
          'possible_fall',
          { confidence: 0.9 },
          { eventId: fallId },
        ),
      ]);
      expect(res.status).toBe(202);
      expect(res.body.accepted + res.body.invalid).toBe(2);
      expect(
        await prisma.sosCase.count({ where: { triggerEventId: fallId } }),
      ).toBe(1);
    });
  });
});
