// 2026-10-16 边界测试：设置下发 / 回执 / 头盔上报（API.md §8，决策 #36 / #43 / #45）。
// 14 项设置逐项打 min / max / min-1 / max+1 与类型；relay-ack 的字段变体；上报的 32 键上限。
// 测试环境 MQTT 连不上：下发的命令发布失败、留 pending（与线上 Broker 不可达同路径）。
import { INestApplication } from '@nestjs/common';
import { DEVICE_SETTINGS, DEVICE_SETTING_KEYS } from '@helmet/shared';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  histogram,
  provisionDevice,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

describe('边界：设置下发与回执 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let owner: TestUser;
  let other: TestUser;
  const run = Date.now();
  const dev = `edge_cmd_${run}`;
  const devRebind = `edge_cmd_rebind_${run}`;

  const put = (settings: unknown, deviceId = dev, token = owner.token) =>
    request(http)
      .put(`/api/v1/devices/${deviceId}/settings`)
      .set(auth(token))
      .send({ settings });
  const report = (settings: unknown, deviceId = dev) =>
    request(http)
      .post(`/api/v1/devices/${deviceId}/settings/reported`)
      .set(auth(owner.token))
      .send({ settings });
  const ack = (
    commandId: string,
    body: unknown,
    deviceId = dev,
    token = owner.token,
  ) =>
    request(http)
      .post(`/api/v1/devices/${deviceId}/commands/${commandId}/relay-ack`)
      .set(auth(token))
      .send(body as object);
  const commandCount = () =>
    prisma.deviceCommand.count({ where: { deviceId: dev } });

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    owner = await createUser(app, http);
    other = await createUser(app, http);
    for (const d of [dev, devRebind]) {
      await provisionDevice(prisma, d);
      await bindDevice(http, owner.token, d);
    }
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [dev, devRebind]);
    await cleanupUsers(prisma, [owner, other]);
    await app.close();
  });

  describe('PUT settings 逐项边界（决策 #43）', () => {
    it('14 项整数设置的 min / max 接受、min-1 / max+1 拒；布尔项只收 true / false', async () => {
      for (const key of DEVICE_SETTING_KEYS) {
        const spec = DEVICE_SETTINGS[key] as {
          kind: string;
          min?: number;
          max?: number;
        };
        if (spec.kind === 'int') {
          for (const v of [spec.min!, spec.max!]) {
            const r = await put({ [key]: v });
            expect([key, v, r.status]).toEqual([key, v, 202]);
          }
          for (const v of [spec.min! - 1, spec.max! + 1]) {
            const r = await put({ [key]: v });
            expect([key, v, r.status]).toEqual([key, v, 400]);
          }
        } else {
          for (const v of [true, false]) {
            expect((await put({ [key]: v })).status).toBe(202);
          }
          for (const v of [0, 1, 'true', null, 'on']) {
            const r = await put({ [key]: v });
            expect([key, v, r.status]).toEqual([key, v, 400]);
          }
        }
      }
    });

    it('整数项的类型变体：字符串数字 / 小数 / null / 布尔 / NaN 字符串 / Infinity 字符串 / 数组 → 400，且不建命令', async () => {
      const before = await commandCount();
      for (const v of [
        '80',
        80.5,
        null,
        true,
        'NaN',
        'Infinity',
        [80],
        { v: 80 },
      ]) {
        const r = await put({ volume: v });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await commandCount()).toBe(before);
    });

    it('JSON 里写 80.0 / 1e2 就是整数 80 / 100：接受（JSON 层面无法区分，按现状）', async () => {
      const raw = (body: string) =>
        request(http)
          .put(`/api/v1/devices/${dev}/settings`)
          .set(auth(owner.token))
          .set('Content-Type', 'application/json')
          .send(body);
      const r1 = await raw('{"settings":{"volume":80.0}}');
      expect(r1.status).toBe(202);
      const r2 = await raw('{"settings":{"volume":1e2}}');
      expect(r2.status).toBe(202);
      const cmd = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: r2.body.commandId as string },
      });
      expect(cmd.params).toEqual({ volume: 100 });
      // 1e3 超出 1–100
      expect((await raw('{"settings":{"volume":1e3}}')).status).toBe(400);
    });

    it('14 项一次全下：202，命令 params 原样 14 键', async () => {
      const all: Record<string, number | boolean> = {};
      for (const key of DEVICE_SETTING_KEYS) {
        const spec = DEVICE_SETTINGS[key] as { kind: string; min?: number };
        all[key] = spec.kind === 'int' ? spec.min! : true;
      }
      const r = await put(all).expect(202);
      const cmd = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: r.body.commandId as string },
      });
      expect(cmd.params).toEqual(all);
      expect(Object.keys(cmd.params as object)).toHaveLength(14);
    });

    it('一个合法键混一个未知键 / 一个越界：整批 400、一条命令都不建（不做部分下发）', async () => {
      const before = await commandCount();
      for (const settings of [
        { volume: 50, unknownKey: 1 },
        { volume: 50, light: 4 },
        { volume: 50, VOLUME: 50 },
      ]) {
        expect((await put(settings)).status).toBe(400);
      }
      expect(await commandCount()).toBe(before);
    });

    it('settings 不是对象（null / 数组 / 字符串 / 数字）、缺失、空对象 → 400', async () => {
      for (const settings of [
        null,
        [],
        ['volume'],
        'volume=1',
        7,
        undefined,
        {},
      ]) {
        const r = await put(settings);
        expect(r.status).toBe(400);
      }
    });

    it('并发下发 10 次：10 条不同命令；命令历史 10 条；lastCommand 是其中一条', async () => {
      const before = await commandCount();
      const rs = await Promise.all(
        Array.from({ length: 10 }, (_, i) => put({ volume: i + 1 })),
      );
      expect(histogram(rs.map((r) => r.status))).toEqual({ '202': 10 });
      const ids = rs.map((r) => r.body.commandId as string);
      expect(new Set(ids).size).toBe(10);
      expect(await commandCount()).toBe(before + 10);
      const s = await request(http)
        .get(`/api/v1/devices/${dev}/settings`)
        .set(auth(owner.token))
        .expect(200);
      expect(ids).toContain(s.body.lastCommand.commandId);
      // 都没回执：生效设置里不会因为下发就出现 volume（未执行绝不显示成功）
      expect(s.body.settings.volume).toBeUndefined();
    });
  });

  describe('relay-ack 字段变体', () => {
    let commandId: string;
    beforeAll(async () => {
      commandId = (await put({ light: 2 }).expect(202)).body
        .commandId as string;
    });

    it('stage 大小写不同 / 未知、result 非枚举、errorCode 非字符串 → 400；命令状态不动', async () => {
      for (const body of [
        { stage: 'Delivered' },
        { stage: 'acked' },
        { stage: 'executed', result: 'ok' },
        { stage: 'executed', result: 'SUCCESS' },
        { stage: 'executed', result: 'failed', errorCode: 42 },
        {},
      ]) {
        const r = await ack(commandId, body);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('VALIDATION_FAILED');
      }
      const c = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: commandId },
      });
      expect(c.status).toBe('pending');
    });

    it('stage=delivered 带了 result：result 被忽略，只前进到 delivered（按现状）', async () => {
      const r = await ack(commandId, { stage: 'delivered', result: 'success' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ commandId, status: 'delivered' });
      const s = await request(http)
        .get(`/api/v1/devices/${dev}/settings`)
        .set(auth(owner.token))
        .expect(200);
      expect(s.body.settings.light).toBeUndefined();
    });

    it('executedAt 在 2099 年（合法 ISO、在 1970–9999 内）：原样记录，不兜底（API.md §8 只兜底非法 / 越界）；1969 年 → 服务器时间', async () => {
      const r = await ack(commandId, {
        stage: 'executed',
        result: 'success',
        executedAt: '2099-01-01T00:00:00Z',
      });
      expect(r.body.status).toBe('success');
      const c = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: commandId },
      });
      expect(c.executedAt!.toISOString()).toBe('2099-01-01T00:00:00.000Z');

      const c2 = (await put({ light: 1 }).expect(202)).body.commandId as string;
      const before = Date.now();
      await ack(c2, {
        stage: 'executed',
        result: 'success',
        executedAt: '1969-12-31T23:59:59Z',
      }).expect(200);
      const row2 = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: c2 },
      });
      expect(row2.executedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('不存在 / 超长 / 特殊字符的 commandId → 404 NOT_FOUND；别人 → 404 DEVICE_NOT_FOUND', async () => {
      for (const id of ['nope', 'x'.repeat(2000), "1' OR '1'='1"]) {
        const r = await ack(encodeURIComponent(id), { stage: 'delivered' });
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('NOT_FOUND');
      }
      const alien = await ack(
        commandId,
        { stage: 'delivered' },
        dev,
        other.token,
      );
      expect(alien.status).toBe(404);
      expect(alien.body.code).toBe('DEVICE_NOT_FOUND');
    });

    it('换绑后新主人替头盔回执上一位主人的命令：404，设置不生效（与列表 / 详情 / 连接补推同口径只认本人下发的，观察项 12 / 10-17 评审 R4-2）；新主人也查不到这条命令', async () => {
      const old = (await put({ volume: 33 }, devRebind).expect(202)).body
        .commandId as string;
      await request(http)
        .delete(`/api/v1/devices/${devRebind}/binding`)
        .set(auth(owner.token))
        .expect(204);
      await bindDevice(http, other.token, devRebind);
      const r = await ack(
        old,
        { stage: 'executed', result: 'success' },
        devRebind,
        other.token,
      );
      expect(r.status).toBe(404);
      const detail = await request(http)
        .get(`/api/v1/commands/${old}`)
        .set(auth(other.token));
      expect(detail.status).toBe(404);
      // 原主人解绑后：设备路径下的回执 404（不再是他的设备）
      const formerAck = await ack(
        old,
        { stage: 'delivered' },
        devRebind,
        owner.token,
      );
      expect(formerAck.status).toBe(404);
    });
  });

  describe('头盔实际设置上报', () => {
    it('恰好 32 键（14 合法 + 18 未知）→ 200，18 个按 invalid 跳过；33 键 → 400', async () => {
      const settings: Record<string, unknown> = {};
      for (const key of DEVICE_SETTING_KEYS) {
        const spec = DEVICE_SETTINGS[key] as { kind: string; max?: number };
        settings[key] = spec.kind === 'int' ? spec.max! : false;
      }
      for (let i = 0; i < 18; i++) settings[`x${i}`] = i;
      expect(Object.keys(settings)).toHaveLength(32);
      // 先清掉本设备上未完成的命令，免得合法键被「以命令为准」保护
      await prisma.deviceCommand.updateMany({
        where: { deviceId: dev, status: { in: ['pending', 'delivered'] } },
        data: { status: 'offline' },
      });
      const r = await report(settings).expect(200);
      expect(
        r.body.skipped.filter(
          (s: { reason: string }) => s.reason === 'invalid',
        ),
      ).toHaveLength(18);
      // 14 个合法键要么被采纳、要么因 30 s 内刚成功的命令碰过而按 recent_command 跳过（上面 relay-ack 刚让 light 成功）
      const recent = r.body.skipped.filter(
        (s: { reason: string }) => s.reason === 'recent_command',
      );
      expect(r.body.applied.length + recent.length).toBe(14);
      expect(recent.map((s: { key: string }) => s.key)).toEqual(['light']);
      const over = await report({ ...settings, x99: 1 });
      expect(over.status).toBe(400);
    });

    it('值为 null / 字符串数字 / 越界：逐键跳过不整批拒；全是坏值也 200（applied 为空、生效设置不变）', async () => {
      const before = (
        await request(http)
          .get(`/api/v1/devices/${dev}/settings`)
          .set(auth(owner.token))
          .expect(200)
      ).body.settings;
      const r = await report({
        volume: null,
        light: '2',
        radarDistance: 31,
      }).expect(200);
      expect(r.body.applied).toEqual([]);
      expect(r.body.skipped.map((s: { key: string }) => s.key).sort()).toEqual([
        'light',
        'radarDistance',
        'volume',
      ]);
      expect(r.body.settings).toEqual(before);
    });

    it('settings 为数组 / null / 空对象 → 400；别人的设备 → 404', async () => {
      for (const settings of [[], null, {}]) {
        expect((await report(settings)).status).toBe(400);
      }
      const alien = await request(http)
        .post(`/api/v1/devices/${dev}/settings/reported`)
        .set(auth(other.token))
        .send({ settings: { volume: 10 } });
      expect(alien.status).toBe(404);
    });
  });

  describe('命令查询', () => {
    it('GET /commands/{id}：不存在 / 别人的 → 404；命令历史 pageSize=101 → 400、page 超出 → 空', async () => {
      const mine = (await put({ buzzer: true }).expect(202)).body
        .commandId as string;
      expect(
        (
          await request(http)
            .get(`/api/v1/commands/${mine}`)
            .set(auth(other.token))
        ).status,
      ).toBe(404);
      expect(
        (
          await request(http)
            .get('/api/v1/commands/nope')
            .set(auth(owner.token))
        ).status,
      ).toBe(404);
      const base = `/api/v1/devices/${dev}/commands`;
      expect(
        (
          await request(http)
            .get(base)
            .query({ pageSize: 101 })
            .set(auth(owner.token))
        ).status,
      ).toBe(400);
      const beyond = await request(http)
        .get(base)
        .query({ page: 9999 })
        .set(auth(owner.token))
        .expect(200);
      expect(beyond.body.items).toEqual([]);
      expect(beyond.body.total).toBeGreaterThan(0);
    });
  });
});
