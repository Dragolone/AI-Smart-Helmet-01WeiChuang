// 2026-09-13 全面审计 §6（auth）：决策 #39 绑定区间归属——A→B→A 三段、边界时刻（SQL 精确置时）、
// 晚到事件按 receivedAt 归属的风险、battery-history 是否按区间过滤、绑定竞态（旧报告 #10 复验）。
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../src/generated/prisma/client';
import { businessTime } from '../src/common/device-time';
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
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';
import { evidence, hist } from './helpers/audit-auth';

jest.setTimeout(180_000);

const LOG = 'binding.log';
const run = Date.now().toString(36);

interface Interval {
  boundAt: Date;
  unboundAt: Date | null;
}

describe('审计 §6：决策 #39 绑定区间 / 电量历史 / 绑定竞态 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let a: TestUser;
  let b: TestUser;
  const d = `audit_bind_${run}`;
  const raceDevice = `audit_bindrace_${run}`;
  const raceUsers: TestUser[] = [];
  const extraEventIds: string[] = [];
  const ev = {
    aLoc1: '',
    aRisk1: '',
    aFall1: '',
    aStatus1: '',
    bLoc1: '',
    bRisk1: '',
    bStatus1: '',
    aRisk2: '',
  };
  let sosA = '';
  let A1: Interval;
  let B1: Interval;
  let A2: Interval;

  const unbind = (token: string): request.Test =>
    request(http).delete(`/api/v1/devices/${d}/binding`).set(auth(token));

  const listEventIds = async (token: string): Promise<string[]> => {
    const r = await request(http)
      .get(`/api/v1/devices/${d}/events?pageSize=100`)
      .set(auth(token))
      .expect(200);
    return (r.body.items as Array<{ eventId: string }>).map((i) => i.eventId);
  };

  const latestReceivedAt = async (token: string): Promise<string | null> => {
    const r = await request(http)
      .get(`/api/v1/devices/${d}/locations/latest`)
      .set(auth(token))
      .expect(200);
    return (r.body.location?.receivedAt as string | undefined) ?? null;
  };

  const batteryTimestamps = async (token: string): Promise<string[]> => {
    const r = await request(http)
      .get(`/api/v1/devices/${d}/battery-history?hours=24`)
      .set(auth(token))
      .expect(200);
    return (r.body.points as Array<{ timestamp: string }>).map(
      (p) => p.timestamp,
    );
  };

  const intervalsOf = async (userId: string): Promise<Interval[]> =>
    prisma.deviceBinding.findMany({
      where: { deviceId: d, userId },
      orderBy: { boundAt: 'asc' },
      select: { boundAt: true, unboundAt: true },
    });

  /** 直接落一条 raw_events（等价 MQTT 入口晚到/离线补传），可精确指定 timestamp 与 receivedAt */
  const insertRaw = async (
    eventType: string,
    timestamp: Date,
    receivedAt: Date,
    payload: Record<string, unknown> = {},
  ): Promise<string> => {
    const eventId = randomUUID();
    await prisma.rawEvent.create({
      data: {
        eventId,
        deviceId: d,
        eventType,
        timestamp,
        receivedAt,
        // 与入库同口径（决策 #59）：直接写库时也要给业务时间，否则落成写入时刻
        businessTime: businessTime(timestamp, receivedAt),
        schemaVersion: 1,
        firmwareVersion: '0.1.0-audit',
        payload: payload as Prisma.InputJsonValue,
        source: 'mqtt',
      },
    });
    extraEventIds.push(eventId);
    return eventId;
  };

  const relayOne = async (
    token: string,
    eventType: string,
    payload: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): Promise<string> => {
    const e = envelope(d, eventType, payload, overrides);
    await relay(http, token, d, [e]).expect(202);
    return e.eventId as string;
  };

  beforeAll(async () => {
    ({ app, http, prisma } = await buildApp());
    a = await createUser(app, http);
    b = await createUser(app, http);
    await provisionDevice(prisma, d);
    await provisionDevice(prisma, raceDevice);
    evidence(LOG, `=== run ${run} 开始 ===`);
  });

  afterAll(async () => {
    await prisma.sosNotification
      .deleteMany({ where: { sos: { deviceId: { in: [d, raceDevice] } } } })
      .catch(() => undefined);
    await prisma.rawEvent
      .deleteMany({ where: { eventId: { in: extraEventIds } } })
      .catch(() => undefined);
    await cleanupDevices(prisma, [d, raceDevice]);
    await cleanupUsers(prisma, [a, b, ...raceUsers]);
    await app.close();
  });

  it('A→B→A 三段区间：事件 / 轨迹 latest / 事故 各自只见本人区间；解绑再绑回历史仍可见', async () => {
    // —— A1 ——
    await bindDevice(http, a.token, d);
    ev.aLoc1 = await relayOne(a.token, 'location_update', validLocation(1));
    ev.aRisk1 = await relayOne(a.token, 'collision_risk', {
      riskLevel: 'high',
    });
    ev.aStatus1 = await relayOne(a.token, 'device_status', {
      battery: 81,
      charging: false,
      firmwareVersion: '0.1.0-audit',
    });
    ev.aFall1 = await relayOne(a.token, 'possible_fall', { confidence: 0.9 });
    const active = await request(http)
      .get(`/api/v1/devices/${d}/sos/active`)
      .set(auth(a.token))
      .expect(200);
    sosA = active.body.sos.sosId as string;
    await request(http)
      .post(`/api/v1/sos/${sosA}/cancel`)
      .set(auth(a.token))
      .expect(200);
    await sleep(30);
    await unbind(a.token).expect(204);
    await sleep(30);

    // —— B1 ——
    await bindDevice(http, b.token, d);
    const bSeesBeforeRelay = await listEventIds(b.token);
    expect(bSeesBeforeRelay).toEqual([]);
    expect(await latestReceivedAt(b.token)).toBeNull();
    ev.bLoc1 = await relayOne(b.token, 'location_update', validLocation(2));
    ev.bRisk1 = await relayOne(b.token, 'obstacle_risk', {});
    ev.bStatus1 = await relayOne(b.token, 'device_status', {
      battery: 42,
      charging: true,
      firmwareVersion: '0.1.0-audit',
    });
    const bSees = await listEventIds(b.token);
    expect(bSees.sort()).toEqual([ev.bLoc1, ev.bRisk1, ev.bStatus1].sort());
    // B 看不到 A 期间的事件详情 / 事故
    await request(http)
      .get(`/api/v1/events/${ev.aRisk1}`)
      .set(auth(b.token))
      .expect(404);
    const bAccidents = await request(http)
      .get(`/api/v1/devices/${d}/accidents`)
      .set(auth(b.token))
      .expect(200);
    expect(bAccidents.body.total).toBe(0);
    await request(http)
      .get(`/api/v1/accidents/${sosA}`)
      .set(auth(b.token))
      .expect(404);
    evidence(
      LOG,
      `B1 期间：B 事件=${bSees.length} 条（仅自己 3 条）、latest 仅自己、A 的事故 404`,
    );
    await sleep(30);
    await unbind(b.token).expect(204);
    await sleep(30);

    // —— A2 ——
    await bindDevice(http, a.token, d);
    const aSeesBeforeRelay = await listEventIds(a.token);
    expect(aSeesBeforeRelay.sort()).toEqual(
      [ev.aLoc1, ev.aRisk1, ev.aStatus1, ev.aFall1].sort(),
    );
    // 解绑再绑回来：A1 的最后位置对 A 仍可见；B 的位置不可见
    const aLatest = await latestReceivedAt(a.token);
    const aLoc1Row = await prisma.locationPoint.findFirst({
      where: { eventId: ev.aLoc1 },
    });
    expect(aLatest).toBe(aLoc1Row?.receivedAt.toISOString());
    await request(http)
      .get(`/api/v1/events/${ev.bRisk1}`)
      .set(auth(a.token))
      .expect(404);
    await request(http)
      .get(`/api/v1/events/${ev.aRisk1}`)
      .set(auth(a.token))
      .expect(200);
    ev.aRisk2 = await relayOne(a.token, 'collision_risk', {
      riskLevel: 'medium',
    });
    const aSees = await listEventIds(a.token);
    expect(aSees).toContain(ev.aRisk2);
    expect(aSees).not.toContain(ev.bRisk1);
    expect(aSees).not.toContain(ev.bLoc1);
    const aAccidents = await request(http)
      .get(`/api/v1/devices/${d}/accidents`)
      .set(auth(a.token))
      .expect(200);
    expect(aAccidents.body.total).toBe(1);
    await request(http)
      .get(`/api/v1/accidents/${sosA}`)
      .set(auth(a.token))
      .expect(200);

    [A1, A2] = await intervalsOf(a.id);
    [B1] = await intervalsOf(b.id);
    expect(A1.unboundAt).not.toBeNull();
    expect(B1.unboundAt).not.toBeNull();
    expect(A2.unboundAt).toBeNull();
    evidence(
      LOG,
      `A2 期间：A 事件=${aSees.length} 条（A1 4 + A2 1，不含 B 3 条）、latest=A1 最后点、事故 1 条；区间 A1=[${A1.boundAt.toISOString()},${A1.unboundAt?.toISOString()}] B1=[${B1.boundAt.toISOString()},${B1.unboundAt?.toISOString()}] A2=[${A2.boundAt.toISOString()},∞)`,
    );
  });

  it('边界时刻（SQL 精确置 receivedAt）：区间端点闭区间归属；间隙时刻无人可见', async () => {
    const at = (t: Date, deltaMs: number): Date =>
      new Date(t.getTime() + deltaMs);
    const cases: Array<[string, Date, boolean]> = [
      ['receivedAt = A1.unboundAt', A1.unboundAt!, true],
      ['receivedAt = A1.unboundAt + 1ms（间隙）', at(A1.unboundAt!, 1), false],
      ['receivedAt = B1.boundAt', B1.boundAt, false],
      ['receivedAt = B1.unboundAt', B1.unboundAt!, false],
      ['receivedAt = A2.boundAt - 1ms（间隙）', at(A2.boundAt, -1), false],
      ['receivedAt = A2.boundAt', A2.boundAt, true],
      ['receivedAt = A1.boundAt', A1.boundAt, true],
      ['receivedAt = A1.boundAt - 1ms（绑定前）', at(A1.boundAt, -1), false],
    ];
    const visible = new Set(await listEventIds(a.token));
    const created: Array<[string, string, boolean]> = [];
    for (const [label, receivedAt, expectVisible] of cases) {
      const id = await insertRaw('risk_cleared', receivedAt, receivedAt);
      created.push([label, id, expectVisible]);
    }
    const now = new Set(await listEventIds(a.token));
    for (const [label, id, expectVisible] of created) {
      const seen = now.has(id) && !visible.has(id);
      const detail = await request(http)
        .get(`/api/v1/events/${id}`)
        .set(auth(a.token));
      evidence(
        LOG,
        `边界 ${label} → 列表${seen ? '可见' : '不可见'} / 详情 ${detail.status}（期望${expectVisible ? '可见' : '不可见'}）`,
      );
      expect(`${label} list=${seen}`).toBe(`${label} list=${expectVisible}`);
      expect(`${label} detail=${detail.status}`).toBe(
        `${label} detail=${expectVisible ? 200 : 404}`,
      );
    }
    // 轨迹 latest：receivedAt 恰在 A1.unboundAt 且 timestamp 最新 → 是 A 的 latest；B1.boundAt 那条不是
    const pointAt = async (
      receivedAt: Date,
      tsOffsetMs: number,
    ): Promise<string> => {
      const eventId = randomUUID();
      await prisma.locationPoint.create({
        data: {
          eventId,
          deviceId: d,
          timestamp: new Date(Date.now() + tsOffsetMs),
          receivedAt,
          latitude: 31.2,
          longitude: 121.5,
          coordinateSystem: 'gcj02',
          accuracy: 5,
          speed: 0,
          heading: 0,
        },
      });
      return eventId;
    };
    const edgeA = await pointAt(A1.unboundAt!, 60_000);
    const edgeB = await pointAt(B1.boundAt, 120_000);
    const latest = await latestReceivedAt(a.token);
    evidence(
      LOG,
      `轨迹 latest：A1.unboundAt 点 vs B1.boundAt 点（timestamp 更新）→ A 看到 receivedAt=${latest}`,
    );
    expect(latest).toBe(A1.unboundAt!.toISOString());
    await prisma.locationPoint.deleteMany({
      where: { eventId: { in: [edgeA, edgeB] } },
    });
  });

  it('晚到 / 离线补传：按 receivedAt 归属（契约口径）——设备时间在 B 期间的事件，现在到达即归 A（风险单列）', async () => {
    // ① 经真实入口（app-relay，A 当前绑定）：timestamp 落在 B1 区间内
    const tsInB = new Date(
      (B1.boundAt.getTime() + B1.unboundAt!.getTime()) / 2,
    );
    const lateViaRelay = await relayOne(
      a.token,
      'obstacle_risk',
      {},
      { timestamp: tsInB.toISOString() },
    );
    const aSees = await listEventIds(a.token);
    const row = await prisma.rawEvent.findFirst({
      where: { eventId: lateViaRelay },
    });
    evidence(
      LOG,
      `晚到①（relay，timestamp 在 B1 内、receivedAt 在 A2 内）→ A 列表${aSees.includes(lateViaRelay) ? '可见' : '不可见'}，clockSkew=${row?.clockSkew}`,
    );
    expect(aSees).toContain(lateViaRelay);
    // ② 反向：timestamp 在 A1 内、receivedAt 在 B1 内（模拟 4G 设备离线补传落在 B 期间）→ A 不可见
    const tsInA1 = new Date(
      (A1.boundAt.getTime() + A1.unboundAt!.getTime()) / 2,
    );
    const rxInB1 = new Date(
      (B1.boundAt.getTime() + B1.unboundAt!.getTime()) / 2,
    );
    const lateToB = await insertRaw('obstacle_risk', tsInA1, rxInB1);
    const aSees2 = await listEventIds(a.token);
    evidence(
      LOG,
      `晚到②（timestamp 在 A1 内、receivedAt 在 B1 内）→ A 列表${aSees2.includes(lateToB) ? '可见' : '不可见'}（契约：归 B；A 自己骑行期间的事件丢给了 B——风险记录）`,
    );
    expect(aSees2).not.toContain(lateToB);
    // 轨迹同口径：timestamp 在 A1、receivedAt 在 B1 的点对 A 不可见
    const eventId = randomUUID();
    await prisma.locationPoint.create({
      data: {
        eventId,
        deviceId: d,
        timestamp: tsInA1,
        receivedAt: rxInB1,
        latitude: 31.21,
        longitude: 121.51,
        coordinateSystem: 'gcj02',
        accuracy: 5,
        speed: 0,
        heading: 0,
      },
    });
    const range = await request(http)
      .get(
        `/api/v1/devices/${d}/locations?from=${new Date(tsInA1.getTime() - 1000).toISOString()}&to=${new Date(tsInA1.getTime() + 1000).toISOString()}`,
      )
      .set(auth(a.token))
      .expect(200);
    const hit = (range.body.items as Array<{ receivedAt: string }>).filter(
      (p) => p.receivedAt === rxInB1.toISOString(),
    );
    evidence(
      LOG,
      `轨迹 range（timestamp 在 A1、receivedAt 在 B1）→ 窗口内共 ${range.body.total} 条，其中该点 ${hit.length} 条（契约 0；其余为 A1 自己的点）`,
    );
    expect(hit).toHaveLength(0);
    await prisma.locationPoint.deleteMany({ where: { eventId } });
  });

  it('【AUTH-06 缺陷断言】battery-history 不按绑定区间过滤：A 能看到 B 期间的电量点（决策 #39 隐私意图；§4 契约未明列）', async () => {
    const bStatusRow = await prisma.rawEvent.findFirst({
      where: { eventId: ev.bStatus1 },
    });
    const points = await batteryTimestamps(a.token);
    const leaked = points.filter(
      (t) => t === bStatusRow?.timestamp.toISOString(),
    );
    // 再补一条：timestamp 在 A2 内但 receivedAt 在 B1 内（battery-history 只按设备 timestamp 过滤）
    const tsNow = new Date();
    const rxInB1 = new Date(
      (B1.boundAt.getTime() + B1.unboundAt!.getTime()) / 2,
    );
    await insertRaw('device_status', tsNow, rxInB1, {
      battery: 7,
      charging: false,
    });
    const points2 = await batteryTimestamps(a.token);
    const leaked2 =
      points2.includes(tsNow.toISOString()) || points2.length > points.length;
    evidence(
      LOG,
      `battery-history（A 当前绑定）：B1 期间 device_status(battery=42) 点${leaked.length ? '出现' : '未出现'}；receivedAt 在 B1 内的点${leaked2 ? '出现' : '未出现'}（devices.service.ts batteryHistory 未接 BindingScope，且按设备 timestamp 而非 receivedAt 过滤）`,
    );
    expect(leaked).toHaveLength(0);
    expect(leaked2).toBe(false);
  });

  it('绑定竞态（旧报告 #10 复验）：6 用户并发绑同一台 → 恰 1 个 200，其余 409，绑定区间只开 1 段', async () => {
    for (let i = 0; i < 6; i += 1) raceUsers.push(await createUser(app, http));
    const results = await Promise.all(
      raceUsers.map((u) =>
        request(http)
          .post('/api/v1/devices/bind')
          .set(auth(u.token))
          .send({ deviceId: raceDevice, bindCode: `bc_${raceDevice}` }),
      ),
    );
    const statuses = results.map((r) => r.status);
    evidence(LOG, `并发绑定 ×6 → ${hist(statuses)}`);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
    const winnerIdx = statuses.indexOf(200);
    const dev = await prisma.device.findUnique({
      where: { deviceId: raceDevice },
    });
    expect(dev?.bindUserId).toBe(raceUsers[winnerIdx].id);
    expect(
      await prisma.deviceBinding.count({ where: { deviceId: raceDevice } }),
    ).toBe(1);
    // 并发解绑 + 绑定：解绑者与再绑者同时操作，区间不会出现两段同时 open
    await Promise.all([
      request(http)
        .delete(`/api/v1/devices/${raceDevice}/binding`)
        .set(auth(raceUsers[winnerIdx].token)),
      request(http)
        .post('/api/v1/devices/bind')
        .set(auth(raceUsers[(winnerIdx + 1) % 6].token))
        .send({ deviceId: raceDevice, bindCode: `bc_${raceDevice}` }),
    ]);
    const open = await prisma.deviceBinding.count({
      where: { deviceId: raceDevice, unboundAt: null },
    });
    const devAfter = await prisma.device.findUnique({
      where: { deviceId: raceDevice },
    });
    evidence(
      LOG,
      `并发解绑+再绑 → open 区间=${open}，bindUserId=${devAfter?.bindUserId ? '有' : '空'}`,
    );
    expect(open).toBeLessThanOrEqual(1);
    expect(open).toBe(devAfter?.bindUserId ? 1 : 0);
  });
});
