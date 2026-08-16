// Mock Device Simulator v1：假扮真头盔连 EMQX，按 docs/EVENTS.md 持续发
// device_status 心跳 + location_update 骑行剧本。对 Backend 完全不可区分。
import { connect } from 'mqtt';
import type { EventPayloadMap, EventType } from '@helmet/shared';
import { buildEnvelope } from './envelope.ts';
import {
  RIDING_LOOP,
  buildSkiLoop,
  distanceMeters,
  expandRoute,
  headingDegrees,
} from './route.ts';

const MQTT_URL = process.env.MQTT_URL ?? 'mqtt://localhost:1883';
const DEVICE_ID = process.env.DEVICE_ID ?? 'helmet_mock_001';
// 真机凭证机制的占位（DEVICE_PROTOCOL §3）：本地 EMQX 暂不校验，但行为与真机一致
const DEVICE_SECRET = process.env.DEVICE_SECRET ?? 'mock_secret';
const FIRMWARE_VERSION = process.env.FIRMWARE_VERSION ?? '0.1.0-mock';
// 非法/过小的间隔一律回退默认：NaN 或 0 会被 setInterval 钳到 1ms，等于对 Broker 洪水攻击
function parseIntervalMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 500 ? n : fallback;
}
const LOCATION_INTERVAL_MS = parseIntervalMs(process.env.LOCATION_INTERVAL_MS, 5000);
// 心跳默认 60s：对齐 EVENTS.md §4.1 / DEVICE_PROTOCOL Keep Alive 的建议值；演示要更密可用环境变量调小
const STATUS_INTERVAL_MS = parseIntervalMs(process.env.STATUS_INTERVAL_MS, 60_000);

const log = (msg: string): void =>
  console.log(`[${new Date().toISOString()}] [${DEVICE_ID}] ${msg}`);

const client = connect(MQTT_URL, {
  clientId: DEVICE_ID,
  username: DEVICE_ID,
  password: DEVICE_SECRET,
});

function publish<T extends EventType>(kind: 'status' | 'location' | 'event', eventType: T, payload: EventPayloadMap[T]): void {
  const envelope = buildEnvelope(DEVICE_ID, FIRMWARE_VERSION, eventType, payload);
  client.publish(`helmet/${DEVICE_ID}/${kind}`, JSON.stringify(envelope), { qos: 1 }, (err) => {
    if (err) {
      log(`发送失败 ${eventType}: ${err.message}`);
    } else {
      log(`已发送 ${eventType} (eventId=${envelope.eventId.slice(0, 8)}…)`);
    }
  });
}

// —— device_status 心跳：电量缓慢下降，见底后模拟换电复位 ——
let battery = 100;
function sendStatus(): void {
  publish('status', 'device_status', { battery, charging: false, sleeping: false });
  battery = battery <= 5 ? 100 : battery - 1;
}

// —— location_update 剧本：沿内置路线逐点前进，循环播放 ——
// SCENARIO=ski 滑雪剧本（带海拔）；SCENARIO=fall / sos：骑行途中触发一次
// possible_fall / manual_sos（SOS 状态机端到端演示）；SCENARIO=risk：周期性
// 「后方来车预警 → 数点后解除」循环（危险事件链路演示）；默认骑行环路
type Scenario = 'riding' | 'ski' | 'fall' | 'sos' | 'risk';
const SCENARIO: Scenario = (() => {
  const s = process.env.SCENARIO;
  return s === 'ski' || s === 'fall' || s === 'sos' || s === 'risk'
    ? s
    : 'riding';
})();
const ROUTE = SCENARIO === 'ski' ? buildSkiLoop() : expandRoute(RIDING_LOOP, 30);
let routeIndex = 0;

// 触发点：发满 EMERGENCY_AFTER_POINTS 个位置后发一次紧急事件（可 Ctrl+C 重跑重放）
const EMERGENCY_AFTER_POINTS = (() => {
  const n = Number(process.env.EMERGENCY_AFTER_POINTS);
  return Number.isInteger(n) && n >= 1 ? n : 5;
})();
let pointsSent = 0;
let emergencySent = false;
function maybeSendEmergency(current: (typeof ROUTE)[number]): void {
  if (SCENARIO !== 'fall' && SCENARIO !== 'sos') return;
  if (emergencySent || pointsSent < EMERGENCY_AFTER_POINTS) return;
  emergencySent = true;
  const location = {
    latitude: current.latitude,
    longitude: current.longitude,
    coordinateSystem: 'wgs84' as const,
    accuracy: 8,
  };
  if (SCENARIO === 'fall') {
    // confidence/algorithmVersion 原样落库不参与软件判断（EVENTS.md §2.5）
    publish('event', 'possible_fall', {
      confidence: 0.87,
      algorithmVersion: 'mock-fall-v1',
      location,
    });
  } else {
    publish('event', 'manual_sos', { location });
  }
  log(
    `🚨 已触发 ${SCENARIO === 'fall' ? 'possible_fall' : 'manual_sos'}（服务端将开始 SOS 倒计时）`,
  );
}

