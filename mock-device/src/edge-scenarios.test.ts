// 剧本入口 index.ts 一导入就连 Broker、起定时器，没法在进程内单测。这里把它当黑盒：
// 起真实子进程（node src/index.ts，与 npm start 完全一致）连到假 Broker，从线上字节反推剧本行为。
// 顺带钉住两件事：入口文件能被 Node 24 原生类型剥离直接跑起来；环境变量给错值时回退默认而不是带病运行。
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BLE_RELAY_EVENT_TYPES, CURRENT_SCHEMA_VERSION, EVENT_TYPES } from '@helmet/shared';
import { FakeBroker, waitFor } from './test/fake-broker.ts';

const MOCK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// 开发机 shell 里可能留着联调用的变量，子进程只认用例显式给的
const MOCK_ENV_KEYS = [
  'MQTT_URL', 'DEVICE_ID', 'DEVICE_SECRET', 'FIRMWARE_VERSION', 'LOCATION_INTERVAL_MS', 'STATUS_INTERVAL_MS',
  'TRANSPORT', 'MOCK_CMD_RESULT', 'SCENARIO', 'EMERGENCY_AFTER_POINTS', 'NODE_TEST_CONTEXT',
];

interface Envelope {
  schemaVersion: number;
  eventId: string;
  deviceId: string;
  eventType: string;
  timestamp: string;
  firmwareVersion: string;
  payload: Record<string, unknown>;
}

interface Running {
  child: ChildProcess;
  broker: FakeBroker;
  output: () => string;
  /** 某个 Topic 后缀（status / location / event / cmd_ack）下收到的全部 envelope，按到达顺序 */
  on: (kind: string) => Envelope[];
  /** 该事件到达 Broker 之前已经到达的位置点个数——按到达顺序数，不受轮询时机影响 */
  pointsBefore: (e: Envelope) => number;
  exited: Promise<number | null>;
}

async function run(deviceId: string, env: Record<string, string>, sharedBroker?: { broker: FakeBroker; url: string }): Promise<Running> {
  const broker = sharedBroker?.broker ?? new FakeBroker();
  const url = sharedBroker?.url ?? (await broker.listen());
  const base: Record<string, string | undefined> = { ...process.env };
  for (const key of MOCK_ENV_KEYS) delete base[key];
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: MOCK_ROOT,
    env: { ...base, MQTT_URL: url, DEVICE_ID: deviceId, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => (output += d.toString('utf-8')));
  child.stderr?.on('data', (d: Buffer) => (output += d.toString('utf-8')));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    broker,
    output: () => output,
    on: (kind) => broker.publishesTo(`helmet/${deviceId}/${kind}`).map((p) => JSON.parse(p.payload) as Envelope),
    pointsBefore: (e) => {
      const mine = broker.publishes.filter((p) => p.topic.startsWith(`helmet/${deviceId}/`));
      const index = mine.findIndex((p) => p.payload.includes(e.eventId));
      return mine.slice(0, index).filter((p) => p.topic.endsWith('/location')).length;
    },
    exited,
  };
}

async function shutdown(r: Running, closeBroker = true): Promise<void> {
  if (r.child.exitCode === null) r.child.kill('SIGKILL');
  await r.exited;
  if (closeBroker) await r.broker.close();
}

