// 2026-09-13 交付审计 §7：三个接入入口（MQTT 消费路径 / webhook / app-relay）业务等价、
// 坏输入矩阵、部分批次中断、数据库故障的重试语义。不依赖真实 Broker（MQTT 路径直接驱动消费者）。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { Prisma } from '../src/generated/prisma/client';
import { IngestService } from '../src/ingest/ingest.service';
import { MqttConsumerService } from '../src/ingest/mqtt-consumer.service';
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
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  abortedPost,
  collectWs,
  findInvalidByMarker,
  relayRaw,
  waitFor,
  waitOpen,
  webhook,
  webhookRaw,
  wsUrlOf,
} from './helpers/audit-ingest';

jest.setTimeout(180_000);

type ProcessPublish = (topic: string, raw: string) => Promise<void>;

describe('审计 §7：三入口等价 / 坏输入矩阵 / 中断与故障 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let processPublish: ProcessPublish;

  const run = Date.now();
  const deviceId = `audit_ing_${run}`;
  const deviceB = `audit_ingb_${run}`;
  let owner: TestUser;
  const sockets: WebSocket[] = [];

  const mqttIngest = (env: Record<string, unknown>, id = deviceId) =>
    ingest.ingestRaw(JSON.stringify(env), id, 'mqtt');

  const rawByEventId = (eventId: string) =>
    prisma.rawEvent.findFirst({ where: { eventId } });

  beforeAll(async () => {
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    process.env.COMMAND_SCAN_INTERVAL_MS = '600000';
    ({ app, http, prisma } = await buildApp());
    ingest = app.get(IngestService);
    // processPublish 是 private：审计直接驱动消费路径（不依赖真实 Broker），经 unknown 转型访问
    const mqtt = app.get<unknown>(MqttConsumerService) as {
      processPublish: ProcessPublish;
    };
    processPublish = mqtt.processPublish.bind(mqtt);
    owner = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, owner.token, deviceId);
    await provisionDevice(prisma, deviceB);
    await bindDevice(http, owner.token, deviceB);
  });

  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await cleanupDevices(prisma, [deviceId, deviceB]);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  // ————————————————————— 1. 三入口等价 —————————————————————
  describe('三入口业务等价', () => {
    it('collision_risk / location_update / device_status 经三入口：raw source 不同、其余业务效果一致（轨迹、快照、WS、§6 可见）', async () => {
      const ws = new WebSocket(wsUrlOf(app, owner.token));
      sockets.push(ws);
      await waitOpen(ws);
      const risk = collectWs(ws, 'risk_event');
      const loc = collectWs(ws, 'location_update');
      const status = collectWs(ws, 'device_status');

      const riskPayload = {
        riskLevel: 'high',
        objectType: 'vehicle',
        direction: 'rear',
        distance: 12,
        confidence: 0.9,
        algorithmVersion: 'audit-v1',
      };
      const r1 = envelope(deviceId, 'collision_risk', riskPayload);
      const r2 = envelope(deviceId, 'collision_risk', riskPayload);
      const r3 = envelope(deviceId, 'collision_risk', riskPayload);
      const l1 = envelope(deviceId, 'location_update', validLocation(1));
      const l2 = envelope(deviceId, 'location_update', validLocation(2));
      const l3 = envelope(deviceId, 'location_update', validLocation(3));
      const s1 = envelope(deviceId, 'device_status', { battery: 77 });
      const s2 = envelope(deviceId, 'device_status', { battery: 78 });
      const s3 = envelope(deviceId, 'device_status', { battery: 79 });

      // (a) MQTT 消费路径（topic → deviceId）
      await processPublish(`helmet/${deviceId}/event`, JSON.stringify(r1));
      await processPublish(`helmet/${deviceId}/location`, JSON.stringify(l1));
      await processPublish(`helmet/${deviceId}/status`, JSON.stringify(s1));
      // (b) webhook
      for (const e of [r2, l2, s2]) {
        const res = await webhook(http, e).expect(202);
        expect(res.body).toEqual({
          eventId: e.eventId,
          duplicate: false,
          invalid: false,
        });
      }
      // (c) app-relay
      const rr = await relay(http, owner.token, deviceId, [r3, l3, s3]);
      expect(rr.status).toBe(202);
      expect(rr.body).toEqual({ accepted: 3, duplicate: 0, invalid: 0 });

      // raw_events：source 各异，其余一致
      const sources = await Promise.all(
        [r1, r2, r3].map(
          async (e) => (await rawByEventId(e.eventId as string))?.source,
        ),
      );
      expect(sources).toEqual(['mqtt', 'webhook', 'app_relay']);

      // 轨迹表：三条位置均入
      const points = await prisma.locationPoint.findMany({
        where: {
          eventId: { in: [l1, l2, l3].map((e) => e.eventId as string) },
        },
      });
      expect(points).toHaveLength(3);

      // 快照：最后一条 device_status 的电量生效（顺序 s1→s2→s3）
      const device = await prisma.device.findUniqueOrThrow({
        where: { deviceId },
      });
      expect(device.battery).toBe(79);
      expect(device.lastSeenAt).not.toBeNull();

      // WS：三条 risk_event / 三条 location / 三条 device_status
      await waitFor(
        () =>
          risk.messages.length >= 3 &&
          loc.messages.length >= 3 &&
          status.messages.length >= 3,
      );
      const riskIds = risk.messages.map(
        (m) => (m.data as { eventId: string }).eventId,
      );
      expect(riskIds.sort()).toEqual(
        [r1, r2, r3].map((e) => e.eventId as string).sort(),
      );

      // §6 事件查询：三条 collision_risk 都可见（source 对 App 不可见）
      const list = await request(http)
        .get(`/api/v1/devices/${deviceId}/events?type=collision_risk`)
        .set(auth(owner.token))
        .expect(200);
      const listed = (list.body.items as Array<{ eventId: string }>).map(
        (i) => i.eventId,
      );
      for (const e of [r1, r2, r3]) expect(listed).toContain(e.eventId);
      ws.close();
    });

    it('跨入口重放同 eventId 只存一次；possible_fall 跨入口重放只建一单 SOS', async () => {
      const fall = envelope(deviceId, 'possible_fall', {
        confidence: 0.9,
        algorithmVersion: 'audit',
        location: {
          latitude: 31.2,
          longitude: 121.5,
          coordinateSystem: 'wgs84',
          accuracy: 8,
        },
      });
      expect(await mqttIngest(fall)).toBe('stored');
      const w = await webhook(http, fall).expect(202);
      expect(w.body.duplicate).toBe(true);
      const r = await relay(http, owner.token, deviceId, [fall, fall]);
      expect(r.body).toEqual({ accepted: 0, duplicate: 2, invalid: 0 });
      // 再重放一遍 MQTT 路径
      expect(await mqttIngest(fall)).toBe('duplicate');

      const rows = await prisma.rawEvent.count({
        where: { eventId: fall.eventId as string },
      });
      expect(rows).toBe(1);
      const cases = await prisma.sosCase.findMany({
        where: { deviceId, triggerEventId: fall.eventId as string },
      });
      expect(cases).toHaveLength(1);
      expect(cases[0].status).toBe('pending');
      // 收尾：取消这单，避免影响后面的 SOS 计数
      await prisma.sosCase.update({
        where: { id: cases[0].id },
        data: { status: 'cancelled' },
      });
    });

    it('MQTT topic 解析：topic 设备与 envelope 不一致 → device_id_mismatch_with_topic 留档到 topic 设备；未识别 topic 忽略不落库', async () => {
      const e = envelope(deviceId, 'device_status', { battery: 50 });
      // envelope 声称 deviceId，topic 却是 deviceB → 按 topic 设备留档为 invalid
      await processPublish(`helmet/${deviceB}/status`, JSON.stringify(e));
      expect(await rawByEventId(e.eventId as string)).toBeNull();
      const inv = await findInvalidByMarker(
        prisma,
        deviceB,
        e.eventId as string,
      );
      expect(inv?.reason).toBe('device_id_mismatch_with_topic');
      expect(inv?.source).toBe('mqtt');

      const e2 = envelope(deviceId, 'device_status', { battery: 51 });
      await processPublish(
        `helmet/${deviceId}/unknown_suffix`,
        JSON.stringify(e2),
      );
      await processPublish(`other/${deviceId}/status`, JSON.stringify(e2));
      expect(await rawByEventId(e2.eventId as string)).toBeNull();
      expect(
        await findInvalidByMarker(prisma, deviceId, e2.eventId as string),
      ).toBeNull();
    });
  });

  // ————————————————————— 2. 坏输入矩阵 —————————————————————
  interface BadCase {
    name: string;
    make: (marker: string) => Record<string, unknown>;
    /** 预期：留档为 _invalid 的 reason；'stored' = 合法入库；对 app-relay 可单独给 */
    expect: string;
    expectRelay?: string;
    /** webhook 没有"外层来源"（API.md §12：请求体即 envelope），deviceId 不可能不一致——可单独给 */
    expectWebhook?: string;
  }

  const location = (over: Record<string, unknown>) => ({
    ...validLocation(0),
    ...over,
  });

  const matrix: BadCase[] = [
    {
      name: 'schemaVersion=2（Contract：未知版本不进业务流程）',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          { battery: 60 },
          { eventId: m, schemaVersion: 2 },
        ),
      // 修复 INGEST-01 后：按原 eventId 留档（可回放）但计入 invalid、不分发
      expect: 'stored_quarantined',
    },
    {
      name: 'schemaVersion=-1',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, schemaVersion: -1 },
        ),
      expect: 'schema_version_out_of_range',
    },
    {
      name: 'schemaVersion=2147483648（旧报告 #1 复验：int32 越界）',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, schemaVersion: 2147483648 },
        ),
      expect: 'schema_version_out_of_range',
    },
    {
      name: 'schemaVersion=1e18（旧报告 #1 复验）',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, schemaVersion: 1e18 },
        ),
      expect: 'schema_version_out_of_range',
    },
    {
      name: 'schemaVersion=1.5',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, schemaVersion: 1.5 },
        ),
      expect: 'schema_version_missing_or_not_integer',
    },
    {
      name: 'schemaVersion="1"',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, schemaVersion: '1' },
        ),
      expect: 'schema_version_missing_or_not_integer',
    },
    {
      name: '缺 eventType',
      make: (m) => {
        const e = envelope(deviceId, 'device_status', {}, { eventId: m });
        delete e.eventType;
        return e;
      },
      expect: 'event_type_missing',
    },
    {
      name: '缺 firmwareVersion',
      make: (m) => {
        const e = envelope(deviceId, 'device_status', {}, { eventId: m });
        delete e.firmwareVersion;
        return e;
      },
      expect: 'firmware_version_missing',
    },
    {
      name: '未知 eventType（totally_unknown_event）',
      make: (m) =>
        envelope(deviceId, 'totally_unknown_event', { x: 1 }, { eventId: m }),
      expect: 'stored',
      expectRelay: 'event_type_not_allowed',
    },
    {
      name: 'coordinateSystem 非法（bd09）',
      make: (m) =>
        envelope(
          deviceId,
          'location_update',
          location({ coordinateSystem: 'bd09' }),
          { eventId: m },
        ),
      expect: 'stored',
    },
    {
      name: 'riskLevel 非法（extreme）',
      make: (m) =>
        envelope(
          deviceId,
          'collision_risk',
          { riskLevel: 'extreme', direction: 'rear' },
          { eventId: m },
        ),
      expect: 'stored',
    },
    {
      name: 'latitude=1e308',
      make: (m) =>
        envelope(deviceId, 'location_update', location({ latitude: 1e308 }), {
          eventId: m,
        }),
      expect: 'stored',
    },
    {
      name: 'latitude=-0（合法）',
      make: (m) =>
        envelope(deviceId, 'location_update', location({ latitude: -0 }), {
          eventId: m,
        }),
      expect: 'stored',
    },
    {
      name: 'latitude="NaN" 字符串',
      make: (m) =>
        envelope(deviceId, 'location_update', location({ latitude: 'NaN' }), {
          eventId: m,
        }),
      expect: 'stored',
    },
    {
      name: 'latitude=91 / longitude=-181',
      make: (m) =>
        envelope(
          deviceId,
          'location_update',
          location({ latitude: 91, longitude: -181 }),
          { eventId: m },
        ),
      expect: 'stored',
    },
    {
      name: 'latitude="31.2" 字符串数字',
      make: (m) =>
        envelope(deviceId, 'location_update', location({ latitude: '31.2' }), {
          eventId: m,
        }),
      expect: 'stored',
    },
    {
      name: 'timestamp 02-30',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, timestamp: '2026-02-30T00:00:00Z' },
        ),
      expect: 'timestamp_out_of_range',
    },
    {
      name: 'timestamp 13 月',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, timestamp: '2026-13-01T00:00:00Z' },
        ),
      expect: 'timestamp_out_of_range',
    },
    {
      name: 'timestamp 年份 0000',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, timestamp: '0000-01-01T00:00:00Z' },
        ),
      expect: 'timestamp_out_of_range',
    },
    {
      name: 'timestamp 年份 9999（合法但 clock_skew）',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, timestamp: '9999-12-31T23:59:59Z' },
        ),
      expect: 'stored',
    },
    {
      name: 'timestamp 缺时区',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, timestamp: '2026-09-13T00:00:00' },
        ),
      expect: 'timestamp_not_iso8601_with_timezone',
    },
    {
      name: 'timestamp 时区 +25:00',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, timestamp: '2026-09-13T00:00:00+25:00' },
        ),
      expect: 'timestamp_unparseable',
    },
    {
      name: 'timestamp 为数字',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, timestamp: 1757721600000 },
        ),
      expect: 'timestamp_missing',
    },
    {
      name: 'payload 为数组',
      make: (m) =>
        envelope(
          deviceId,
          'device_status',
          {},
          { eventId: m, payload: [1, 2] },
        ),
      expect: 'payload_missing_or_not_object',
    },
    {
      name: '缺 payload',
      make: (m) => {
        const e = envelope(deviceId, 'device_status', {}, { eventId: m });
        delete e.payload;
        return e;
      },
      expect: 'payload_missing_or_not_object',
    },
    {
      name: '内层 deviceId 与外层/topic 不一致',
      make: (m) => envelope(deviceB, 'device_status', {}, { eventId: m }),
      expect: 'device_id_mismatch_with_topic',
      // BY_DESIGN：webhook 的 topicDeviceId 取自 body 本身，deviceB 是合法设备 → 正常入库
      expectWebhook: 'stored',
    },
    {
      name: 'eventId 含 \\u0000',
      make: (m) => envelope(deviceId, 'device_status', {}, { eventId: `${m} ` }),
      expect: 'contains_nul_character',
    },
    {
      name: 'payload 键名含 \\u0000',
      make: (m) =>
        envelope(deviceId, 'device_status', { ['a b']: 1 }, { eventId: m }),
      expect: 'contains_nul_character',
    },
    {
      name: 'payload 1000 层嵌套',
      make: (m) => {
        let nested: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 1000; i += 1) nested = { n: nested };
        return envelope(deviceId, 'collision_risk', nested, { eventId: m });
      },
      expect: 'stored',
    },
  ];

  const expectOutcome = async (
    c: BadCase,
    marker: string,
    expected: string,
    source: string,
  ): Promise<void> => {
    const stored = await rawByEventId(marker);
    const inv = await findInvalidByMarker(prisma, deviceId, marker);
    if (expected === 'stored' || expected === 'stored_quarantined') {
      // stored_quarantined：结构合法但版本未知——按原 eventId/eventType 留档，只是不进业务流程
      expect({
        name: c.name,
        source,
        stored: stored?.eventType ?? null,
      }).toEqual({
        name: c.name,
        source,
        stored: (c.make(marker).eventType as string) ?? null,
      });
      expect(stored?.source).toBe(source);
    } else {
      expect({
        name: c.name,
        source,
        stored: stored ?? null,
        reason: inv?.reason ?? null,
      }).toEqual({
        name: c.name,
        source,
        stored: null,
        reason: expected,
      });
    }
  };

  describe('坏输入矩阵（三入口）', () => {
    it('app-relay：每条按预期留档/入库，接口 202 不 5xx', async () => {
      const markers = matrix.map(() => `relay_${randomUUID()}`);
      const envelopes = matrix.map((c, i) => c.make(markers[i]));
      const res = await relay(http, owner.token, deviceId, envelopes);
      expect(res.status).toBe(202);
      const expectedInvalid = matrix.filter(
        (c) => (c.expectRelay ?? c.expect) !== 'stored',
      ).length;
      expect(res.body).toEqual({
        accepted: matrix.length - expectedInvalid,
        duplicate: 0,
        invalid: expectedInvalid,
      });
      for (let i = 0; i < matrix.length; i += 1) {
        // NUL 用例：marker 后带 NUL，raw 里以   转义出现，用 marker 前缀即可命中
        await expectOutcome(
          matrix[i],
          markers[i],
          matrix[i].expectRelay ?? matrix[i].expect,
          'app_relay',
        );
      }
    });

    it('webhook：每条按预期留档/入库，全部 202；invalid 标志与留档一致', async () => {
      for (const c of matrix) {
        const marker = `wh_${randomUUID()}`;
        const env = c.make(marker);
        const res = await webhook(http, env);
        const expected = c.expectWebhook ?? c.expect;
        expect({
          name: c.name,
          status: res.status,
          invalid: res.body.invalid,
        }).toEqual({
          name: c.name,
          status: 202,
          invalid: expected !== 'stored',
        });
        await expectOutcome(c, marker, expected, 'webhook');
      }
    });

    it('MQTT 消费路径：每条按预期留档/入库，processPublish 不抛', async () => {
      for (const c of matrix) {
        const marker = `mq_${randomUUID()}`;
        const env = c.make(marker);
        const topic =
          env.eventType === 'location_update'
            ? `helmet/${deviceId}/location`
            : `helmet/${deviceId}/event`;
        await expect(
          processPublish(topic, JSON.stringify(env)),
        ).resolves.toBeUndefined();
        await expectOutcome(c, marker, c.expect, 'mqtt');
      }
    });

    it('矩阵中"入库但不进业务"的用例：坏坐标不进轨迹表、9999 年标 clock_skew、-0 入轨迹表', async () => {
      const bad = [
        location({ coordinateSystem: 'bd09' }),
        location({ latitude: 1e308 }),
        location({ latitude: 'NaN' }),
        location({ latitude: 91, longitude: -181 }),
        location({ latitude: '31.2' }),
      ].map((p) => envelope(deviceId, 'location_update', p));
      const good = envelope(
        deviceId,
        'location_update',
        location({ latitude: -0 }),
      );
      const skew = envelope(
        deviceId,
        'device_status',
        {},
        { timestamp: '9999-12-31T23:59:59Z' },
      );
      const skewPast = envelope(
        deviceId,
        'device_status',
        {},
        {
          timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
        },
      );
      const fine = envelope(
        deviceId,
        'device_status',
        {},
        {
          timestamp: new Date(Date.now() - 4 * 60_000).toISOString(),
        },
      );
      const res = await relay(http, owner.token, deviceId, [
        ...bad,
        good,
        skew,
        skewPast,
        fine,
      ]);
      expect(res.body).toEqual({
        accepted: bad.length + 4,
        duplicate: 0,
        invalid: 0,
      });
      const badPoints = await prisma.locationPoint.count({
        where: { eventId: { in: bad.map((e) => e.eventId as string) } },
      });
      expect(badPoints).toBe(0);
      const goodPoint = await prisma.locationPoint.findFirst({
        where: { eventId: good.eventId as string },
      });
      expect(goodPoint?.latitude).toBe(0);
      expect((await rawByEventId(skew.eventId as string))?.clockSkew).toBe(
        true,
      );
      expect((await rawByEventId(skewPast.eventId as string))?.clockSkew).toBe(
        true,
      );
      expect((await rawByEventId(fine.eventId as string))?.clockSkew).toBe(
        false,
      );
    });

    it('HTTP 层坏体（app-relay / webhook）：非法 JSON 400、原始 NUL 字节 400、>100KB 413、text/plain 走留档', async () => {
      const badJson = '{"deviceId": "x", "envelopes": [';
      let r = await relayRaw(http, owner.token, badJson);
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      r = await webhookRaw(http, badJson);
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);

      // 原始 0x00 字节夹在 JSON 字符串里 = 非法 JSON
      const nulRaw =
        `{"deviceId":"${deviceId}","envelopes":[{"eventId":"a` +
        String.fromCharCode(0) +
        'b"}]}';
      r = await relayRaw(http, owner.token, nulRaw);
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      r = await webhookRaw(http, nulRaw);
      expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);

      const huge = JSON.stringify(
        envelope(deviceId, 'device_status', { blob: 'x'.repeat(120_000) }),
      );
      r = await webhookRaw(http, huge);
      expect([r.status, r.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
      r = await relayRaw(
        http,
        owner.token,
        JSON.stringify({ deviceId, envelopes: [JSON.parse(huge)] }),
      );
      expect([r.status, r.body.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    });

    // 【INGEST-02 缺陷断言】API.md §12：webhook 校验失败"留档不报错"、返回 202 invalid:true，
    // 算法服务侧无需实现重试/错误分支。Express 5 下未解析的 body 为 undefined，
    // JSON.stringify(undefined) → validateEnvelope(undefined) → Buffer.byteLength 抛 TypeError → 500。
    it('【INGEST-02 缺陷断言】webhook 非 JSON Content-Type / 空请求体：应 202 invalid 留档（deviceId=unknown），不得 500', async () => {
      const before = await prisma.rawEvent.count({
        where: { deviceId: 'unknown', eventType: '_invalid' },
      });
      const r1 = await webhookRaw(http, '{"deviceId":"x"}', 'text/plain');
      const r2 = await request(http)
        .post('/api/v1/ingest/webhook')
        .set('X-Api-Key', process.env.INGEST_WEBHOOK_API_KEY as string)
        .set('Content-Type', 'application/json')
        .send('');
      const after = await prisma.rawEvent.count({
        where: { deviceId: 'unknown', eventType: '_invalid' },
      });
      // 清理我们造出的 unknown 留档（若有）
      const mine = await prisma.rawEvent.findMany({
        where: { deviceId: 'unknown', eventType: '_invalid' },
        orderBy: { receivedAt: 'desc' },
        take: after - before,
        select: { id: true },
      });
      if (mine.length > 0) {
        await prisma.rawEvent.deleteMany({
          where: { id: { in: mine.map((m) => m.id) } },
        });
      }
      expect({
        textPlain: [r1.status, r1.body.code ?? r1.body.invalid],
        emptyBody: [r2.status, r2.body.code ?? r2.body.invalid],
      }).toEqual({
        textPlain: [202, true],
        emptyBody: [202, true],
      });
      expect(after).toBe(before + 2);
    });

    it('MQTT 路径原始字节：非法 JSON → invalid_json；>64KB → payload_too_large（raw 截断 4096）', async () => {
      const m1 = `mqraw_${randomUUID()}`;
      await processPublish(`helmet/${deviceId}/event`, `{"eventId":"${m1}",`);
      expect((await findInvalidByMarker(prisma, deviceId, m1))?.reason).toBe(
        'invalid_json',
      );

      const m3 = `mqbig_${randomUUID()}`;
      const big = JSON.stringify(
        envelope(
          deviceId,
          'collision_risk',
          { blob: 'x'.repeat(70_000) },
          { eventId: m3 },
        ),
      );
      await processPublish(`helmet/${deviceId}/event`, big);
      const inv = await findInvalidByMarker(prisma, deviceId, m3);
      expect(inv?.reason).toBe('payload_too_large');
      expect(inv?.raw.length).toBeLessThanOrEqual(4096);
    });

    // CLAUDE.md Event Rules：校验失败的事件必须留档不丢弃。固件用 C 字符串常见的尾随 0x00、
    // 或字符串内的原始 NUL 字节都属"非法 JSON"，应以 invalid_json 留档。
    // 【INGEST-03 缺陷断言】CLAUDE.md Event Rules / EVENTS.md §2：校验失败的事件必须留档不丢弃。
    // 原始 0x00 字节让 JSON.parse 失败（invalid_json）后，替身记录 payload.raw 仍含 0x00，
    // PostgreSQL jsonb 拒绝（22P05）→ persist 抛错 → MQTT 消费者重试 3 次后放弃，该消息既不留档也不告警到 _invalid。
    it('【INGEST-03 缺陷断言】MQTT 路径原始 NUL 字节（字符串内 / 尾随）：必须以 invalid_json 留档，不得抛错丢消息', async () => {
      const m2 = `mqnul_${randomUUID()}`;
      const inString = `{"eventId":"${m2}` + String.fromCharCode(0) + '"}';
      await expect(
        processPublish(`helmet/${deviceId}/event`, inString),
      ).resolves.toBeUndefined();
      expect((await findInvalidByMarker(prisma, deviceId, m2))?.reason).toBe(
        'invalid_json',
      );

      const m4 = `mqnul_trail_${randomUUID()}`;
      const trailing =
        JSON.stringify(
          envelope(deviceId, 'device_status', { battery: 9 }, { eventId: m4 }),
        ) + String.fromCharCode(0);
      await expect(
        processPublish(`helmet/${deviceId}/status`, trailing),
      ).resolves.toBeUndefined();
      expect((await findInvalidByMarker(prisma, deviceId, m4))?.reason).toBe(
        'invalid_json',
      );
    });
  });

  // ————————————————————— 2b. 未知 schemaVersion 与旧报告复验 —————————————————————
  describe('未知 schemaVersion 与旧报告（2026-09-10）复验', () => {
    // 【INGEST-01 缺陷断言】EVENTS.md §1 schemaVersion："当前固定 1；未知版本进原始事件表并告警，不进业务流程"。
    // 当前 validateEnvelope 只校验整数与 int32 范围，schemaVersion=999 的 possible_fall 照常建 SOS、
    // device_status 照常刷新快照——未来升版本（字段语义变更）时旧后端会用错误语义处理新事件。
    it('【INGEST-01 缺陷断言】schemaVersion=999：原始表留档，但不建 SOS、不刷快照、不进轨迹表', async () => {
      const fall = envelope(
        deviceId,
        'possible_fall',
        {
          confidence: 0.9,
          algorithmVersion: 'audit',
          location: {
            latitude: 31.2,
            longitude: 121.5,
            coordinateSystem: 'wgs84',
            accuracy: 8,
          },
        },
        { schemaVersion: 999 },
      );
      const status = envelope(
        deviceId,
        'device_status',
        { battery: 42 },
        { schemaVersion: 999 },
      );
      const loc = envelope(deviceId, 'location_update', validLocation(9), {
        schemaVersion: 999,
      });
      const before = await prisma.device.findUniqueOrThrow({
        where: { deviceId },
        select: { battery: true },
      });
      const res = await relay(http, owner.token, deviceId, [fall, status, loc]);
      expect(res.status).toBe(202);
      // 原始表必须留档（三条都在，不丢）
      const raws = await prisma.rawEvent.findMany({
        where: {
          eventId: { in: [fall, status, loc].map((e) => e.eventId as string) },
        },
        select: { schemaVersion: true },
      });
      expect(raws).toHaveLength(3);
      const cases = await prisma.sosCase.findMany({
        where: { deviceId, triggerEventId: fall.eventId as string },
      });
      const point = await prisma.locationPoint.findFirst({
        where: { eventId: loc.eventId as string },
      });
      const after = await prisma.device.findUniqueOrThrow({
        where: { deviceId },
        select: { battery: true },
      });
      // 无论断言结果如何先收尾，避免 pending 单影响后续用例
      if (cases.length > 0) {
        await prisma.sosCase.updateMany({
          where: { id: { in: cases.map((c) => c.id) } },
          data: { status: 'cancelled' },
        });
      }
      expect({
        sosCreated: cases.length,
        pointRecorded: point !== null,
        batteryChanged: after.battery !== before.battery,
      }).toEqual({
        sosCreated: 0,
        pointRecorded: false,
        batteryChanged: false,
      });
    });

    it('旧报告 #2 复验：device_status battery/signalLevel=1e12 → 字段丢弃但 lastSeenAt 必刷新，接口不 5xx', async () => {
      const t0 = new Date();
      const e = envelope(deviceId, 'device_status', {
        battery: 1e12,
        signalLevel: 1e12,
        charging: true,
      });
      const res = await relay(http, owner.token, deviceId, [e]);
      expect(res.body).toEqual({ accepted: 1, duplicate: 0, invalid: 0 });
      const d = await prisma.device.findUniqueOrThrow({ where: { deviceId } });
      expect(d.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(t0.getTime() - 5);
      expect(d.battery === null || (d.battery >= 0 && d.battery <= 100)).toBe(
        true,
      );
    });

    it('旧报告 #3 复验：video_ready sizeBytes=3e9（>int4）→ 媒体表落库 BigInt，不静默丢失', async () => {
      const e = envelope(deviceId, 'video_ready', {
        videoId: `audit_video_${randomUUID()}`,
        sizeBytes: 3_000_000_000,
        duration: 60,
      });
      const w = await webhook(http, e).expect(202);
      expect(w.body.invalid).toBe(false);
      const media = await prisma.media.findFirst({
        where: { deviceId, eventId: e.eventId as string },
      });
      expect(media).not.toBeNull();
      expect(media!.sizeBytes).toBe(BigInt(3_000_000_000));
    });
  });

  // ————————————————————— 3. 部分批次中断 / 数据库故障 —————————————————————
  describe('部分批次中断与数据库故障', () => {
    it('app-relay 100 条：请求体发完后客户端立刻断开 → 服务端继续处理完 100 条；整批补传全 duplicate；possible_fall 只一单', async () => {
      const batch: Record<string, unknown>[] = [];
      for (let i = 0; i < 100; i += 1) {
        batch.push(
          i === 50
            ? envelope(deviceId, 'possible_fall', {
                confidence: 0.8,
                algorithmVersion: 'audit',
                location: {
                  latitude: 31.2,
                  longitude: 121.5,
                  coordinateSystem: 'wgs84',
                  accuracy: 5,
                },
              })
            : envelope(deviceId, 'location_update', validLocation(i)),
        );
      }
      const ids = batch.map((e) => e.eventId as string);
      const body = JSON.stringify({ deviceId, envelopes: batch });
      await abortedPost(
        app,
        '/api/v1/ingest/app-relay',
        { Authorization: `Bearer ${owner.token}` },
        body,
        body.length,
        5,
      );
      // 服务端不感知客户端断开，应把 100 条处理完
      await waitFor(
        async () =>
          (await prisma.rawEvent.count({ where: { eventId: { in: ids } } })) ===
          100,
        20_000,
        100,
      );
      const replay = await relay(http, owner.token, deviceId, batch);
      expect(replay.body).toEqual({ accepted: 0, duplicate: 100, invalid: 0 });
      expect(
        await prisma.locationPoint.count({ where: { eventId: { in: ids } } }),
      ).toBe(99);
      const cases = await prisma.sosCase.findMany({
        where: { deviceId, triggerEventId: ids[50] },
      });
      expect(cases).toHaveLength(1);
      await prisma.sosCase.update({
        where: { id: cases[0].id },
        data: { status: 'cancelled' },
      });
    });

    it('app-relay 100 条：请求体只发一半就断开 → 服务端不处理任何一条；补传 → 全部 accepted', async () => {
      const batch = Array.from({ length: 100 }, (_, i) =>
        envelope(deviceId, 'location_update', validLocation(200 + i)),
      );
      const ids = batch.map((e) => e.eventId as string);
      const body = JSON.stringify({ deviceId, envelopes: batch });
      await abortedPost(
        app,
        '/api/v1/ingest/app-relay',
        { Authorization: `Bearer ${owner.token}` },
        body,
        Math.floor(body.length / 2),
        50,
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(
        await prisma.rawEvent.count({ where: { eventId: { in: ids } } }),
      ).toBe(0);
      const replay = await relay(http, owner.token, deviceId, batch);
      expect(replay.body).toEqual({ accepted: 100, duplicate: 0, invalid: 0 });
    });

    const connectionError = () =>
      new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
        code: 'P1001',
        clientVersion: 'audit',
      });
    const dataError = () =>
      new Prisma.PrismaClientKnownRequestError('value too long for column', {
        code: 'P2000',
        clientVersion: 'audit',
      });

    it('数据库连接类故障（P1001）：app-relay 与 webhook 返回 5xx（便于重传），不留档、不静默', async () => {
      const spy = jest.spyOn(prisma.rawEvent, 'create');
      try {
        spy.mockRejectedValueOnce(connectionError());
        const e1 = envelope(deviceId, 'location_update', validLocation(300));
        const r1 = await relay(http, owner.token, deviceId, [e1]);
        expect(r1.status).toBeGreaterThanOrEqual(500);
        expect(r1.body.code).toBe('INTERNAL_ERROR');
        expect(await rawByEventId(e1.eventId as string)).toBeNull();
        // 重传（连接恢复）→ 正常入库
        const r1b = await relay(http, owner.token, deviceId, [e1]);
        expect(r1b.body).toEqual({ accepted: 1, duplicate: 0, invalid: 0 });

        spy.mockRejectedValueOnce(connectionError());
        const e2 = envelope(deviceId, 'device_status', { battery: 1 });
        const r2 = await webhook(http, e2);
        expect(r2.status).toBeGreaterThanOrEqual(500);
        expect(await rawByEventId(e2.eventId as string)).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('MQTT 路径：连接类故障重试 2 次（共 3 次尝试）后成功 → stored；连续 3 次失败 → 抛出（消息放弃，日志告警）', async () => {
      const spy = jest.spyOn(prisma.rawEvent, 'create');
      try {
        spy
          .mockRejectedValueOnce(connectionError())
          .mockRejectedValueOnce(connectionError());
        const e1 = envelope(deviceId, 'device_status', { battery: 2 });
        const t0 = Date.now();
        await expect(
          processPublish(`helmet/${deviceId}/status`, JSON.stringify(e1)),
        ).resolves.toBeUndefined();
        expect(Date.now() - t0).toBeGreaterThanOrEqual(550); // 2 × 300ms 退避
        expect((await rawByEventId(e1.eventId as string))?.source).toBe('mqtt');

        spy
          .mockRejectedValueOnce(connectionError())
          .mockRejectedValueOnce(connectionError())
          .mockRejectedValueOnce(connectionError());
        const e2 = envelope(deviceId, 'device_status', { battery: 3 });
        await expect(
          processPublish(`helmet/${deviceId}/status`, JSON.stringify(e2)),
        ).rejects.toMatchObject({ code: 'P1001' });
        expect(await rawByEventId(e2.eventId as string)).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('数据类拒绝（P2000）：三入口都降级为 _invalid 留档 reason=db_rejected_P2000，接口不 5xx', async () => {
      const spy = jest.spyOn(prisma.rawEvent, 'create');
      try {
        spy.mockRejectedValueOnce(dataError());
        const e1 = envelope(deviceId, 'device_status', { battery: 4 });
        const r1 = await relay(http, owner.token, deviceId, [e1]);
        expect(r1.body).toEqual({ accepted: 0, duplicate: 0, invalid: 1 });
        expect(
          (await findInvalidByMarker(prisma, deviceId, e1.eventId as string))
            ?.reason,
        ).toBe('db_rejected_P2000');

        spy.mockRejectedValueOnce(dataError());
        const e2 = envelope(deviceId, 'device_status', { battery: 5 });
        const r2 = await webhook(http, e2).expect(202);
        expect(r2.body.invalid).toBe(true);
        expect(
          (await findInvalidByMarker(prisma, deviceId, e2.eventId as string))
            ?.reason,
        ).toBe('db_rejected_P2000');

        spy.mockRejectedValueOnce(dataError());
        const e3 = envelope(deviceId, 'device_status', { battery: 6 });
        await processPublish(`helmet/${deviceId}/status`, JSON.stringify(e3));
        expect(
          (await findInvalidByMarker(prisma, deviceId, e3.eventId as string))
            ?.reason,
        ).toBe('db_rejected_P2000');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