// —— SCENARIO=risk：后方来车预警循环（EVENTS.md 4.5/4.6）——
// 每 RISK_CYCLE_POINTS 个位置点发一次 collision_risk（rear/high，距离逐次拉近），
// 2 个点后发 risk_cleared 精确解除（带 clearedEventId），循环往复。
const RISK_CYCLE_POINTS = 8;
let activeRiskEventId: string | null = null;
let riskClearCountdown = 0;
function maybeSendRisk(current: (typeof ROUTE)[number]): void {
  if (SCENARIO !== 'risk') return;
  const location = {
    latitude: current.latitude,
    longitude: current.longitude,
    coordinateSystem: 'wgs84' as const,
    accuracy: 8,
  };
  if (activeRiskEventId) {
    riskClearCountdown -= 1;
    if (riskClearCountdown <= 0) {
      publish('event', 'risk_cleared', {
        clearedEventId: activeRiskEventId,
      });
      log('✅ 已解除危险（risk_cleared）');
      activeRiskEventId = null;
    }
    return;
  }
  if (pointsSent % RISK_CYCLE_POINTS !== 0) return;
  const envelope = buildEnvelope(DEVICE_ID, FIRMWARE_VERSION, 'collision_risk', {
    riskLevel: 'high',
    objectType: 'vehicle',
    direction: 'rear',
    distance: 15 - (pointsSent % 3) * 3,
    confidence: 0.92,
    algorithmVersion: 'mock-risk-v1',
    location,
  });
  activeRiskEventId = envelope.eventId;
  riskClearCountdown = 2;
  client.publish(
    `helmet/${DEVICE_ID}/event`,
    JSON.stringify(envelope),
    { qos: 1 },
    (err) => {
      if (err) log(`发送失败 collision_risk: ${err.message}`);
      else log('⚠️ 已触发后方来车预警（collision_risk rear/high）');
    },
  );
}
function sendLocation(): void {
  const current = ROUTE[routeIndex];
  const next = ROUTE[(routeIndex + 1) % ROUTE.length];
  const speed = distanceMeters(current, next) / (LOCATION_INTERVAL_MS / 1000);
  publish('location', 'location_update', {
    latitude: current.latitude,
    longitude: current.longitude,
    coordinateSystem: 'wgs84',
    accuracy: 5 + Math.round(Math.random() * 10),
    speed: Number(speed.toFixed(2)),
    heading: Number(headingDegrees(current, next).toFixed(1)),
    ...(current.altitude !== undefined
      ? { altitude: Number(current.altitude.toFixed(1)) }
      : {}),
  });
  routeIndex = (routeIndex + 1) % ROUTE.length;
  pointsSent += 1;
  maybeSendEmergency(current);
  maybeSendRisk(current);
}

let timers: NodeJS.Timeout[] = [];
let lastConnectAt = 0;
let rapidReconnects = 0;

client.on('connect', () => {
  // MQTT 同 clientId 互踢是真机语义：若被反复踢线，多半是又启动了一个同 deviceId 的实例
  const now = Date.now();
  rapidReconnects = now - lastConnectAt < 5000 ? rapidReconnects + 1 : 0;
  lastConnectAt = now;
  if (rapidReconnects === 3) {
    log(
      `⚠️ 连接被反复顶替——可能有另一个 ${DEVICE_ID} 实例在运行（MQTT 同 clientId 互踢）。请只保留一个实例，或用 DEVICE_ID 环境变量区分。`,
    );
  }
  const scenarioName =
    SCENARIO === 'ski'
      ? '滑雪'
      : SCENARIO === 'fall'
        ? '骑行+摔倒'
        : SCENARIO === 'sos'
          ? '骑行+手动SOS'
          : SCENARIO === 'risk'
            ? '骑行+后方来车预警'
            : '骑行';
  log(
    `已连接 ${MQTT_URL}，开始${scenarioName}剧本（位置每 ${LOCATION_INTERVAL_MS / 1000}s / 心跳每 ${STATUS_INTERVAL_MS / 1000}s）`,
  );
  // 重连会再次触发 connect：先清旧定时器，避免越跑越快
  timers.forEach(clearInterval);
  sendStatus();
  sendLocation();
  timers = [
    setInterval(sendStatus, STATUS_INTERVAL_MS),
    setInterval(sendLocation, LOCATION_INTERVAL_MS),
  ];
});

client.on('reconnect', () => log('重连中…'));
client.on('error', (err) => log(`MQTT 错误: ${err.message}`));

let shuttingDown = false;
process.on('SIGINT', () => {
  // npm 与终端会各转发一次 SIGINT，防重入
  if (shuttingDown) return;
  shuttingDown = true;
  log('收到退出信号，断开连接');
  timers.forEach(clearInterval);
  client.end(false, {}, () => process.exit(0));
});
