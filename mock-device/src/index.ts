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
// 没设 → 本地默认；设了但是空串 → 直接退出：云端 compose 把 .env 里没填的 MOCKn_DEVICE_ID 以空串注入，
// 空 clientId 连 EMQX 认证失败后 restart: unless-stopped 会每秒重连、日志只有「MQTT 错误」，看不出是没填凭证
function envOrDefault(name: 'DEVICE_ID' | 'DEVICE_SECRET', fallback: string): string {
  const v = process.env[name];
  if (v === undefined) return fallback;
  if (v.trim() === '') {
    console.error(`[mock-device] ${name} 是空串：deploy/.env 里对应的 MOCKn_${name} 没填。填上设备凭证，或别打开这个 profile`);
    process.exit(1);
  }
  return v;
}
const DEVICE_ID = envOrDefault('DEVICE_ID', 'helmet_mock_001');
// 真机凭证机制的占位（DEVICE_PROTOCOL §3）：本地 EMQX 暂不校验，但行为与真机一致
const DEVICE_SECRET = envOrDefault('DEVICE_SECRET', 'mock_secret');
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
/** 一条预警怎么演：事件类型 + 载荷（位置临场补）+ 几个点后解除 + 要不要跟录像 */
interface RiskSpec {
  kind: 'collision_risk' | 'obstacle_risk';
  payload: Omit<EventPayloadMap['collision_risk'], 'location' | 'algorithmVersion'>;
  clearAfterPoints: number;
  withVideo: boolean;
  /** 日志里给人看的一句话 */
  label: string;
}
let activeRisk: { eventId: string; countdown: number; withVideo: boolean } | null =
  null;
function startRisk(current: RoutePoint, spec: RiskSpec): void {
  // 上一条还没到点下一条就来了：先解除再发，保证每条预警都有自己的解除
  //（App 的「当前危险状态」由事件流推导，决策 #27，悬着一条没解除会一直亮红）
  if (activeRisk) clearRisk();
  const envelope = publish('event', spec.kind, {
    ...spec.payload,
    algorithmVersion: 'mock-risk-v1',
    location: locationOf(current),
  });
  activeRisk = {
    eventId: envelope.eventId,
    countdown: spec.clearAfterPoints,
    withVideo: spec.withVideo,
  };
  log(
    `⚠️ 已触发${spec.label}（${spec.kind} ${spec.payload.direction ?? '-'}/${spec.payload.riskLevel}）`,
  );
}
function clearRisk(): void {
  if (!activeRisk) return;
  const { eventId, withVideo } = activeRisk;
  activeRisk = null;
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
}
/** 每个位置点推进一次：在途的预警到点解除 */
function tickRisk(): void {
  if (!activeRisk) return;
  activeRisk.countdown -= 1;
  if (activeRisk.countdown <= 0) clearRisk();
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
  startRisk(current, {
    kind: 'collision_risk',
    payload: {
      riskLevel: 'high',
      objectType: 'vehicle',
      direction: 'rear',
      distance: 15 - (pointsSent % 3) * 3,
      ttcSeconds: 1.8,
      approachSpeedKmh: 55,
      confidence: 0.92,
    },
    clearAfterPoints: 2,
    withVideo: true,
    label: '后方来车预警',
  });
}

