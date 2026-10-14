// Mock Device Simulator：假扮真头盔按 docs/EVENTS.md 发事件，对 Backend 完全不可区分。
// 剧本（发什么）在本文件；传输（怎么送）见 transport.ts —— TRANSPORT 环境变量二选一：
//   mqtt（默认）  4G 链路：直连 EMQX
//   app-relay     MVP 唯一真机链路：模拟手机 App 中转（决策 #35），批量提交 + 断线补传
import type { EventEnvelope, EventPayloadMap, EventType } from '@helmet/shared';
import { buildEnvelope } from './envelope.ts';
import { createMqttTransport, type CmdResult } from './mqtt-transport.ts';
import { createRelayTransport } from './relay-transport.ts';
import type { EventKind, Transport } from './transport.ts';
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

// —— 传输选择：默认 mqtt，行为与既有版本完全一致 ——
const TRANSPORT = process.env.TRANSPORT === 'app-relay' ? 'app-relay' : 'mqtt';
const CMD_RESULT = ((): CmdResult => {
  const r = process.env.MOCK_CMD_RESULT;
  return r === 'failed' || r === 'silent' ? r : 'success';
})();
const transport: Transport =
  TRANSPORT === 'app-relay'
    ? createRelayTransport({
        apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:3000',
        deviceId: DEVICE_ID,
        phone: process.env.RELAY_PHONE ?? '',
        password: process.env.RELAY_PASSWORD ?? '',
        flushIntervalMs: parseIntervalMs(process.env.RELAY_FLUSH_INTERVAL_MS, 5000),
        // Contract 硬上限 100（API.md §12.1），配大了也钳回去
        maxBatch: Math.min(
          Math.max(Number(process.env.RELAY_MAX_BATCH) || 20, 1),
          100,
        ),
        offlineCycle: Math.max(Number(process.env.RELAY_OFFLINE_CYCLE) || 0, 0),
        sendOutOfScope: process.env.RELAY_SEND_OUT_OF_SCOPE === '1',
        cmdResult: CMD_RESULT,
        log,
      })
    : createMqttTransport({
        url: MQTT_URL,
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        cmdResult: CMD_RESULT,
        log,
      });

/** 构造 envelope 并交给传输层；返回 envelope 供需要 eventId 的剧本（如 risk 解除）引用 */
function publish<T extends EventType>(
  kind: EventKind,
  eventType: T,
  payload: EventPayloadMap[T],
): EventEnvelope<T> {
  const envelope = buildEnvelope(DEVICE_ID, FIRMWARE_VERSION, eventType, payload);
  transport.send(kind, envelope as EventEnvelope<EventType>);
  return envelope;
}

// —— device_status 心跳：电量缓慢下降，到 60% 模拟换电复位 ——
// 演示要「看得出在变」又别掉到让人以为快没电（常驻 Mock 一跑几天，原先每次心跳掉 1%、掉到 5% 才复位，
// 随时可能停在 10% 几；2026-10-14 负责人要求默认电量高一些）：每 10 次心跳掉 1%，60 s 心跳即 10 分钟 1%
let battery = 100;
let statusTicks = 0;
// tour 剧本的休眠段：心跳里的 sleeping 要和 sleep_entered / sleep_exited 对得上，否则快照被下一次心跳翻回去
let asleep = false;
function sendStatus(): void {
  publish('status', 'device_status', { battery, charging: false, sleeping: asleep });
  statusTicks += 1;
  if (statusTicks % 10 === 0) battery = battery <= 60 ? 100 : battery - 1;
}

