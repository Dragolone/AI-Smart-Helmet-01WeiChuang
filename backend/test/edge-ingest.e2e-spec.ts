// 2026-10-16 边界测试：统一 Ingest 的 envelope 校验与幂等（EVENTS.md §1 / §2，API.md §12 / §12.1）。
// 经 app-relay（蓝牙版唯一真机链路）与 webhook 两个入口打；逐字段的类型 / 值域 / 书写变体，
// 跨入口幂等、clock_skew 阈值两侧、批内混合计数。文档没写的按现状断言并注明。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { webhook } from './helpers/audit-ingest';
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
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

const MIN = 60_000;

describe('边界：Ingest envelope 与幂等 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let owner: TestUser;
  const run = Date.now();
  const dev = `edge_ing_${run}`;

  /** 一条最普通的心跳 envelope，overrides 覆盖顶层字段 */
  const status = (overrides: Record<string, unknown> = {}) =>
    envelope(dev, 'device_status', { battery: 50 }, overrides);
  const send = async (e: unknown) =>
    (await relay(http, owner.token, dev, [e]).expect(202)).body as {
      accepted: number;
      duplicate: number;
      invalid: number;
    };
  const ACCEPTED = { accepted: 1, duplicate: 0, invalid: 0 };
  const INVALID = { accepted: 0, duplicate: 0, invalid: 1 };
  const DUPLICATE = { accepted: 0, duplicate: 1, invalid: 0 };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    owner = await createUser(app, http);
    await provisionDevice(prisma, dev);
    await bindDevice(http, owner.token, dev);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [dev]);
    await cleanupUsers(prisma, [owner]);
    await app.close();
  });

  describe('schemaVersion', () => {
    it('1 与 1.0（JSON 里同一个数）接受；0 / 2 / 2147483647（合法 int4 但未知版本）计 invalid、按原 eventId 留档不进业务', async () => {
      expect(await send(status({ schemaVersion: 1 }))).toEqual(ACCEPTED);
      // 原始 JSON 文本里写 1.0：body-parser 解析后就是数字 1
      const one = JSON.stringify(status()).replace(
        '"schemaVersion":1',
        '"schemaVersion":1.0',
      );
      expect(one).toContain('"schemaVersion":1.0');
      const r = await request(http)
        .post('/api/v1/ingest/app-relay')
        .set(auth(owner.token))
        .set('Content-Type', 'application/json')
        .send(`{"deviceId":"${dev}","envelopes":[${one}]}`)
        .expect(202);
      expect(r.body).toEqual(ACCEPTED);
      for (const schemaVersion of [0, 2, 2147483647]) {
        const e = status({ schemaVersion });
        expect(await send(e)).toEqual(INVALID);
        const row = await prisma.rawEvent.findFirstOrThrow({
          where: { deviceId: dev, eventId: e.eventId as string },
        });
        expect(row.eventType).toBe('device_status');
        expect(row.schemaVersion).toBe(schemaVersion);
      }
    });

    it('-1 / 2147483648 / 1.5 / "1" / null / 缺失 → invalid，以 _invalid 占位留档（原 eventId 不被占用）', async () => {
      for (const schemaVersion of [-1, 2147483648, 1.5, '1', null, undefined]) {
        const e = status({ schemaVersion });
        expect(await send(e)).toEqual(INVALID);
        expect(
          await prisma.rawEvent.count({
            where: { deviceId: dev, eventId: e.eventId as string },
          }),
        ).toBe(0);
        // 同一个 eventId 修好后再传：照常接受
        expect(await send({ ...e, schemaVersion: 1 })).toEqual(ACCEPTED);
      }
    });

    it('未知版本的同一事件重传两次：第一次计 invalid、第二次计 duplicate（原来两次都计 invalid，观察项 11），原始表里只有一条（幂等）', async () => {
      const e = status({ schemaVersion: 7 });
      expect(await send(e)).toEqual(INVALID);
      expect(await send(e)).toEqual(DUPLICATE);
      expect(
        await prisma.rawEvent.count({
          where: { deviceId: dev, eventId: e.eventId as string },
        }),
      ).toBe(1);
    });
  });

  describe('eventId / firmwareVersion / payload', () => {
    it('eventId：空串 / 数字 / null / 缺失 → invalid；全空白、emoji、中文都接受（只要求非空字符串，文档写 UUID 但未强制，按现状）', async () => {
      for (const eventId of ['', 123, null, undefined]) {
        expect(await send(status({ eventId }))).toEqual(INVALID);
      }
      for (const eventId of [`   ${run}`, `😀_${run}`, `事件_${run}`]) {
        expect(await send(status({ eventId }))).toEqual(ACCEPTED);
      }
    });

    it('eventId 区分大小写：ABC 与 abc 是两条事件', async () => {
      const id = `CaseId_${run}`;
      expect(await send(status({ eventId: id }))).toEqual(ACCEPTED);
      expect(await send(status({ eventId: id.toLowerCase() }))).toEqual(
        ACCEPTED,
      );
      expect(await send(status({ eventId: id.toUpperCase() }))).toEqual(
        ACCEPTED,
      );
      expect(await send(status({ eventId: id }))).toEqual({
        accepted: 0,
        duplicate: 1,
        invalid: 0,
      });
    });

    it('firmwareVersion：缺失 / 空串 / 数字 / null → invalid（EVENTS.md §1 必填 string）', async () => {
      for (const firmwareVersion of [undefined, '', 103, null]) {
        expect(await send(status({ firmwareVersion }))).toEqual(INVALID);
      }
    });

    it('payload：{} 接受；数组 / null / 字符串 / 数字 / 缺失 → invalid', async () => {
      expect(await send(envelope(dev, 'device_status', {}))).toEqual(ACCEPTED);
      for (const payload of [[1], null, 'x', 0, undefined]) {
        expect(await send(status({ payload }))).toEqual(INVALID);
      }
    });

    it('顶层多余字段被忽略：事件照收，原始表只存 payload', async () => {
      const e = status({
        extra: 'x',
        receivedAt: '2000-01-01T00:00:00Z',
        source: 'mqtt',
      });
      expect(await send(e)).toEqual(ACCEPTED);
      const row = await prisma.rawEvent.findFirstOrThrow({
        where: { deviceId: dev, eventId: e.eventId as string },
      });
      expect(row.source).toBe('app_relay');
      expect(row.receivedAt.getUTCFullYear()).not.toBe(2000);
      expect(row.payload).toEqual({ battery: 50 });
    });

    it('envelope 里的 deviceId 与外层只差大小写 / 多个空格 → invalid（设备只能以自己的身份上报）', async () => {
      for (const deviceId of [dev.toUpperCase(), ` ${dev}`, `${dev} `]) {
        expect(await send(status({ deviceId }))).toEqual(INVALID);
      }
    });
  });

  describe('timestamp 书写变体（EVENTS.md §1：带显式时区、日历合法、年份 ≥ 1970）', () => {
    it('Z / +08:00 / -12:00 / 1–3 位小数秒接受', async () => {
      for (const timestamp of [
        new Date().toISOString(),
        new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        new Date().toISOString().replace(/\.(\d)\d{2}Z$/, '.$1Z'),
        '2026-10-15T11:00:00+08:00',
        '2026-10-14T15:00:00-12:00',
      ]) {
        expect(await send(status({ timestamp }))).toEqual(ACCEPTED);
      }
    });

    it('缺时区 / 小写 t z / 时区不带冒号（+0800）/ 空格代替 T / 只有日期 / 数字时间戳 → invalid；只到分钟（带时区）接受（ISO 8601 允许省略秒，观察项 10）', async () => {
      for (const timestamp of [
        '2026-10-15T03:00:00',
        '2026-10-15t03:00:00z',
        '2026-10-15T03:00:00+0800',
        '2026-10-15 03:00:00Z',
        '2026-10-15T03:00',
        '2026-10-15',
        Date.now(),
      ]) {
        expect(await send(status({ timestamp }))).toEqual(INVALID);
      }
      expect(await send(status({ timestamp: '2026-10-15T03:00Z' }))).toEqual(
        ACCEPTED,
      );
    });

    it('闰秒 23:59:60 / 25 点 / 61 分 / 时区 +24:00 → invalid；24:00:00 被接受为次日零点（Date 可解析，按现状）', async () => {
      for (const timestamp of [
        '2026-10-15T23:59:60Z',
        '2026-10-15T25:00:00Z',
        '2026-10-15T03:61:00Z',
        '2026-10-15T03:00:00+24:00',
      ]) {
        expect(await send(status({ timestamp }))).toEqual(INVALID);
      }
      const midnight = status({ timestamp: '2026-10-14T24:00:00Z' });
      expect(await send(midnight)).toEqual(ACCEPTED);
      const row = await prisma.rawEvent.findFirstOrThrow({
        where: { deviceId: dev, eventId: midnight.eventId as string },
      });
      expect(row.timestamp.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    });

    it('闰年 2 月 29 日接受、平年 2 月 29 日 invalid；1970-01-01T00:00:00Z 接受、1969-12-31T23:59:59Z invalid', async () => {
      expect(await send(status({ timestamp: '2024-02-29T00:00:00Z' }))).toEqual(
        ACCEPTED,
      );
      expect(await send(status({ timestamp: '2026-02-29T00:00:00Z' }))).toEqual(
        INVALID,
      );
      expect(await send(status({ timestamp: '1970-01-01T00:00:00Z' }))).toEqual(
        ACCEPTED,
      );
      expect(await send(status({ timestamp: '1969-12-31T23:59:59Z' }))).toEqual(
        INVALID,
      );
    });

    it('「1970-01-01T00:00:00+01:00」字面年份 1970、换算到 UTC 是 1969 年 23:00Z → invalid（年份按 UTC 判，与「年份 ≥ 1970」同口径；10-17 评审顺带收紧）', async () => {
      const e = status({ timestamp: '1970-01-01T00:00:00+01:00' });
      expect(await send(e)).toEqual(INVALID);
    });
  });

  describe('clock_skew 阈值（DEVICE_PROTOCOL §8：偏差 > 5 分钟）', () => {
    it('超前 / 落后 4 分 50 秒不标；超前 / 落后 5 分 10 秒标 clock_skew', async () => {
      const now = Date.now();
      const cases: Array<[number, boolean]> = [
        [now + 5 * MIN - 10_000, false],
        [now - 5 * MIN + 10_000, false],
        [now + 5 * MIN + 10_000, true],
        [now - 5 * MIN - 10_000, true],
      ];
      const es = cases.map(([at]) =>
        status({ timestamp: new Date(at).toISOString() }),
      );
      const r = await relay(http, owner.token, dev, es).expect(202);
      expect(r.body).toEqual({ accepted: 4, duplicate: 0, invalid: 0 });
      for (let i = 0; i < cases.length; i++) {
        const row = await prisma.rawEvent.findFirstOrThrow({
          where: { deviceId: dev, eventId: es[i].eventId as string },
        });
        expect(row.clockSkew).toBe(cases[i][1]);
      }
    });
  });

  describe('批量与跨入口幂等', () => {
    it('恰好 100 条一批 → 202 全部接受；其中 10 条在批内重复 → duplicate 10', async () => {
      const base = Array.from({ length: 90 }, () => status());
      const batch = [...base, ...base.slice(0, 10)];
      expect(batch).toHaveLength(100);
      const r = await relay(http, owner.token, dev, batch).expect(202);
      expect(r.body).toEqual({ accepted: 90, duplicate: 10, invalid: 0 });
    });

    it('同一批里先来一条坏的、再来同 eventId 的好的：坏的以 _invalid 占位不占号，好的照常接受', async () => {
      const good = status();
      const bad = { ...good, firmwareVersion: '' };
      const r = await relay(http, owner.token, dev, [bad, good]).expect(202);
      expect(r.body).toEqual({ accepted: 1, duplicate: 0, invalid: 1 });
    });

    it('同一 eventId 先经 webhook、再经 app-relay（反之亦然）：后到的一律 duplicate，只存一条', async () => {
      const a = status();
      const w1 = await webhook(http, a).expect(202);
      expect(w1.body).toMatchObject({
        eventId: a.eventId,
        duplicate: false,
        invalid: false,
      });
      expect(await send(a)).toEqual({ accepted: 0, duplicate: 1, invalid: 0 });
      const b = status();
      expect(await send(b)).toEqual(ACCEPTED);
      const w2 = await webhook(http, b).expect(202);
      expect(w2.body).toMatchObject({ duplicate: true, invalid: false });
      expect(
        await prisma.rawEvent.count({
          where: {
            deviceId: dev,
            eventId: { in: [a.eventId as string, b.eventId as string] },
          },
        }),
      ).toBe(2);
    });

    it('webhook 送来蓝牙版范围外的类型（sleep_entered）与未知类型：202 照收留档（webhook 不限 7 种）；app-relay 送同样的计 invalid', async () => {
      for (const t of ['sleep_entered', `unknown_type_${run}`]) {
        const viaWebhook = envelope(dev, t, {});
        const w = await webhook(http, viaWebhook).expect(202);
        expect(w.body).toMatchObject({ duplicate: false, invalid: false });
        expect(
          (
            await prisma.rawEvent.findFirstOrThrow({
              where: { deviceId: dev, eventId: viaWebhook.eventId as string },
            })
          ).eventType,
        ).toBe(t);
        expect(await send(envelope(dev, t, {}))).toEqual(INVALID);
      }
    });

    it('webhook 请求体就是 envelope：缺 deviceId 时回 invalid、eventId 原样回传；eventId 非字符串时回 null', async () => {
      const noDevice: Record<string, unknown> = {
        ...status(),
        deviceId: undefined,
      };
      const r1 = await webhook(http, noDevice).expect(202);
      expect(r1.body).toEqual({
        eventId: noDevice.eventId,
        duplicate: false,
        invalid: true,
      });
      const r2 = await webhook(http, { ...status(), eventId: 42 }).expect(202);
      expect(r2.body).toEqual({
        eventId: null,
        duplicate: false,
        invalid: true,
      });
    });
  });
});
