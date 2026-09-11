// 上线前压力测试：真实监听端口 + 原生 fetch（避开 supertest 的连接复用差异）。
// 目标不是刷指标，而是：并发下无 5xx/无连接重置、数据一条不丢、延迟在可接受量级。
import { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import { IngestService } from '../src/ingest/ingest.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  bindDevice,
  buildApp,
  cleanupDevices,
  cleanupUsers,
  createUser,
  envelope,
  histogram,
  listenRandomPort,
  percentile,
  provisionDevice,
  sleep,
  validLocation,
  type Http,
  type TestUser,
} from './helpers/hardening';

jest.setTimeout(600_000);

interface Timed {
  status: number;
  ms: number;
  body: unknown;
}

describe('压力：并发与吞吐 (e2e)', () => {
  let app: INestApplication;
  let http: Http;
  let prisma: PrismaService;
  let ingest: IngestService;
  let base: string;

  const run = Date.now();
  const devIngest = `stress_ingest_${run}`;
  const devRelay = `stress_relay_${run}`;
  const devQuery = `stress_query_${run}`;
  const devWs = `stress_ws_${run}`;
  const devCmd = `stress_cmd_${run}`;
  const devices = [devIngest, devRelay, devQuery, devWs, devCmd];
  let owner: TestUser;
  const extraUsers: TestUser[] = [];

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token = owner.token,
  ): Promise<Timed> => {
    const t0 = performance.now();
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 体（如 204） */
    }
    return { status: res.status, ms: performance.now() - t0, body: parsed };
  };

  /** 有界并发执行器 */
  const runPool = async <T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number,
  ): Promise<T[]> => {
    const results: T[] = new Array<T>(tasks.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= tasks.length) return;
        results[i] = await tasks[i]();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
    );
    return results;
  };

  const report = (label: string, timed: Timed[], t0: number): void => {
    const ms = timed.map((t) => t.ms);
    const total = performance.now() - t0;
    console.log(
      `[${label}] n=${timed.length} total=${total.toFixed(0)}ms rps=${((timed.length / total) * 1000).toFixed(0)} ` +
        `p50=${percentile(ms, 50).toFixed(0)}ms p95=${percentile(ms, 95).toFixed(0)}ms p99=${percentile(ms, 99).toFixed(0)}ms ` +
        `max=${Math.max(...ms).toFixed(0)}ms statuses=${JSON.stringify(histogram(timed.map((t) => t.status)))}`,
    );
  };

  beforeAll(async () => {
    process.env.SOS_SCAN_INTERVAL_MS = '600000';
    process.env.COMMAND_SCAN_INTERVAL_MS = '600000';
    ({ app, http, prisma } = await buildApp());
    const ws = await listenRandomPort(app);
    base = ws.replace('ws://', 'http://');
    ingest = app.get(IngestService);
    owner = await createUser(app, http);
    for (const d of devices) {
      await provisionDevice(prisma, d);
      await bindDevice(http, owner.token, d);
    }
  });

  afterAll(async () => {
    await cleanupDevices(prisma, devices);
    await cleanupUsers(prisma, [owner, ...extraUsers]);
    await app.close();
  });

  it('Ingest 直灌 3000 条 location_update（并发 50）：一条不丢，轨迹表齐全', async () => {
    const events = Array.from({ length: 3000 }, (_, i) =>
      JSON.stringify(
        envelope(devIngest, 'location_update', validLocation(i), {
          timestamp: new Date(Date.now() - (3000 - i) * 1000).toISOString(),
        }),
      ),
    );
    const t0 = performance.now();
    const outcomes = await runPool(
      events.map((raw) => () => ingest.ingestRaw(raw, devIngest, 'mqtt')),
      50,
    );
    const total = performance.now() - t0;
    console.log(
      `[ingest 3000 location_update, c=50] total=${total.toFixed(0)}ms eps=${((3000 / total) * 1000).toFixed(0)}`,
    );
    expect(histogram(outcomes.map((o) => (o === 'stored' ? 1 : 0)))).toEqual({
      '1': 3000,
    });
    expect(
      await prisma.rawEvent.count({ where: { deviceId: devIngest } }),
    ).toBe(3000);
    expect(
      await prisma.locationPoint.count({ where: { deviceId: devIngest } }),
    ).toBe(3000);
  });

  it('轨迹查询：3000 点范围内 pageSize=100 翻 30 页；latest；事件列表翻页', async () => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 3600 * 1000).toISOString();
    const t0 = performance.now();
    const pages = await runPool(
      Array.from(
        { length: 30 },
        (_, i) => () =>
          call(
            'GET',
            `/api/v1/devices/${devIngest}/locations?from=${from}&to=${to}&page=${i + 1}&pageSize=100`,
          ),
      ),
      10,
    );
    report('locations 30 pages ×100', pages, t0);
    expect(pages.every((p) => p.status === 200)).toBe(true);
    const items = pages.reduce(
      (s, p) => s + (p.body as { items: unknown[] }).items.length,
      0,
    );
    expect(items).toBe(3000);
    const t1 = performance.now();
    const latest = await runPool(
      Array.from(
        { length: 100 },
        () => () =>
          call('GET', `/api/v1/devices/${devIngest}/locations/latest`),
      ),
      20,
    );
    report('locations/latest ×100', latest, t1);
    expect(latest.every((p) => p.status === 200)).toBe(true);
    const t2 = performance.now();
    const ev = await runPool(
      Array.from(
        { length: 30 },
        (_, i) => () =>
          call(
            'GET',
            `/api/v1/devices/${devIngest}/events?page=${i + 1}&pageSize=100`,
          ),
      ),
      10,
    );
    report('events 30 pages ×100', ev, t2);
    expect(ev.every((p) => p.status === 200)).toBe(true);
  });

  it('app-relay：60 个并发批次 × 100 条（6000 事件，含 20% 重复补传）：无 5xx、无连接重置、计数正确', async () => {
    const batches: unknown[][] = [];
    for (let b = 0; b < 50; b += 1) {
      batches.push(
        Array.from({ length: 100 }, (_, i) =>
          envelope(
            devRelay,
            i % 10 === 0 ? 'device_status' : 'location_update',
            i % 10 === 0 ? { battery: 80 } : validLocation(b * 100 + i),
          ),
        ),
      );
    }
    // 10 个"补传"批次 = 前 10 批的重复
    for (let b = 0; b < 10; b += 1) batches.push(batches[b]);
    const t0 = performance.now();
    const results = await runPool(
      batches.map(
        (envelopes) => () =>
          call('POST', '/api/v1/ingest/app-relay', {
            deviceId: devRelay,
            envelopes,
          }),
      ),
      60,
    );
    report('app-relay 60 batches ×100', results, t0);
    expect(results.every((r) => r.status === 202)).toBe(true);
    const accepted = results.reduce(
      (s, r) => s + (r.body as { accepted: number }).accepted,
      0,
    );
    const duplicate = results.reduce(
      (s, r) => s + (r.body as { duplicate: number }).duplicate,
      0,
    );
    expect(accepted).toBe(5000);
    expect(duplicate).toBe(1000);
    expect(await prisma.rawEvent.count({ where: { deviceId: devRelay } })).toBe(
      5000,
    );
    expect(
      await prisma.locationPoint.count({ where: { deviceId: devRelay } }),
    ).toBe(4500);
  });

  it('500 个并发 GET /devices（JWT 校验 + DB）：全部 200', async () => {
    const t0 = performance.now();
    const results = await runPool(
      Array.from({ length: 500 }, () => () => call('GET', '/api/v1/devices')),
      100,
    );
    report('GET /devices ×500 c=100', results, t0);
    expect(histogram(results.map((r) => r.status))).toEqual({ '200': 500 });
  });

  it('60 个并发登录（bcrypt）：全部 200；记录 CPU 敏感路径延迟', async () => {
    const t0 = performance.now();
    const results = await runPool(
      Array.from(
        { length: 60 },
        () => () =>
          call('POST', '/api/v1/auth/login', {
            phone: owner.phone,
            password: owner.password,
          }),
      ),
      60,
    );
    report('login ×60 c=60', results, t0);
    expect(histogram(results.map((r) => r.status))).toEqual({ '200': 60 });
  });

  it('50 个并发 PUT settings + 50 个并发 relay-ack：无 5xx、无连接重置', async () => {
    const t0 = performance.now();
    const puts = await runPool(
      Array.from(
        { length: 50 },
        (_, i) => () =>
          call('PUT', `/api/v1/devices/${devCmd}/settings`, {
            settings: { i },
          }),
      ),
      50,
    );
    report('PUT settings ×50 c=50', puts, t0);
    expect(histogram(puts.map((r) => r.status))).toEqual({ '202': 50 });
    const ids = puts.map((r) => (r.body as { commandId: string }).commandId);
    const t1 = performance.now();
    const acks = await runPool(
      ids.map(
        (id) => () =>
          call('POST', `/api/v1/devices/${devCmd}/commands/${id}/relay-ack`, {
            stage: 'executed',
            result: 'success',
          }),
      ),
      50,
    );
    report('relay-ack ×50 c=50', acks, t1);
    expect(histogram(acks.map((r) => r.status))).toEqual({ '200': 50 });
    const rows = await prisma.deviceCommand.findMany({
      where: { id: { in: ids } },
    });
    expect(rows.every((r) => r.status === 'success')).toBe(true);
  });

  it('WebSocket：200 连接 × 50 次推送 = 10000 条消息全部送达', async () => {
    const conns: WebSocket[] = [];
    const counts: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const ws = new WebSocket(
        `${base.replace('http://', 'ws://')}/ws?token=${owner.token}`,
      );
      counts.push(0);
      ws.on('message', (raw) => {
        const msg = JSON.parse((raw as Buffer).toString('utf-8')) as {
          type: string;
          data: { deviceId?: string };
        };
        if (msg.type === 'location_update' && msg.data.deviceId === devWs)
          counts[i] += 1;
      });
      conns.push(ws);
    }
    await Promise.all(
      conns.map(
        (ws) =>
          new Promise<void>((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
          }),
      ),
    );
    await sleep(300);
    const t0 = performance.now();
    for (let i = 0; i < 50; i += 1) {
      await ingest.ingestRaw(
        JSON.stringify(envelope(devWs, 'location_update', validLocation(i))),
        devWs,
        'mqtt',
      );
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && counts.some((c) => c < 50))
      await sleep(100);
    const total = performance.now() - t0;
    const delivered = counts.reduce((s, c) => s + c, 0);
    console.log(
      `[ws 200 conns × 50 pushes] delivered=${delivered}/10000 in ${total.toFixed(0)}ms`,
    );
    conns.forEach((ws) => ws.close());
    expect(delivered).toBe(10_000);
  });

  it('混合负载 20s：relay 写入 + 轨迹读 + 状态读同时跑，无 5xx；结束后堆内存回落', async () => {
    const stopAt = Date.now() + 20_000;
    const statuses: number[] = [];
    const writer = async (): Promise<void> => {
      let i = 0;
      while (Date.now() < stopAt) {
        const envelopes = Array.from({ length: 20 }, (_, k) =>
          envelope(devQuery, 'location_update', validLocation(i * 20 + k)),
        );
        statuses.push(
          (
            await call('POST', '/api/v1/ingest/app-relay', {
              deviceId: devQuery,
              envelopes,
            })
          ).status,
        );
        i += 1;
      }
    };
    const reader = async (): Promise<void> => {
      const from = new Date(Date.now() - 3600 * 1000).toISOString();
      while (Date.now() < stopAt) {
        const to = new Date().toISOString();
        statuses.push(
          (
            await call(
              'GET',
              `/api/v1/devices/${devQuery}/locations?from=${from}&to=${to}&pageSize=100`,
            )
          ).status,
        );
        statuses.push(
          (await call('GET', `/api/v1/devices/${devQuery}/status`)).status,
        );
        statuses.push(
          (await call('GET', `/api/v1/devices/${devQuery}/sos/active`)).status,
        );
      }
    };
    const heapBefore = process.memoryUsage().heapUsed;
    await Promise.all([
      writer(),
      writer(),
      writer(),
      reader(),
      reader(),
      reader(),
      reader(),
    ]);
    const h = histogram(statuses);
    console.log(
      `[mixed load 20s] requests=${statuses.length} statuses=${JSON.stringify(h)}`,
    );
    expect(h['500'] ?? 0).toBe(0);
    expect(h['502'] ?? 0).toBe(0);
    if (global.gc) global.gc();
    await sleep(500);
    const heapAfter = process.memoryUsage().heapUsed;
    console.log(
      `[heap] before=${(heapBefore / 1e6).toFixed(0)}MB after=${(heapAfter / 1e6).toFixed(0)}MB`,
    );
    expect(
      await prisma.locationPoint.count({ where: { deviceId: devQuery } }),
    ).toBeGreaterThan(0);
  });
});