// —— location_update 剧本：沿内置路线逐点前进，循环播放 ——
// SCENARIO=ski 滑雪剧本（带海拔）；SCENARIO=fall / sos：骑行途中触发一次
// possible_fall / manual_sos（SOS 状态机端到端演示）；SCENARIO=risk：周期性
// 「后方来车预警 → 数点后解除」循环（危险事件链路演示）；SCENARIO=tour：一轮把所有情况
// 轮着演一遍（负责人自测用，2026-10-14，见 maybeSendTour）；默认骑行环路
type Scenario = 'riding' | 'ski' | 'fall' | 'sos' | 'risk' | 'tour';
const SCENARIO: Scenario = (() => {
  const s = process.env.SCENARIO;
  return s === 'ski' ||
    s === 'fall' ||
    s === 'sos' ||
    s === 'risk' ||
    s === 'tour'
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
    // confidence/algorithmVersion/impactG/tiltDeg 原样落库不参与软件判断（EVENTS.md §2.5 / 4.3）；
    // 冲击与倾角取 v0.6 手册例 6 的值，让演示数据与真机同形
    publish('event', 'possible_fall', {
      confidence: 0.87,
      algorithmVersion: 'mock-fall-v1',
      impactG: 4.5,
      tiltDeg: 85,
      location,
    });
  } else {
    publish('event', 'manual_sos', {
      triggerMode: 'long_press',
      pressDurationMs: 2300,
      location,
    });
  }
  log(
    `🚨 已触发 ${SCENARIO === 'fall' ? 'possible_fall' : 'manual_sos'}（服务端将开始 SOS 倒计时）`,
  );
}

// —— 危险事件：发一条预警，数个点后发 risk_cleared 精确解除（带 clearedEventId），
// 可选跟一条关联的 video_ready（§9 媒体链路演示）。risk 与 tour 剧本共用 ——
type RoutePoint = (typeof ROUTE)[number];
const locationOf = (current: RoutePoint) => ({
  latitude: current.latitude,
  longitude: current.longitude,
  coordinateSystem: 'wgs84' as const,
  accuracy: 8,
});
let activeRisk: { eventId: string; countdown: number; withVideo: boolean } | null =
  null;
function startRisk(
  current: RoutePoint,
  kind: 'collision_risk' | 'obstacle_risk',
  clearAfterPoints: number,
  withVideo: boolean,
): void {
  const envelope =
    kind === 'collision_risk'
      ? publish('event', 'collision_risk', {
          riskLevel: 'high',
          objectType: 'vehicle',
          direction: 'rear',
          distance: 15 - (pointsSent % 3) * 3,
          ttcSeconds: 1.8,
          approachSpeedKmh: 55,
          confidence: 0.92,
          algorithmVersion: 'mock-risk-v1',
          location: locationOf(current),
        })
      : publish('event', 'obstacle_risk', {
          riskLevel: 'medium',
          objectType: 'obstacle',
          direction: 'front',
          distance: 6,
          confidence: 0.88,
          algorithmVersion: 'mock-risk-v1',
          location: locationOf(current),
        });
  activeRisk = { eventId: envelope.eventId, countdown: clearAfterPoints, withVideo };
  log(
    kind === 'collision_risk'
      ? '⚠️ 已触发后方来车预警（collision_risk rear/high）'
      : '⚠️ 已触发前方障碍预警（obstacle_risk front/medium）',
  );
}
/** 每个位置点推进一次：在途的预警到点解除 */
function tickRisk(): void {
  if (!activeRisk) return;
  activeRisk.countdown -= 1;
  if (activeRisk.countdown > 0) return;
  const { eventId, withVideo } = activeRisk;
  publish('event', 'risk_cleared', { clearedEventId: eventId });
  if (withVideo) {
    // 头盔录像就绪：关联刚才的危险事件
    const videoId = `vid_${eventId.slice(0, 8)}`;
    publish('event', 'video_ready', {
      videoId,
      relatedEventId: eventId,
      duration: 12,
      sizeBytes: 3_500_000,
      storageKey: `mock/${DEVICE_ID}/${videoId}.mp4`,
    });
  }
  log(withVideo ? '✅ 已解除危险（risk_cleared）+ 录像就绪（video_ready）' : '✅ 已解除危险（risk_cleared）');
  activeRisk = null;
}

// —— SCENARIO=risk：后方来车预警循环（EVENTS.md 4.5/4.6）——
// 每 RISK_CYCLE_POINTS 个位置点发一次 collision_risk（rear/high，距离逐次拉近），2 个点后解除，循环往复。
const RISK_CYCLE_POINTS = 8;
function maybeSendRisk(current: RoutePoint): void {
  if (SCENARIO !== 'risk') return;
  if (activeRisk) {
    tickRisk();
    return;
  }
  if (pointsSent % RISK_CYCLE_POINTS !== 0) return;
  startRisk(current, 'collision_risk', 2, true);
}