/** EVENTS.md §1：恰好 7 个字段，服务端生成的 receivedAt / source 不由设备上传 */
function assertEnvelope(e: Envelope, deviceId: string, firmwareVersion: string): void {
  assert.deepEqual(
    Object.keys(e).sort(),
    ['deviceId', 'eventId', 'eventType', 'firmwareVersion', 'payload', 'schemaVersion', 'timestamp'],
  );
  assert.equal(e.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.match(e.eventId, UUID_V4);
  assert.equal(e.deviceId, deviceId);
  assert.ok((EVENT_TYPES as readonly string[]).includes(e.eventType), e.eventType);
  assert.match(e.timestamp, ISO_UTC);
  assert.ok(Math.abs(Date.parse(e.timestamp) - Date.now()) < 60_000, '设备侧时间应是当前时刻');
  assert.equal(e.firmwareVersion, firmwareVersion);
  assert.equal(typeof e.payload, 'object');
}

/** EVENTS.md 4.2：必填字段齐全、类型与值域正确 */
function assertLocationPayload(p: Record<string, unknown>): void {
  const num = (k: string): number => {
    assert.equal(typeof p[k], 'number', k);
    assert.ok(Number.isFinite(p[k] as number), k);
    return p[k] as number;
  };
  assert.ok(Math.abs(num('latitude')) <= 90);
  assert.ok(Math.abs(num('longitude')) <= 180);
  assert.equal(p.coordinateSystem, 'wgs84');
  assert.ok(num('accuracy') >= 0);
  assert.ok(num('speed') >= 0);
  assert.ok(num('heading') >= 0 && num('heading') <= 360);
}

describe('Mock 剧本（子进程黑盒，MQTT 链路）', { concurrency: true }, () => {
  it('环境变量全给错值 → 逐项回退默认：骑行剧本、5s / 60s、mqtt 传输、命令照常回 success；SIGINT 干净退出', async () => {
    const id = 'helmet_env_bad';
    const r = await run(id, {
      SCENARIO: 'Fall', // 大小写不对也不认
      TRANSPORT: 'relay',
      MOCK_CMD_RESULT: 'FAILED',
      LOCATION_INTERVAL_MS: '0', // 0 会被 setInterval 钳成 1ms，等于对 Broker 洪水攻击
      STATUS_INTERVAL_MS: 'abc',
      EMERGENCY_AFTER_POINTS: '0',
    });
    try {
      await waitFor(() => r.on('status').length >= 1 && r.on('location').length >= 1, '首条心跳与位置');
      assert.ok(r.output().includes('开始骑行剧本（位置每 5s / 心跳每 60s）'), r.output());
      assert.deepEqual(r.broker.connects, [{ clientId: id, username: id, password: 'mock_secret' }]);

      const status = r.on('status')[0];
      assertEnvelope(status, id, '0.1.0-mock');
      assert.equal(status.eventType, 'device_status');
      assert.deepEqual(status.payload, { battery: 100, charging: false, sleeping: false });

      const loc = r.on('location')[0];
      assertEnvelope(loc, id, '0.1.0-mock');
      assert.equal(loc.eventType, 'location_update');
      assertLocationPayload(loc.payload);
      assert.equal('altitude' in loc.payload, false, '骑行剧本不带海拔（也不能是 null / undefined 字段）');

      r.broker.publish(`helmet/${id}/cmd`, JSON.stringify({ commandId: 'c_env_000001', type: 'set_config', params: { volume: 50 } }));
      await waitFor(() => r.broker.publishesTo(`helmet/${id}/cmd_ack`).length === 1, '命令回执');
      const ack = JSON.parse(r.broker.publishesTo(`helmet/${id}/cmd_ack`)[0].payload) as Record<string, unknown>;
      assert.equal(ack.result, 'success');

      // 间隔若真按 0 / NaN 生效，这几百毫秒里早已刷出上百个点；留 1 个点的余量给慢机器
      assert.ok(r.on('location').length <= 2, `位置点 ${r.on('location').length} 个`);
      assert.ok(r.on('status').length <= 2, `心跳 ${r.on('status').length} 条`);
      assert.equal(r.on('event').length, 0);

      r.child.kill('SIGINT');
      await waitFor(() => r.child.exitCode !== null, '子进程退出');
      assert.equal(r.child.exitCode, 0);
      await waitFor(() => r.broker.disconnects === 1, '退出前发 MQTT DISCONNECT，而不是直接断 TCP');
    } finally {
      await shutdown(r);
    }
  });

  it('上报间隔的取值边界：499 / Infinity / 空串回退默认，500（下限）/ 1e3 / 带空格的数字生效', async () => {
    const broker = new FakeBroker();
    const url = await broker.listen();
    const cases: Array<[string, string, string]> = [
      ['499', '位置每 5s', 'helmet_iv_499'],
      ['Infinity', '位置每 5s', 'helmet_iv_inf'],
      ['', '位置每 5s', 'helmet_iv_empty'],
      ['-1000', '位置每 5s', 'helmet_iv_neg'],
      ['500', '位置每 0.5s', 'helmet_iv_500'],
      ['1e3', '位置每 1s', 'helmet_iv_1e3'],
      [' 2000 ', '位置每 2s', 'helmet_iv_space'],
    ];
    const runs = await Promise.all(
      cases.map(([value, , id]) => run(id, { LOCATION_INTERVAL_MS: value, STATUS_INTERVAL_MS: value }, { broker, url })),
    );
    try {
      await Promise.all(
        runs.map((r, i) => waitFor(() => r.output().includes('开始骑行剧本'), `${cases[i][2]} 启动`)),
      );
      runs.forEach((r, i) => {
        const [value, expected] = cases[i];
        assert.ok(r.output().includes(expected), `LOCATION_INTERVAL_MS=${JSON.stringify(value)} → ${r.output()}`);
        // 心跳与位置共用同一个解析函数，但默认值不同（60s）：回退时不能串成位置的默认
        const statusExpected = expected === '位置每 5s' ? '心跳每 60s' : expected.replace('位置', '心跳');
        assert.ok(r.output().includes(statusExpected), `STATUS_INTERVAL_MS=${JSON.stringify(value)} → ${r.output()}`);
      });
    } finally {
      await Promise.all(runs.map((r) => shutdown(r, false)));
      await broker.close();
    }
  });

  it('SCENARIO=fall：发满 N 个位置点后恰好触发一次 possible_fall（走 event Topic），位置快照取触发时那一点；之后不再重复触发', async () => {
    const id = 'helmet_fall';
    const r = await run(id, { SCENARIO: 'fall', EMERGENCY_AFTER_POINTS: '2', LOCATION_INTERVAL_MS: '500', FIRMWARE_VERSION: '9.9.9' });
    try {
      await waitFor(() => r.on('event').length >= 1, 'possible_fall');
      const locations = r.on('location');
      const fall = r.on('event')[0];
      assert.equal(r.pointsBefore(fall), 2, '第 2 个位置点之后才触发，不早不晚');
      assertEnvelope(fall, id, '9.9.9');
      assert.equal(fall.eventType, 'possible_fall');
      assert.deepEqual(fall.payload.location, {
        latitude: locations[1].payload.latitude,
        longitude: locations[1].payload.longitude,
        coordinateSystem: 'wgs84',
        accuracy: 8,
      });
      const confidence = fall.payload.confidence as number;
      assert.ok(confidence >= 0 && confidence <= 1);
      assert.equal(typeof fall.payload.algorithmVersion, 'string');

      await waitFor(() => r.on('location').length >= 4, '再走两个点');
      assert.equal(r.on('event').length, 1, '同一次运行只摔一次（重放靠重启）');
      const ids = [...r.on('location'), ...r.on('event'), ...r.on('status')].map((e) => e.eventId);
      assert.equal(new Set(ids).size, ids.length, 'eventId 全程不重复');
    } finally {
      await shutdown(r);
    }
  });

  it('SCENARIO=sos + EMERGENCY_AFTER_POINTS=1（下限）：首个位置点后立刻 manual_sos；非整数 / 负数的触发点回退默认 5', async () => {
    const sos = await run('helmet_sos', { SCENARIO: 'sos', EMERGENCY_AFTER_POINTS: '1', LOCATION_INTERVAL_MS: '500' });
    const bad = await run('helmet_sos_bad', { SCENARIO: 'sos', EMERGENCY_AFTER_POINTS: '1.5', LOCATION_INTERVAL_MS: '500' });
    try {
      await waitFor(() => sos.on('event').length >= 1, 'manual_sos');
      const e = sos.on('event')[0];
      assert.equal(sos.pointsBefore(e), 1);
      assert.equal(e.eventType, 'manual_sos');
      assert.equal(e.payload.triggerMode, 'long_press');
      assert.ok(Number.isInteger(e.payload.pressDurationMs));
      assert.equal((e.payload.location as Record<string, unknown>).coordinateSystem, 'wgs84');

      // 1.5 不是合法的点数：按默认 5 个点触发，而不是在第 1 或第 2 个点就触发
      await waitFor(() => bad.on('event').length >= 1, '回退默认触发点的 manual_sos');
      assert.equal(bad.pointsBefore(bad.on('event')[0]), 5);
    } finally {
      await shutdown(sos);
      await shutdown(bad);
    }
  });

  it('SCENARIO=ski：位置带海拔（保留 1 位小数），从 2110m 起滑、逐点下降', async () => {
    const r = await run('helmet_ski', { SCENARIO: 'ski', LOCATION_INTERVAL_MS: '500' });
    try {
      await waitFor(() => r.on('location').length >= 3, '三个滑雪位置点');
      assert.ok(r.output().includes('开始滑雪剧本'));
      const points = r.on('location').slice(0, 3).map((e) => e.payload);
      points.forEach(assertLocationPayload);
      const altitudes = points.map((p) => p.altitude as number);
      assert.equal(altitudes[0], 2110);
      assert.ok(altitudes[0] > altitudes[1] && altitudes[1] > altitudes[2], JSON.stringify(altitudes));
      for (const a of altitudes) assert.equal(Number(a.toFixed(1)), a);
      assert.equal(r.on('event').length, 0, '滑雪剧本不触发紧急事件');
    } finally {
      await shutdown(r);
    }
  });

  it('SCENARIO=risk：第 8 个点发 collision_risk，再过 2 个点 risk_cleared 精确指向它，并跟一条关联的 video_ready', async () => {
    const id = 'helmet_risk';
    const r = await run(id, { SCENARIO: 'risk', LOCATION_INTERVAL_MS: '500' });
    try {
      await waitFor(() => r.on('event').length >= 3, '预警 → 解除 → 录像就绪', 20_000);
      const [risk, cleared, video] = r.on('event');
      assert.equal(risk.eventType, 'collision_risk');
      assertEnvelope(risk, id, '0.1.0-mock');
      assert.equal(r.pointsBefore(risk), 8);
      assert.equal(risk.payload.riskLevel, 'high');
      assert.equal(risk.payload.objectType, 'vehicle');
      assert.equal(risk.payload.direction, 'rear');
      assert.ok((risk.payload.distance as number) >= 0);

      assert.equal(cleared.eventType, 'risk_cleared');
      assert.equal(r.pointsBefore(cleared), 10);
      assert.deepEqual(cleared.payload, { clearedEventId: risk.eventId });

      assert.equal(video.eventType, 'video_ready');
      assert.equal(video.payload.relatedEventId, risk.eventId);
      assert.equal(video.payload.videoId, `vid_${risk.eventId.slice(0, 8)}`);
      assert.equal(video.payload.storageKey, `mock/${id}/${video.payload.videoId as string}.mp4`);
      assert.ok(Number.isInteger(video.payload.duration) && Number.isInteger(video.payload.sizeBytes));

      // video_ready 不在蓝牙版 7 种范围内——这条剧本在 MQTT 链路才完整，中转链路会在本地过滤掉它
      assert.equal((BLE_RELAY_EVENT_TYPES as readonly string[]).includes('video_ready'), false);
    } finally {
      await shutdown(r);
    }
  });
});
