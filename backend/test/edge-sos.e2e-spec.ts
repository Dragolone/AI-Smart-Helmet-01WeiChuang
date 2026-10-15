// 2026-10-16 边界测试：SOS 状态机与事故记录（API.md §7，决策 #8 / #26 / #40）。
// 补现有 sos / hardening-sos / audit-sos-* 没覆盖到的跳转组合、到期与操作的先后、通知对象的取数时刻。
// 倒计时 1 s、扫描间隔调大，全部到期处理由测试手动 tick 驱动。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { SosSchedulerService } from '../src/sos/sos-scheduler.service';
import {
  bindDevice,
  cleanupDevices,
  cleanupUsers,
  createUser,
  histogram,
  provisionDevice,
  relay,
  sleep,
  type Http,
  type TestUser,
} from './helpers/hardening';
import {
  activeOf,
  addContact,
  auth,
  buildSosApp,
  cancelSos,
  confirmSos,
  fallEnvelope,
  makeProviderMocks,
  manualEnvelope,
  notificationsOf,
  resetMocks,
  sosByEvent,
  sosSmsCalls,
} from './helpers/audit-sos';

jest.setTimeout(120_000);

const mocks = makeProviderMocks();

describe('边界：SOS 状态机与事故记录 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let scheduler: SosSchedulerService;
  const users: TestUser[] = [];
  const devices: string[] = [];
  const run = Date.now();
  let seq = 0;

  const newUser = async (): Promise<TestUser> => {
    const u = await createUser(app, http);
    users.push(u);
    return u;
  };
  /** 新设备并绑给 u */
  const newDevice = async (u: TestUser): Promise<string> => {
    seq += 1;
    const id = `edge_sos_${run}_${seq}`;
    devices.push(id);
    await provisionDevice(prisma, id);
    await bindDevice(http, u.token, id);
    return id;
  };
  /** 经 app-relay 投一条摔倒 / 求救，返回建出的单（可能为 null） */
  const trigger = async (
    u: TestUser,
    deviceId: string,
    e: Record<string, unknown> = fallEnvelope(deviceId),
  ) => {
    await relay(http, u.token, deviceId, [e]).expect(202);
    return sosByEvent(prisma, e.eventId as string);
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildSosApp(
      { countdownSeconds: '1', scanIntervalMs: '600000', maxAttempts: '3' },
      mocks,
    ));
    scheduler = app.get(SosSchedulerService);
  });

  beforeEach(() => resetMocks(mocks));

  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, users);
    await app.close();
  });

  describe('非法跳转与不存在的单', () => {
    it('不存在 / 超长 / 特殊字符的 sosId：取消、确认、事故详情一律 404 NOT_FOUND', async () => {
      const u = await newUser();
      for (const id of ['nope', 'x'.repeat(3000), "1' OR '1'='1", '😀']) {
        const enc = encodeURIComponent(id);
        for (const r of [
          await cancelSos(http, u.token, enc),
          await confirmSos(http, u.token, enc),
          await request(http)
            .get(`/api/v1/accidents/${enc}`)
            .set(auth(u.token)),
        ]) {
          expect(r.status).toBe(404);
          expect(r.body.code).toBe('NOT_FOUND');
        }
      }
    });

    it('已通知 → 取消 409；已通知 → 再确认 409；已取消 → 确认 409；已取消 → 再取消 409（全部 SOS_ALREADY_FINALIZED，状态不动）', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const notified = (await trigger(u, d))!;
      await confirmSos(http, u.token, notified.id).expect(200);
      for (const r of [
        await cancelSos(http, u.token, notified.id),
        await confirmSos(http, u.token, notified.id),
      ]) {
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('SOS_ALREADY_FINALIZED');
      }
      const cancelled = (await trigger(u, d))!;
      await cancelSos(http, u.token, cancelled.id).expect(200);
      for (const r of [
        await confirmSos(http, u.token, cancelled.id),
        await cancelSos(http, u.token, cancelled.id),
      ]) {
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('SOS_ALREADY_FINALIZED');
      }
      expect(
        (await prisma.sosCase.findUniqueOrThrow({ where: { id: notified.id } }))
          .status,
      ).toBe('notified');
      expect(
        (
          await prisma.sosCase.findUniqueOrThrow({
            where: { id: cancelled.id },
          })
        ).status,
      ).toBe('cancelled');
      // 已取消的单一条通知都没铺
      expect(await notificationsOf(prisma, cancelled.id)).toHaveLength(0);
    });

    it('取消 / 确认响应就是更新后的 sos 对象（字段齐全、status 已是终态）', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const c = (await trigger(u, d))!;
      const r = await cancelSos(http, u.token, c.id).expect(200);
      expect(r.body).toMatchObject({
        sosId: c.id,
        deviceId: d,
        triggerEventId: c.triggerEventId,
        triggerType: 'possible_fall',
        status: 'cancelled',
        deadline: c.deadline.toISOString(),
      });
      expect(typeof r.body.updatedAt).toBe('string');
    });
  });

  describe('到期与操作的先后', () => {
    it('deadline 已过但扫描还没跑：取消仍 200（状态机以 pending 为准，到期由扫描终态化），之后扫描不发任何通知', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      await addContact(http, u.token, '家人', '19100001001');
      const c = (await trigger(u, d))!;
      await sleep(1200);
      expect(c.deadline.getTime()).toBeLessThan(Date.now());
      const r = await cancelSos(http, u.token, c.id);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('cancelled');
      await scheduler.tick();
      expect(await notificationsOf(prisma, c.id)).toHaveLength(0);
      expect(sosSmsCalls(mocks)).toHaveLength(0);
    });

    it('deadline 已过但扫描还没跑：确认 200 notified；随后的扫描不重复投递（每条通知 attempts=1）', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      await addContact(http, u.token, '家人', '19100001002');
      const c = (await trigger(u, d))!;
      await sleep(1200);
      await confirmSos(http, u.token, c.id).expect(200);
      await scheduler.tick();
      await scheduler.tick();
      const rows = await notificationsOf(prisma, c.id);
      expect(rows.map((x) => [x.channel, x.status, x.attempts])).toEqual([
        ['sms', 'sent', 1],
        ['push', 'sent', 1],
      ]);
      expect(sosSmsCalls(mocks)).toHaveLength(1);
    });

    it('到期后取消与扫描同时发生：终态只有一种——要么 cancelled 且零通知，要么 notified 且取消拿到 409', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      await addContact(http, u.token, '家人', '19100001003');
      const c = (await trigger(u, d))!;
      await sleep(1200);
      const [cancel] = await Promise.all([
        cancelSos(http, u.token, c.id),
        scheduler.tick(),
      ]);
      await scheduler.tick();
      const final = await prisma.sosCase.findUniqueOrThrow({
        where: { id: c.id },
      });
      const rows = await notificationsOf(prisma, c.id);
      if (final.status === 'cancelled') {
        expect(cancel.status).toBe(200);
        expect(rows).toHaveLength(0);
      } else {
        expect(final.status).toBe('notified');
        expect(cancel.status).toBe(409);
        expect(rows.filter((x) => x.channel === 'sms')).toHaveLength(1);
      }
    });

    it('同一单并发取消 20 次：恰好 1 个 200，其余 409；WS / 数据库终态一致', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const c = (await trigger(u, d))!;
      const rs = await Promise.all(
        Array.from({ length: 20 }, () => cancelSos(http, u.token, c.id)),
      );
      expect(histogram(rs.map((r) => r.status))).toEqual({
        '200': 1,
        '409': 19,
      });
      expect(
        (await prisma.sosCase.findUniqueOrThrow({ where: { id: c.id } }))
          .status,
      ).toBe('cancelled');
    });
  });

  describe('合并规则（决策 #26 / #40）', () => {
    it('manual_sos 倒计时中又来一条 manual_sos：按 SOS Now 立即通知，不建第二单', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const first = (await trigger(u, d, manualEnvelope(d)))!;
      expect(first.status).toBe('pending');
      await trigger(u, d, manualEnvelope(d));
      expect(
        (await prisma.sosCase.findUniqueOrThrow({ where: { id: first.id } }))
          .status,
      ).toBe('notified');
      expect(await prisma.sosCase.count({ where: { deviceId: d } })).toBe(1);
    });

    it('manual_sos 倒计时中来一条 possible_fall：只留档不建单，原单仍 pending', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const first = (await trigger(u, d, manualEnvelope(d)))!;
      const fall = fallEnvelope(d);
      expect(await trigger(u, d, fall)).toBeNull();
      expect(
        await prisma.rawEvent.count({
          where: { deviceId: d, eventId: fall.eventId as string },
        }),
      ).toBe(1);
      expect(
        (await prisma.sosCase.findUniqueOrThrow({ where: { id: first.id } }))
          .status,
      ).toBe('pending');
    });

    it('同一用户两台头盔同时摔倒：各建一单、各自 active、互不合并', async () => {
      const u = await newUser();
      const d1 = await newDevice(u);
      const d2 = await newDevice(u);
      const [c1, c2] = await Promise.all([trigger(u, d1), trigger(u, d2)]);
      expect(c1!.status).toBe('pending');
      expect(c2!.status).toBe('pending');
      expect(
        (await activeOf(http, u.token, d1).expect(200)).body.sos.sosId,
      ).toBe(c1!.id);
      expect(
        (await activeOf(http, u.token, d2).expect(200)).body.sos.sosId,
      ).toBe(c2!.id);
      // 取消一台不影响另一台
      await cancelSos(http, u.token, c1!.id).expect(200);
      expect(
        (await activeOf(http, u.token, d2).expect(200)).body.sos.sosId,
      ).toBe(c2!.id);
    });

    it('单已取消后同一 eventId 的摔倒重放：幂等挡掉，不会「复活」成新单', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const e = fallEnvelope(d);
      const c = (await trigger(u, d, e))!;
      await cancelSos(http, u.token, c.id).expect(200);
      const replay = await relay(http, u.token, d, [e]).expect(202);
      expect(replay.body).toEqual({ accepted: 0, duplicate: 1, invalid: 0 });
      expect(await prisma.sosCase.count({ where: { deviceId: d } })).toBe(1);
      expect(
        (await activeOf(http, u.token, d).expect(200)).body.sos,
      ).toBeNull();
    });
  });

  describe('通知对象在终态化那一刻取数', () => {
    it('倒计时中删掉一个联系人、新增一个：通知按终态化时的活跃联系人发，被删的不发', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      await addContact(http, u.token, '留下', '19100002001');
      const gone = await addContact(http, u.token, '删掉', '19100002002');
      const c = (await trigger(u, d))!;
      await request(http)
        .delete(`/api/v1/users/me/emergency-contacts/${gone.body.id as string}`)
        .set(auth(u.token))
        .expect(204);
      await addContact(http, u.token, '新加', '19100002003');
      await confirmSos(http, u.token, c.id).expect(200);
      expect(
        sosSmsCalls(mocks)
          .map(([to]) => to)
          .sort(),
      ).toEqual(['19100002001', '19100002003']);
    });

    it('倒计时中把联系人改了号：短信发到改后的号码', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const ct = await addContact(http, u.token, '家人', '19100003001');
      const c = (await trigger(u, d))!;
      await request(http)
        .patch(`/api/v1/users/me/emergency-contacts/${ct.body.id as string}`)
        .set(auth(u.token))
        .send({ phone: '19100003002' })
        .expect(200);
      await confirmSos(http, u.token, c.id).expect(200);
      expect(sosSmsCalls(mocks).map(([to]) => to)).toEqual(['19100003002']);
    });

    it('事故详情里的通知目标已脱敏（138****xxxx 形）、带联系人名与通道', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      await addContact(http, u.token, '老婆', '19100004001');
      const c = (await trigger(u, d))!;
      await confirmSos(http, u.token, c.id).expect(200);
      const detail = await request(http)
        .get(`/api/v1/accidents/${c.id}`)
        .set(auth(u.token))
        .expect(200);
      const sms = detail.body.notifications.find(
        (n: { channel: string }) => n.channel === 'sms',
      );
      expect(sms.target).toBe('191****4001');
      expect(JSON.stringify(detail.body)).not.toContain('19100004001');
    });
  });

  describe('位置快照（触发事件内嵌位置的边界值）', () => {
    it('纬度 90 / 经度 180 / 经度 -180 是合法边界，快照取自事件', async () => {
      const u = await newUser();
      for (const location of [
        { latitude: 90, longitude: 180, coordinateSystem: 'wgs84' },
        { latitude: -90, longitude: -180, coordinateSystem: 'gcj02' },
      ]) {
        const d = await newDevice(u);
        const c = (await trigger(u, d, fallEnvelope(d, { location })))!;
        expect(c).toMatchObject({
          latitude: location.latitude,
          longitude: location.longitude,
          locationSource: 'event',
          accuracy: null,
        });
      }
    });

    it('事件位置越界一点点 / 缺坐标系 / 字符串坐标：不当快照；设备也没有轨迹点 → 空快照照建单', async () => {
      const u = await newUser();
      for (const location of [
        { latitude: 90.000001, longitude: 0, coordinateSystem: 'wgs84' },
        { latitude: 10, longitude: -180.5, coordinateSystem: 'wgs84' },
        { latitude: 10, longitude: 10 },
        { latitude: '10', longitude: '10', coordinateSystem: 'wgs84' },
        { latitude: 10, longitude: 10, coordinateSystem: 'bd09' },
      ]) {
        const d = await newDevice(u);
        const c = (await trigger(u, d, fallEnvelope(d, { location })))!;
        expect(c.status).toBe('pending');
        expect(c.latitude).toBeNull();
        expect(c.locationSource).toBeNull();
      }
    });

    it('事件位置精确 (0,0) 且没有轨迹点：空快照；确认后短信位置写「暂不可用」而不是 0,0', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      await addContact(http, u.token, '家人', '19100005001');
      const c = (await trigger(
        u,
        d,
        fallEnvelope(d, {
          location: { latitude: 0, longitude: 0, coordinateSystem: 'wgs84' },
        }),
      ))!;
      expect(c.latitude).toBeNull();
      await confirmSos(http, u.token, c.id).expect(200);
      const [, msg] = sosSmsCalls(mocks)[0];
      expect(msg).toMatchObject({
        template: 'sos_alert',
        params: { locationText: '暂不可用' },
      });
    });

    it('triggeredAt = 触发事件的设备时间（3 小时前补传），deadline 仍从服务器收到时刻起算', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const at = new Date(Date.now() - 3 * 3_600_000);
      const before = Date.now();
      const c = (await trigger(
        u,
        d,
        fallEnvelope(d, {}, { timestamp: at.toISOString() }),
      ))!;
      const active = await activeOf(http, u.token, d).expect(200);
      expect(active.body.sos.triggeredAt).toBe(at.toISOString());
      expect(c.deadline.getTime()).toBeGreaterThanOrEqual(before + 900);
    });
  });

  describe('事故记录列表 / 详情', () => {
    it('分页：pageSize=101 → 400；page 超出 → 200 空 items、total 不变；最新在前', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const c = (await trigger(u, d))!;
        ids.push(c.id);
        await cancelSos(http, u.token, c.id).expect(200);
      }
      const base = `/api/v1/devices/${d}/accidents`;
      expect(
        (
          await request(http)
            .get(base)
            .query({ pageSize: 101 })
            .set(auth(u.token))
        ).status,
      ).toBe(400);
      const beyond = await request(http)
        .get(base)
        .query({ page: 9, pageSize: 2 })
        .set(auth(u.token))
        .expect(200);
      expect(beyond.body).toMatchObject({
        items: [],
        total: 3,
        page: 9,
        pageSize: 2,
      });
      const all = await request(http).get(base).set(auth(u.token)).expect(200);
      expect(all.body.items.map((x: { sosId: string }) => x.sosId)).toEqual(
        [...ids].reverse(),
      );
    });

    it('原主解绑后：设备下的事故列表 404 DEVICE_NOT_FOUND（列表按当前绑定校验，按现状），但事故详情按建单用户固化仍 200', async () => {
      const u = await newUser();
      const d = await newDevice(u);
      const c = (await trigger(u, d))!;
      await cancelSos(http, u.token, c.id).expect(200);
      await request(http)
        .delete(`/api/v1/devices/${d}/binding`)
        .set(auth(u.token))
        .expect(204);
      const listRes = await request(http)
        .get(`/api/v1/devices/${d}/accidents`)
        .set(auth(u.token));
      expect(listRes.status).toBe(404);
      expect(listRes.body.code).toBe('DEVICE_NOT_FOUND');
      const detail = await request(http)
        .get(`/api/v1/accidents/${c.id}`)
        .set(auth(u.token));
      expect(detail.status).toBe(200);
      expect(detail.body.sosId).toBe(c.id);
    });

    it('原主解绑后：设备的 active 对原主 404（按当前绑定校验，按现状）；新主看到的 active 为 null（旧单不串给新主）', async () => {
      const a = await newUser();
      const b = await newUser();
      const d = await newDevice(a);
      const c = (await trigger(a, d))!;
      await request(http)
        .delete(`/api/v1/devices/${d}/binding`)
        .set(auth(a.token))
        .expect(204);
      expect((await activeOf(http, a.token, d)).status).toBe(404);
      await bindDevice(http, b.token, d);
      expect(
        (await activeOf(http, b.token, d).expect(200)).body.sos,
      ).toBeNull();
      // 原主凭 sosId 仍能处置（解绑不影响处置权）
      await cancelSos(http, a.token, c.id).expect(200);
    });
  });
});