// —— SCENARIO=tour：一轮把所有情况轮着演一遍（负责人自测用，2026-10-14）——
// 一轮 TOUR_CYCLE_POINTS 个位置点（默认 72，云端位置每 10 s 即 12 分钟），按轮内进度依次：
//   10% 后方来车预警 → 2 点后解除 + 录像就绪；25% 前方障碍预警 → 2 点后解除；
//   40% 摔倒（偶数轮）/ 实体键求救（奇数轮）→ 服务端 60 s 倒计时，App 上可取消；
//   65% 进入休眠 → 75% 唤醒（心跳里的 sleeping 跟着变）；85% 蓝牙断开。其余时间照常骑行 + 心跳。
// ⚠️ 每轮都会有一次求救：到期未取消会真发短信给绑定账号的紧急联系人，只给自测账号用。
const TOUR_CYCLE_POINTS = (() => {
  const n = Number(process.env.TOUR_CYCLE_POINTS);
  return Number.isInteger(n) && n >= 20 ? n : 72;
})();
function maybeSendTour(current: RoutePoint): void {
  if (SCENARIO !== 'tour') return;
  tickRisk();
  const cycle = Math.floor(pointsSent / TOUR_CYCLE_POINTS);
  const at = (fraction: number): boolean =>
    pointsSent % TOUR_CYCLE_POINTS === Math.max(1, Math.round(TOUR_CYCLE_POINTS * fraction));
  if (at(0.1)) startRisk(current, 'collision_risk', 2, true);
  else if (at(0.25)) startRisk(current, 'obstacle_risk', 2, false);
  else if (at(0.4)) {
    if (cycle % 2 === 0) {
      publish('event', 'possible_fall', {
        confidence: 0.87,
        algorithmVersion: 'mock-fall-v1',
        impactG: 4.5,
        tiltDeg: 85,
        location: locationOf(current),
      });
      log('🚨 已触发 possible_fall（服务端将开始 SOS 倒计时）');
    } else {
      publish('event', 'manual_sos', {
        triggerMode: 'long_press',
        pressDurationMs: 2300,
        location: locationOf(current),
      });
      log('🚨 已触发 manual_sos（服务端将开始 SOS 倒计时）');
    }
  } else if (at(0.65)) {
    asleep = true;
    publish('event', 'sleep_entered', { reason: 'inactivity', battery });
    log('😴 已进入休眠（sleep_entered）');
  } else if (at(0.75)) {
    asleep = false;
    publish('event', 'sleep_exited', { reason: 'manual', battery });
    log('⏰ 已唤醒（sleep_exited）');
  } else if (at(0.85)) {
    publish('event', 'bluetooth_lost', { disconnectDuration: 35 });
    log('📵 已上报蓝牙断开（bluetooth_lost）');
  }
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
  maybeSendTour(current);
}

let timers: NodeJS.Timeout[] = [];

transport.start(() => {
  const scenarioName =
    SCENARIO === 'ski'
      ? '滑雪'
      : SCENARIO === 'fall'
        ? '骑行+摔倒'
        : SCENARIO === 'sos'
          ? '骑行+手动SOS'
          : SCENARIO === 'risk'
            ? '骑行+后方来车预警'
            : SCENARIO === 'tour'
              ? `全情况轮播（每 ${TOUR_CYCLE_POINTS} 个位置点一轮）`
              : '骑行';
  log(
    `开始${scenarioName}剧本（位置每 ${LOCATION_INTERVAL_MS / 1000}s / 心跳每 ${STATUS_INTERVAL_MS / 1000}s）`,
  );
  // MQTT 重连会再次触发 onReady：先清旧定时器，避免越跑越快
  timers.forEach(clearInterval);
  sendStatus();
  sendLocation();
  timers = [
    setInterval(sendStatus, STATUS_INTERVAL_MS),
    setInterval(sendLocation, LOCATION_INTERVAL_MS),
  ];
});

let shuttingDown = false;
process.on('SIGINT', () => {
  // npm 与终端会各转发一次 SIGINT，防重入
  if (shuttingDown) return;
  shuttingDown = true;
  log('收到退出信号，断开连接');
  timers.forEach(clearInterval);
  transport.stop(() => process.exit(0));
});