// —— SCENARIO=tour：一轮把所有情况轮着演一遍（负责人自测用，2026-10-14）——
// 一轮 TOUR_CYCLE_POINTS 个位置点（默认 72，云端位置每 10 s 即 12 分钟），按轮内进度（TOUR_STEPS 的 at）依次演：
//   安全事件一轮 8 条（负责人要求「多加一点」）：目标 / 方向 / 等级 / 距离各不相同，安全记录页看得出差别；
//   objectType 带一条 unknown 看 App 的兜底文案；4 条跟录像走 §9 媒体链路；距离按轮次微调，相邻两轮的记录不完全一样。
//   40% 摔倒（偶数轮）/ 实体键求救（奇数轮）→ 服务端 60 s 倒计时，App 上可取消；
//   65% 进入休眠 → 75% 唤醒（心跳里的 sleeping 跟着变，休眠段不发预警）；85% 蓝牙断开。其余时间照常骑行 + 心跳。
// ⚠️ 每轮都会有一次求救：到期未取消会真发短信给绑定账号的紧急联系人（dev 短信 2026-10-12 起已真发），只给自测账号用；
//   TOUR_SOS=0 关掉求救那一步，其余步照演（常驻实例绑了有真实联系人的账号时用）。
const TOUR_CYCLE_POINTS = (() => {
  const n = Number(process.env.TOUR_CYCLE_POINTS);
  // 12 步里最近的两步只隔 5%，轮长低于 40 个点会落到同一个点上（后一步被吞掉）
  return Number.isInteger(n) && n >= 40 ? n : 72;
})();
const TOUR_SOS = process.env.TOUR_SOS !== '0';
type TourStep = { at: number } & (
  | { risk: RiskSpec; action?: undefined }
  | { risk?: undefined; action: 'sos' | 'sleep' | 'wake' | 'bluetooth_lost' }
);
const TOUR_STEPS: readonly TourStep[] = [
  {
    at: 0.06,
    risk: {
      kind: 'collision_risk',
      payload: { riskLevel: 'high', objectType: 'vehicle', direction: 'rear', distance: 12, ttcSeconds: 1.8, approachSpeedKmh: 55, confidence: 0.92 },
      clearAfterPoints: 2,
      withVideo: true,
      label: '后方来车逼近',
    },
  },
  {
    at: 0.14,
    risk: {
      kind: 'collision_risk',
      payload: { riskLevel: 'medium', objectType: 'vehicle', direction: 'left', distance: 4.5, ttcSeconds: 2.6, approachSpeedKmh: 30, confidence: 0.85 },
      clearAfterPoints: 2,
      withVideo: false,
      label: '左侧车辆贴近',
    },
  },
  {
    at: 0.22,
    risk: {
      kind: 'obstacle_risk',
      payload: { riskLevel: 'medium', objectType: 'obstacle', direction: 'front', distance: 6, confidence: 0.88 },
      clearAfterPoints: 2,
      withVideo: false,
      label: '前方障碍物',
    },
  },
  {
    at: 0.3,
    risk: {
      kind: 'collision_risk',
      payload: { riskLevel: 'high', objectType: 'pedestrian', direction: 'front', distance: 3.2, ttcSeconds: 1.2, approachSpeedKmh: 8, confidence: 0.9 },
      clearAfterPoints: 1,
      withVideo: true,
      label: '前方行人横穿',
    },
  },
  { at: 0.4, action: 'sos' },
  {
    at: 0.5,
    risk: {
      kind: 'obstacle_risk',
      payload: { riskLevel: 'low', objectType: 'obstacle', direction: 'front', distance: 14, confidence: 0.76 },
      clearAfterPoints: 3,
      withVideo: false,
      label: '远处障碍物提示',
    },
  },
  {
    at: 0.57,
    risk: {
      kind: 'collision_risk',
      payload: { riskLevel: 'medium', objectType: 'vehicle', direction: 'right', distance: 2.8, ttcSeconds: 2.1, approachSpeedKmh: 25, confidence: 0.83 },
      clearAfterPoints: 2,
      withVideo: false,
      label: '右侧车辆超车',
    },
  },
  { at: 0.65, action: 'sleep' },
  { at: 0.75, action: 'wake' },
  {
    at: 0.8,
    risk: {
      kind: 'collision_risk',
      payload: { riskLevel: 'high', objectType: 'unknown', direction: 'rear', distance: 9, ttcSeconds: 1.5, approachSpeedKmh: 60, confidence: 0.71 },
      clearAfterPoints: 2,
      withVideo: true,
      label: '后方不明目标快速逼近',
    },
  },
  { at: 0.85, action: 'bluetooth_lost' },
  {
    at: 0.93,
    risk: {
      kind: 'obstacle_risk',
      payload: { riskLevel: 'high', objectType: 'obstacle', direction: 'front', distance: 2.5, confidence: 0.94 },
      clearAfterPoints: 2,
      withVideo: true,
      label: '前方障碍物紧急',
    },
  },
];
function maybeSendTour(current: RoutePoint): void {
  if (SCENARIO !== 'tour') return;
  tickRisk();
  const cycle = Math.floor(pointsSent / TOUR_CYCLE_POINTS);
  const slot = pointsSent % TOUR_CYCLE_POINTS;
  const step = TOUR_STEPS.find(
    (s) => slot === Math.max(1, Math.round(TOUR_CYCLE_POINTS * s.at)),
  );
  if (!step) return;
  if (step.risk) {
    // 距离按轮次微调（原值 / 近 10% / 近 20% 轮着来），相邻两轮的安全记录不完全一样
    const nearer = 1 - 0.1 * (cycle % 3);
    const { distance } = step.risk.payload;
    startRisk(current, {
      ...step.risk,
      payload: {
        ...step.risk.payload,
        ...(distance !== undefined ? { distance: Number((distance * nearer).toFixed(1)) } : {}),
      },
    });
    return;
  }
  switch (step.action) {
    case 'sos':
      if (!TOUR_SOS) {
        log('tour 的求救步已关（TOUR_SOS=0），本轮不发 possible_fall / manual_sos');
        break;
      }
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
      break;
    case 'sleep':
      asleep = true;
      publish('event', 'sleep_entered', { reason: 'inactivity', battery });
      log('😴 已进入休眠（sleep_entered）');
      break;
    case 'wake':
      asleep = false;
      publish('event', 'sleep_exited', { reason: 'manual', battery });
      log('⏰ 已唤醒（sleep_exited）');
      break;
    case 'bluetooth_lost':
      publish('event', 'bluetooth_lost', { disconnectDuration: 35 });
      log('📵 已上报蓝牙断开（bluetooth_lost）');
      break;
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
