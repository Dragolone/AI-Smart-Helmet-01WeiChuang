// 2026-09-13 交付审计 §7：设备命令状态机（API.md §8 / DEVICE_PROTOCOL §7 / 决策 #27④ #36）。
// MQTT 由 stub 替代（publishCommand resolve = PUBACK、reject = 发布失败），超时扫描手动 tick，
// 回执两条路径：MQTT cmd_ack（直接调 CommandsService.handleAck）与 relay-ack（HTTP）。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { CommandsSchedulerService } from '../src/commands/commands-scheduler.service';
import { CommandsService } from '../src/commands/commands.service';
import { MqttConsumerService } from '../src/ingest/mqtt-consumer.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  provisionDevice,
  sleep,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

describe('审计 §7：命令与回执状态机 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let commands: CommandsService;
  let scheduler: CommandsSchedulerService;

  const run = Date.now();
  const deviceId = `audit_cmd_${run}`;
  const deviceB = `audit_cmdb_${run}`;
  let owner: TestUser;
  let other: TestUser;

  const publishCommand = jest.fn<Promise<void>, [string, string]>();
  const mqttStub = {
    publishCommand,
    setCmdAckHandler: jest.fn(),
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
  };

  const put = async (
    settings: Record<string, unknown>,
    token = owner.token,
    dev = deviceId,
  ) => {
    const res = await request(http)
      .put(`/api/v1/devices/${dev}/settings`)
      .set(auth(token))
      .send({ settings });
    return res;
  };
  const issue = async (settings: Record<string, unknown>): Promise<string> => {
    const res = await put(settings);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending');
    return res.body.commandId as string;
  };
  const db = (id: string) =>
    prisma.deviceCommand.findUniqueOrThrow({ where: { id } });
  const settingsOf = async (dev = deviceId) =>
    ((await prisma.device.findUniqueOrThrow({ where: { deviceId: dev } }))
      .settings ?? {}) as Record<string, unknown>;
  const mqttAck = (
    id: string,
    result: 'success' | 'failed',
    extra: Record<string, unknown> = {},
    dev = deviceId,
  ) =>
    commands.handleAck(
      dev,
      JSON.stringify({
        commandId: id,
        result,
        executedAt: new Date().toISOString(),
        ...extra,
      }),
    );
  const relayAck = (
    id: string,
    body: Record<string, unknown>,
    token = owner.token,
    dev = deviceId,
  ) =>
    request(http)
      .post(`/api/v1/devices/${dev}/commands/${id}/relay-ack`)
      .set(auth(token))
      .send(body);
  const waitTimeout = () => sleep(1100);

  beforeAll(async () => {
    process.env.COMMAND_ACK_TIMEOUT_SECONDS = '1';
    process.env.COMMAND_SCAN_INTERVAL_MS = '600000';
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    publishCommand.mockResolvedValue(undefined);
    ({ app, http, prisma } = await buildApp((b) =>
      b.overrideProvider(MqttConsumerService).useValue(mqttStub),
    ));
    commands = app.get(CommandsService);
    scheduler = app.get(CommandsSchedulerService);
    owner = await createUser(app, http);
    other = await createUser(app, http);
    await provisionDevice(prisma, deviceId);
    await bindDevice(http, owner.token, deviceId);
    await provisionDevice(prisma, deviceB);
    await bindDevice(http, other.token, deviceB);
  });

  afterAll(async () => {
    await cleanupDevices(prisma, [deviceId, deviceB]);
    await cleanupUsers(prisma, [owner, other]);
    await app.close();
  });

  beforeEach(() => {
    publishCommand.mockReset();
    publishCommand.mockResolvedValue(undefined);
  });

  it('pending → delivered：PUBACK 才 delivered（deliveredAt 落库）；发布 reject 留 pending；未超时 tick 不动；超时 tick → offline', async () => {
    const a = await issue({ volume: 3 });
    expect((await db(a)).status).toBe('delivered');
    expect((await db(a)).deliveredAt).not.toBeNull();
    expect(publishCommand).toHaveBeenCalledWith(
      deviceId,
      expect.stringContaining(a),
    );
    const wire = JSON.parse(publishCommand.mock.calls[0][1]) as {
      commandId: string;
      params: unknown;
      type: string;
    };
    expect(wire).toMatchObject({
      commandId: a,
      type: 'set_config',
      params: { volume: 3 },
    });

    publishCommand.mockRejectedValueOnce(new Error('MQTT 未连接'));
    const b = await issue({ volume: 4 });
    expect((await db(b)).status).toBe('pending');
    expect((await db(b)).deliveredAt).toBeNull();

    await scheduler.tick(); // 未到 1s
    expect([(await db(a)).status, (await db(b)).status]).toEqual([
      'delivered',
      'pending',
    ]);
    await waitTimeout();
    await scheduler.tick();
    expect([(await db(a)).status, (await db(b)).status]).toEqual([
      'offline',
      'offline',
    ]);
    // offline 期间设置绝不生效
    const s = await settingsOf();
    expect(s.volume).toBeUndefined();
    // REST 口径：未回执绝不显示成功
    const detail = await request(http)
      .get(`/api/v1/commands/${a}`)
      .set(auth(owner.token))
      .expect(200);
    expect(detail.body.status).toBe('offline');
    expect(detail.body.ackResult).toBeNull();
  });

  it('delivered → success（MQTT cmd_ack）写入生效设置；delivered → failed 记 errorCode 且不写设置；相同命令重复回执不翻转', async () => {
    const a = await issue({ volume: 5, led: 'on' });
    await mqttAck(a, 'success');
    expect(await db(a)).toMatchObject({
      status: 'success',
      ackResult: 'success',
      errorCode: null,
    });
    expect(await settingsOf()).toMatchObject({ volume: 5, led: 'on' });

    const b = await issue({ volume: 6 });
    await mqttAck(b, 'failed', { errorCode: 'E_BUSY' });
    expect(await db(b)).toMatchObject({
      status: 'failed',
      ackResult: 'failed',
      errorCode: 'E_BUSY',
    });
    expect((await settingsOf()).volume).toBe(5);

    // 重复/翻转回执：success 后再来 failed、failed 后再来 success，均忽略
    await mqttAck(a, 'failed', { errorCode: 'LATE_FLIP' });
    await mqttAck(b, 'success');
    expect((await db(a)).status).toBe('success');
    expect((await db(b)).status).toBe('failed');
    expect((await db(b)).errorCode).toBe('E_BUSY');
    expect((await settingsOf()).volume).toBe(5);
    // 终态后 relay-ack 也幂等返回现状
    const r = await relayAck(b, {
      stage: 'executed',
      result: 'success',
    }).expect(200);
    expect(r.body).toEqual({ commandId: b, status: 'failed' });
  });

  it('迟到 executed 覆盖 offline 并写入设置（MQTT 与 relay-ack 两路各一）；offline 后 relay delivered 不回退', async () => {
    const a = await issue({ brightness: 7 });
    const b = await issue({ contrast: 8 });
    await waitTimeout();
    await scheduler.tick();
    expect([(await db(a)).status, (await db(b)).status]).toEqual([
      'offline',
      'offline',
    ]);

    const d = await relayAck(b, { stage: 'delivered' }).expect(200);
    expect(d.body.status).toBe('offline');

    await mqttAck(a, 'success');
    const rb = await relayAck(b, {
      stage: 'executed',
      result: 'success',
      executedAt: new Date().toISOString(),
    }).expect(200);
    expect(rb.body.status).toBe('success');
    expect([(await db(a)).status, (await db(b)).status]).toEqual([
      'success',
      'success',
    ]);
    expect(await settingsOf()).toMatchObject({ brightness: 7, contrast: 8 });
  });

  it('伪造 / 串线回执：未知 commandId、他设备的 commandId（MQTT）忽略；他人 relay-ack 404 DEVICE_NOT_FOUND；跨设备 relay-ack 404 NOT_FOUND；非法 JSON 不炸', async () => {
    const a = await issue({ mode: 'eco' });
    await commands.handleAck(
      deviceId,
      JSON.stringify({ commandId: randomUUID(), result: 'success' }),
    );
    await commands.handleAck(
      deviceB,
      JSON.stringify({ commandId: a, result: 'success' }),
    ); // 串线：deviceB 冒领 A 的命令
    await commands.handleAck(deviceId, '{not json');
    await commands.handleAck(
      deviceId,
      JSON.stringify({ commandId: a, result: 'maybe' }),
    );
    expect((await db(a)).status).toBe('delivered');
    expect((await settingsOf()).mode).toBeUndefined();

    const r1 = await relayAck(
      a,
      { stage: 'executed', result: 'success' },
      other.token,
    );
    expect([r1.status, r1.body.code]).toEqual([404, 'DEVICE_NOT_FOUND']);
    const r2 = await relayAck(
      a,
      { stage: 'executed', result: 'success' },
      other.token,
      deviceB,
    );
    expect([r2.status, r2.body.code]).toEqual([404, 'NOT_FOUND']);
    expect((await db(a)).status).toBe('delivered');
    // 合法回执收尾
    await mqttAck(a, 'success');
    expect((await settingsOf()).mode).toBe('eco');
  });

  it('按键合并（旧报告 #9 复验）：A{vol=1,ledA=x} → B{vol=9} 先 success → A 迟到 success：vol 保持 9、ledA 合入；反向顺序 vol=9 亦保持', async () => {
    const a = await issue({ vol: 1, ledA: 'x' });
    await sleep(20); // issuedAt 严格递增
    const b = await issue({ vol: 9 });
    await mqttAck(b, 'success');
    expect((await settingsOf()).vol).toBe(9);
    await waitTimeout();
    await scheduler.tick(); // A 超时 offline
    expect((await db(a)).status).toBe('offline');
    await mqttAck(a, 'success'); // 迟到
    expect((await db(a)).status).toBe('success');
    const s = await settingsOf();
    expect(s).toMatchObject({ vol: 9, ledA: 'x' });

    // 反向：更早的 C 先 success，再来更晚的 D success → D 值生效
    const c = await issue({ vol: 2 });
    await sleep(20);
    const d = await issue({ vol: 3 });
    await mqttAck(c, 'success');
    await mqttAck(d, 'success');
    expect((await settingsOf()).vol).toBe(3);
  });

  it('同一命令 MQTT cmd_ack(success) 与 relay-ack executed(failed) 并发：只终态化一次，终态与 ackResult 一致，设置只按赢家写', async () => {
    for (let round = 0; round < 5; round += 1) {
      const key = `race${round}`;
      const a = await issue({ [key]: 1 });
      const [, r] = await Promise.all([
        mqttAck(a, 'success'),
        relayAck(a, { stage: 'executed', result: 'failed', errorCode: 'RACE' }),
      ]);
      expect(r.status).toBe(200);
      const row = await db(a);
      expect(['success', 'failed']).toContain(row.status);
      expect(row.ackResult).toBe(row.status);
      expect(row.errorCode).toBe(row.status === 'failed' ? 'RACE' : null);
      const s = await settingsOf();
      expect(s[key] === 1).toBe(row.status === 'success');
      // 并发后再补一发另一结果：不翻转
      await mqttAck(a, row.status === 'success' ? 'failed' : 'success');
      expect((await db(a)).status).toBe(row.status);
    }
  });

  it('超时扫描 tick 与 success 回执并发：终态必为 success（offline 可被覆盖，success 不可被 offline 覆盖）', async () => {
    for (let round = 0; round < 3; round += 1) {
      const a = await issue({ [`tick${round}`]: true });
      await waitTimeout();
      await Promise.all([scheduler.tick(), mqttAck(a, 'success')]);
      expect((await db(a)).status).toBe('success');
      expect((await settingsOf())[`tick${round}`]).toBe(true);
      await scheduler.tick();
      expect((await db(a)).status).toBe('success');
    }
  });

  it('executedAt 非法（MQTT 与 relay 两路）→ 服务器时间兜底；relay stage=executed 缺 result → 400 VALIDATION_FAILED；stage 非法 400', async () => {
    const a = await issue({ t1: 1 });
    const before = Date.now();
    await mqttAck(a, 'success', { executedAt: 'not-a-date' });
    const ra = await db(a);
    expect(ra.executedAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(ra.executedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 5);

    const b = await issue({ t2: 2 });
    const before2 = Date.now();
    await relayAck(b, {
      stage: 'executed',
      result: 'success',
      executedAt: '2026-13-45T99:99:99Z',
    }).expect(200);
    const rb = await db(b);
    expect(rb.executedAt!.getTime()).toBeGreaterThanOrEqual(before2 - 5);

    const c = await issue({ t3: 3 });
    const bad1 = await relayAck(c, { stage: 'executed' });
    expect([bad1.status, bad1.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const bad2 = await relayAck(c, { stage: 'done', result: 'success' });
    expect([bad2.status, bad2.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const bad3 = await relayAck(c, { stage: 'executed', result: 'ok' });
    expect([bad3.status, bad3.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await db(c)).status).toBe('delivered');
  });

  it('命令历史/详情口径：lastCommand 为最近一次下发，settings 只含 success 命令的键；他人 404', async () => {
    const a = await issue({ final: 'yes' });
    await mqttAck(a, 'failed', { errorCode: 'NOPE' });
    const res = await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set(auth(owner.token))
      .expect(200);
    expect(res.body.lastCommand).toMatchObject({
      commandId: a,
      status: 'failed',
      errorCode: 'NOPE',
    });
    expect(res.body.settings.final).toBeUndefined();
    await request(http)
      .get(`/api/v1/devices/${deviceId}/settings`)
      .set(auth(other.token))
      .expect(404);
    await request(http)
      .get(`/api/v1/commands/${a}`)
      .set(auth(other.token))
      .expect(404);
  });
});
