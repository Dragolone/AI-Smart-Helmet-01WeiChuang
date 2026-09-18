// 上线前加固：设备绑定竞态、命令回执顺序、设置参数极值、分页/时间范围极值、联系人/对讲名额竞态、Admin 隔离。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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
  envelope,
  histogram,
  provisionDevice,
  relay,
  sleep,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(120_000);

describe('加固：设备 / 命令 / 查询边界 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let commands: CommandsService;
  let cmdScheduler: CommandsSchedulerService;

  const run = Date.now();
  const devBind = `hard_dev_bind_${run}`;
  const devMain = `hard_dev_main_${run}`;
  const devCmd = `hard_dev_cmd_${run}`;
  const devices = [devBind, devMain, devCmd];
  let owner: TestUser;
  let other: TestUser;
  let third: TestUser;

  beforeAll(async () => {
    process.env.COMMAND_ACK_TIMEOUT_SECONDS = '1';
    process.env.COMMAND_SCAN_INTERVAL_MS = '600000';
    process.env.VOICE_CHANNEL_MEMBER_LIMIT = '2';
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    const mqttStub = {
      setCmdAckHandler: jest.fn(),
      publishCommand: jest.fn().mockRejectedValue(new Error('MQTT 未连接')),
      onModuleInit: jest.fn(),
      onModuleDestroy: jest.fn(),
    };
    ({ app, http, prisma } = await buildApp((b) =>
      b.overrideProvider(MqttConsumerService).useValue(mqttStub),
    ));
    commands = app.get(CommandsService);
    cmdScheduler = app.get(CommandsSchedulerService);
    owner = await createUser(app, http);
    other = await createUser(app, http);
    third = await createUser(app, http);
    for (const d of devices) await provisionDevice(prisma, d);
    await bindDevice(http, owner.token, devMain);
    await bindDevice(http, owner.token, devCmd);
  });

  afterAll(async () => {
    delete process.env.VOICE_CHANNEL_MEMBER_LIMIT;
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, [owner, other, third]);
    await app.close();
  });

  describe('绑定', () => {
    it('两个用户并发绑定同一设备：必须恰好一个 200、一个 409', async () => {
      const [a, b] = await Promise.all([
        request(http)
          .post('/api/v1/devices/bind')
          .set(auth(owner.token))
          .send({ deviceId: devBind, bindCode: `bc_${devBind}` }),
        request(http)
          .post('/api/v1/devices/bind')
          .set(auth(other.token))
          .send({ deviceId: devBind, bindCode: `bc_${devBind}` }),
      ]);
      const h = histogram([a.status, b.status]);
      console.log('[concurrent bind by 2 users]', h);
      expect(h['200']).toBe(1);
      expect(h['409']).toBe(1);
    });

    it('绑定码大小写/首尾空格不容错（403）；deviceId 路径穿越 404；重命名 21 字 400，空白名清空', async () => {
      const dev = await prisma.device.findUniqueOrThrow({
        where: { deviceId: devBind },
      });
      const owned = dev.bindUserId === owner.id ? owner : other;
      const stranger = owned === owner ? other : owner;
      await request(http)
        .post('/api/v1/devices/bind')
        .set(auth(stranger.token))
        .send({ deviceId: devBind, bindCode: `bc_${devBind}`.toUpperCase() })
        .expect(403);
      await request(http)
        .post('/api/v1/devices/bind')
        .set(auth(stranger.token))
        .send({ deviceId: devBind, bindCode: ` bc_${devBind} ` })
        .expect(403);
      await request(http)
        .get('/api/v1/devices/..%2F..%2Fetc')
        .set(auth(owner.token))
        .expect(404);
      await request(http)
        .get(`/api/v1/devices/${encodeURIComponent('a b/c')}`)
        .set(auth(owner.token))
        .expect(404);
      await request(http)
        .patch(`/api/v1/devices/${devMain}`)
        .set(auth(owner.token))
        .send({ name: 'x'.repeat(21) })
        .expect(400);
      const r = await request(http)
        .patch(`/api/v1/devices/${devMain}`)
        .set(auth(owner.token))
        .send({ name: '   ' })
        .expect(200);
      expect(r.body.name).toBeNull();
      await request(http)
        .patch(`/api/v1/devices/${devMain}`)
        .set(auth(owner.token))
        .send({ name: 42 })
        .expect(400);
    });
  });

  describe('查询边界', () => {
    it('轨迹：恰好 24h 200；24h+1s 400；from=to 400；非法日期 400；page 极值不 5xx', async () => {
      const to = new Date();
      const from24 = new Date(to.getTime() - 24 * 3600 * 1000);
      const from24p = new Date(to.getTime() - 24 * 3600 * 1000 - 1000);
      const q = (from: string, toS: string, extra = '') =>
        request(http)
          .get(
            `/api/v1/devices/${devMain}/locations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(toS)}${extra}`,
          )
          .set(auth(owner.token));
      await q(from24.toISOString(), to.toISOString()).expect(200);
      await q(from24p.toISOString(), to.toISOString()).expect(400);
      await q(to.toISOString(), to.toISOString()).expect(400);
      await q(to.toISOString(), from24.toISOString()).expect(400);
      await q('2026-13-01T00:00:00Z', to.toISOString()).expect(400);
      await q('2026-02-30T00:00:00Z', to.toISOString()).expect(400);
      const big = await q(
        from24.toISOString(),
        to.toISOString(),
        '&page=2147483647&pageSize=100',
      );
      expect(big.status).toBe(200);
      const huge = await q(
        from24.toISOString(),
        to.toISOString(),
        '&page=99999999999',
      );
      expect(huge.status).toBeLessThan(500);
      await q(from24.toISOString(), to.toISOString(), '&pageSize=101').expect(
        400,
      );
      await q(from24.toISOString(), to.toISOString(), '&pageSize=0').expect(
        400,
      );
      await q(from24.toISOString(), to.toISOString(), '&page=1.5').expect(400);
    });

    it('事件：type=_invalid 400；未知类型 400；type=,,, 视为不筛；仅 from 200；page 极值不 5xx', async () => {
      const q = (qs: string) =>
        request(http)
          .get(`/api/v1/devices/${devMain}/events?${qs}`)
          .set(auth(owner.token));
      await q('type=_invalid').expect(400);
      await q('type=collision_risk,nope').expect(400);
      await q('type=,,,').expect(200);
      await q('type=collision_risk,%20obstacle_risk%20').expect(200);
      await q('from=2026-01-01T00:00:00Z').expect(200);
      await q('from=2026-01-01T00:00:00Z&to=2025-01-01T00:00:00Z').expect(400);
      const r = await q('page=2147483647&pageSize=100');
      expect(r.status).toBe(200);
    });
  });

  describe('设置下发与回执', () => {
    const put = (settings: unknown, token = owner.token, dev = devCmd) =>
      request(http)
        .put(`/api/v1/devices/${dev}/settings`)
        .set(auth(token))
        .send({ settings });
    const ack = (
      commandId: string,
      body: Record<string, unknown>,
      token = owner.token,
      dev = devCmd,
    ) =>
      request(http)
        .post(`/api/v1/devices/${dev}/commands/${commandId}/relay-ack`)
        .set(auth(token))
        .send(body);

    it('参数护栏：__proto__/constructor 键、21 键、嵌套、Infinity、空对象、非对象、未知键/越界/类型（决策 #43）', async () => {
      const proto = await put(
        JSON.parse('{"__proto__":{"polluted":true},"a":1}'),
      );
      expect(proto.status).toBeLessThan(500);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      const ctor = await put({ constructor: 'x', a: 1 });
      expect(ctor.status).toBeLessThan(500);
      const many: Record<string, number> = {};
      for (let i = 0; i < 21; i += 1) many[`k${i}`] = i;
      await put(many).expect(400);
      await put({ a: { b: 1 } }).expect(400);
      await put({ a: [1] }).expect(400);
      await put({ a: null }).expect(400);
      const inf = await request(http)
        .put(`/api/v1/devices/${devCmd}/settings`)
        .set(auth(owner.token))
        .set('Content-Type', 'application/json')
        .send('{"settings":{"a":1e400}}');
      expect(inf.status).toBe(400);
      await put({}).expect(400);
      await put('str').expect(400);
      await put({ ['k'.repeat(65)]: 1 }).expect(400);
      await put({ s: 'x'.repeat(257) }).expect(400);
      // 决策 #43：字符串值与清单外的键一律拒；清单内边界值放行
      await put({ volume: '80' }).expect(400);
      await put({ volume: 101 }).expect(400);
      await put({ buzzer: 1 }).expect(400);
      await put({ volume: 100, vibration: 0, buzzer: false }).expect(202);
    });

    it('回执幂等与竞态：executed success/failed 各并发 5 次 → 终态只有一种，settings 只合入一次', async () => {
      const c = await put({ buzzer: true, volume: 3 }).expect(202);
      const id = c.body.commandId as string;
      const results = await Promise.all([
        ...Array.from({ length: 5 }, () =>
          ack(id, { stage: 'executed', result: 'success' }),
        ),
        ...Array.from({ length: 5 }, () =>
          ack(id, { stage: 'executed', result: 'failed', errorCode: 'E1' }),
        ),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const statuses = new Set(results.map((r) => r.body.status as string));
      const finalRow = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id },
      });
      expect(['success', 'failed']).toContain(finalRow.status);
      expect(statuses.has(finalRow.status)).toBe(true);
      const dev = await prisma.device.findUniqueOrThrow({
        where: { deviceId: devCmd },
      });
      const settings = (dev.settings ?? {}) as Record<string, unknown>;
      if (finalRow.status === 'success') expect(settings.buzzer).toBe(true);
      else expect(settings.buzzer).toBeUndefined();
    });

    it('回执顺序：旧命令的迟到 success 不覆盖新命令已生效的键，但未被覆盖的键照常合入', async () => {
      const a = await put({ volume: 1, light: 1 }).expect(202);
      const b = await put({ volume: 9 }).expect(202);
      await ack(b.body.commandId as string, {
        stage: 'executed',
        result: 'success',
      }).expect(200);
      const late = await ack(a.body.commandId as string, {
        stage: 'executed',
        result: 'success',
      }).expect(200);
      expect(late.body.status).toBe('success');
      const s = await request(http)
        .get(`/api/v1/devices/${devCmd}/settings`)
        .set(auth(owner.token))
        .expect(200);
      expect(
        (s.body.settings as { volume: number; light: number }).volume,
      ).toBe(9);
      expect((s.body.settings as { volume: number; light: number }).light).toBe(
        1,
      );
    });

    it('回执护栏：他人 404、串设备 404、不存在命令 404、executed 缺 result 400、非法 stage 400、非法 executedAt 兜底', async () => {
      const c = await put({ light: 1 }).expect(202);
      const id = c.body.commandId as string;
      await ack(id, { stage: 'delivered' }, other.token).expect(404);
      await ack(id, { stage: 'delivered' }, owner.token, devMain).expect(404);
      await ack('cmd_nope', { stage: 'delivered' }).expect(404);
      await ack(id, { stage: 'executed' }).expect(400);
      await ack(id, { stage: 'done' }).expect(400);
      await ack(id, { stage: 'executed', result: 'ok' }).expect(400);
      const r = await ack(id, {
        stage: 'executed',
        result: 'success',
        executedAt: 'not-a-date',
      }).expect(200);
      expect(r.body.status).toBe('success');
      const row = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id },
      });
      expect(row.executedAt).not.toBeNull();
    });

    it('MQTT cmd_ack：串设备回执被忽略；非法 JSON 忽略；不存在命令忽略', async () => {
      const c = await put({ vibration: 2 }).expect(202);
      const id = c.body.commandId as string;
      await commands.handleAck(
        devMain,
        JSON.stringify({ commandId: id, result: 'success' }),
      );
      expect(
        (await prisma.deviceCommand.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('pending');
      await commands.handleAck(devCmd, '{bad');
      await commands.handleAck(
        devCmd,
        JSON.stringify({ commandId: 'nope', result: 'success' }),
      );
      await commands.handleAck(
        devCmd,
        JSON.stringify({ commandId: id, result: 'maybe' }),
      );
      expect(
        (await prisma.deviceCommand.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('pending');
      await commands.handleAck(
        devCmd,
        JSON.stringify({ commandId: id, result: 'success', executedAt: 123 }),
      );
      expect(
        (await prisma.deviceCommand.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('success');
    });

    it('超时：20 个并发下发全部 pending → 1s 后 tick 全部 offline → 迟到回执如实覆盖', async () => {
      // 并发下发的压力面在 stress 套件（真实监听端口）验证；这里顺序下发只验状态机
      const results: request.Response[] = [];
      for (let i = 0; i < 20; i += 1)
        results.push(await put({ volume: 1 + i }));
      expect(
        results.every((r) => r.status === 202 && r.body.status === 'pending'),
      ).toBe(true);
      const ids = results.map((r) => r.body.commandId as string);
      await sleep(1200);
      await Promise.all([
        cmdScheduler.tick(),
        cmdScheduler.tick(),
        cmdScheduler.tick(),
      ]);
      await cmdScheduler.tick();
      const rows = await prisma.deviceCommand.findMany({
        where: { id: { in: ids } },
      });
      expect(rows.every((r) => r.status === 'offline')).toBe(true);
      const late = await ack(ids[0], {
        stage: 'executed',
        result: 'success',
      }).expect(200);
      expect(late.body.status).toBe('success');
      const delivered = await ack(ids[1], { stage: 'delivered' }).expect(200);
      expect(delivered.body.status).toBe('offline');
      const list = await request(http)
        .get(`/api/v1/devices/${devCmd}/commands?pageSize=100`)
        .set(auth(owner.token))
        .expect(200);
      expect(list.body.total).toBeGreaterThanOrEqual(20);
    });
  });

  describe('名额竞态', () => {
    it('紧急联系人：4 个已存在时并发创建 4 个 → 活跃数不得超过 5', async () => {
      const u = await createUser(app, http);
      try {
        for (let i = 0; i < 4; i += 1) {
          await request(http)
            .post('/api/v1/users/me/emergency-contacts')
            .set(auth(u.token))
            .send({ name: `c${i}`, phone: `1390000000${i}` })
            .expect(201);
        }
        const results = await Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            request(http)
              .post('/api/v1/users/me/emergency-contacts')
              .set(auth(u.token))
              .send({ name: `p${i}`, phone: `1391000000${i}` }),
          ),
        );
        console.log(
          '[contacts race at 4/5, +4 concurrent]',
          histogram(results.map((r) => r.status)),
        );
        const active = await prisma.emergencyContact.count({
          where: { userId: u.id, deletedAt: null },
        });
        expect(active).toBeLessThanOrEqual(5);
        // 删除一个后可再建；已删的更新/再删 404
        const list = await request(http)
          .get('/api/v1/users/me/emergency-contacts')
          .set(auth(u.token))
          .expect(200);
        const victim = (list.body as Array<{ id: string }>)[0].id;
        await request(http)
          .delete(`/api/v1/users/me/emergency-contacts/${victim}`)
          .set(auth(u.token))
          .expect(204);
        await request(http)
          .delete(`/api/v1/users/me/emergency-contacts/${victim}`)
          .set(auth(u.token))
          .expect(404);
        await request(http)
          .patch(`/api/v1/users/me/emergency-contacts/${victim}`)
          .set(auth(u.token))
          .send({ name: 'z' })
          .expect(404);
        await request(http)
          .patch(`/api/v1/users/me/emergency-contacts/${victim}`)
          .set(auth(other.token))
          .send({ name: 'z' })
          .expect(404);
        await request(http)
          .post('/api/v1/users/me/emergency-contacts')
          .set(auth(u.token))
          .send({ name: 'bad', phone: '12345678901' })
          .expect(400);
      } finally {
        await cleanupUsers(prisma, [u]);
      }
    });

    it('对讲频道（上限临时=2）：并发加入 3 人 → 成员数不得超过上限；非成员 token/成员列表 404', async () => {
      const ch = await request(http)
        .post('/api/v1/voice/channels')
        .set(auth(owner.token))
        .send({ name: '加固房' })
        .expect(201);
      const channelId = ch.body.channelId as string;
      const inviteCode = ch.body.inviteCode as string;
      const joiners = [other, third, await createUser(app, http)];
      try {
        const results = await Promise.all(
          joiners.map((u) =>
            request(http)
              .post('/api/v1/voice/channels/join')
              .set(auth(u.token))
              .send({ inviteCode }),
          ),
        );
        console.log(
          '[voice join race, limit 2, +3 concurrent]',
          histogram(results.map((r) => r.status)),
        );
        const members = await prisma.voiceChannelMember.count({
          where: { channelId },
        });
        expect(members).toBeLessThanOrEqual(2);
        const outsider =
          joiners.find((u) => results[joiners.indexOf(u)].status === 409) ??
          joiners[2];
        await request(http)
          .get(`/api/v1/voice/channels/${channelId}/members`)
          .set(auth(outsider.token))
          .expect(404);
        await request(http)
          .post(`/api/v1/voice/channels/${channelId}/token`)
          .set(auth(outsider.token))
          .expect(404);
        await request(http)
          .delete(`/api/v1/voice/channels/${channelId}/membership`)
          .set(auth(outsider.token))
          .expect(404);
        await request(http)
          .post('/api/v1/voice/channels/join')
          .set(auth(owner.token))
          .send({ inviteCode: '12345' })
          .expect(400);
        await request(http)
          .post('/api/v1/voice/channels/join')
          .set(auth(owner.token))
          .send({ inviteCode: '000000' })
          .expect(404);
      } finally {
        await cleanupUsers(prisma, [joiners[2]]);
      }
    });
  });

  describe('Admin 隔离与关键字', () => {
    it('用户 token 进 admin 全部 401；admin 登录错误账号 401；keyword 含 % _ 不 5xx', async () => {
      for (const path of [
        'users',
        'devices',
        'accidents',
        'events',
        'stats/overview',
        `devices/${devMain}`,
      ]) {
        await request(http)
          .get(`/api/v1/admin/${path}`)
          .set(auth(owner.token))
          .expect(401);
        await request(http).get(`/api/v1/admin/${path}`).expect(401);
      }
      await request(http)
        .post('/api/v1/admin/auth/login')
        .send({ username: 'nope', password: 'nope' })
        .expect(401);
      // 用临时管理员验证关键字查询的健壮性
      const bcrypt = await import('bcrypt');
      const admin = await prisma.adminUser.create({
        data: {
          username: `hard_admin_${run}`,
          passwordHash: await bcrypt.hash('pw12345678', 4),
        },
      });
      try {
        const login = await request(http)
          .post('/api/v1/admin/auth/login')
          .send({ username: admin.username, password: 'pw12345678' })
          .expect(200);
        const t = login.body.accessToken as string;
        for (const kw of ['%', '_', "' OR 1=1 --", '\\', 'x'.repeat(64)]) {
          const r = await request(http)
            .get(`/api/v1/admin/users?keyword=${encodeURIComponent(kw)}`)
            .set(auth(t));
          expect(r.status).toBe(200);
        }
        await request(http)
          .get(`/api/v1/admin/users?keyword=${'x'.repeat(65)}`)
          .set(auth(t))
          .expect(400);
        await request(http)
          .get('/api/v1/admin/devices?online=maybe')
          .set(auth(t))
          .expect(400);
        await request(http)
          .get('/api/v1/admin/events?from=not-a-date')
          .set(auth(t))
          .expect(400);
        await request(http)
          .get('/api/v1/admin/devices/nope')
          .set(auth(t))
          .expect(404);
        // admin token 进用户接口 401
        await request(http).get('/api/v1/users/me').set(auth(t)).expect(401);
      } finally {
        await prisma.adminUser.delete({ where: { id: admin.id } });
      }
    });
  });

  describe('轨迹与事件的归属切换（决策 #39：按绑定区间可见）', () => {
    it('换绑后新主看不到前主的事件/轨迹/媒体；前主解绑再绑回来，自己的两段历史都可见', async () => {
      const ownerEvents = [
        envelope(devMain, 'location_update', validLocation(1)),
        envelope(devMain, 'collision_risk', { riskLevel: 'high' }),
      ];
      await relay(http, owner.token, devMain, ownerEvents).expect(202);
      const ownerRisk = ownerEvents[1].eventId as string;
      const events = (token: string) =>
        request(http)
          .get(`/api/v1/devices/${devMain}/events?pageSize=100`)
          .set(auth(token));
      const latest = (token: string) =>
        request(http)
          .get(`/api/v1/devices/${devMain}/locations/latest`)
          .set(auth(token));

      await request(http)
        .delete(`/api/v1/devices/${devMain}/binding`)
        .set(auth(owner.token))
        .expect(204);
      // 解绑后设备接口本身 404（当前非绑定）
      await events(owner.token).expect(404);
      await latest(owner.token).expect(404);

      // 新主：看不到前主期间的任何数据
      await bindDevice(http, other.token, devMain);
      const otherEmpty = await events(other.token).expect(200);
      expect(otherEmpty.body.total).toBe(0);
      expect((await latest(other.token).expect(200)).body.location).toBeNull();
      await request(http)
        .get(`/api/v1/events/${ownerRisk}`)
        .set(auth(other.token))
        .expect(404);
      // 新主自己的数据正常
      const otherEvent = envelope(devMain, 'location_update', validLocation(9));
      await relay(http, other.token, devMain, [otherEvent]).expect(202);
      expect((await events(other.token).expect(200)).body.total).toBe(1);
      expect(
        (await latest(other.token).expect(200)).body.location.latitude,
      ).toBeCloseTo(31.2009, 4);
      await request(http)
        .delete(`/api/v1/devices/${devMain}/binding`)
        .set(auth(other.token))
        .expect(204);

      // 前主绑回来：只看到自己那段（2 条），看不到新主那 1 条；最新位置是自己的点
      await bindDevice(http, owner.token, devMain);
      const ownerAgain = await events(owner.token).expect(200);
      expect(ownerAgain.body.total).toBe(2);
      const ids = (ownerAgain.body.items as Array<{ eventId: string }>).map(
        (i) => i.eventId,
      );
      expect(ids).toContain(ownerRisk);
      expect(ids).not.toContain(otherEvent.eventId);
      expect(
        (await latest(owner.token).expect(200)).body.location.latitude,
      ).toBeCloseTo(31.2001, 4);
      await request(http)
        .get(`/api/v1/events/${ownerRisk}`)
        .set(auth(owner.token))
        .expect(200);
      // 再来一段：绑回来之后的新事件也可见（两段区间拼接）
      await relay(http, owner.token, devMain, [
        envelope(devMain, 'obstacle_risk', {}),
      ]).expect(202);
      expect((await events(owner.token).expect(200)).body.total).toBe(3);
      expect(
        await prisma.deviceBinding.count({ where: { deviceId: devMain } }),
      ).toBe(3);
    });
  });
});
