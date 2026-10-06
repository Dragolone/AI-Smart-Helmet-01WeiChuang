// BLE 上行中转队列（决策 #29/#31/#35，API.md §12.1；参考 mock-device/relay-transport.ts）。
// 职责：BLE 事件 → 过滤(7 种) → 入队 → 批量提交 /ingest/app-relay（单批 ≤100）→
// 失败原样保留、按原 eventId 补传（服务端幂等，重复返回 duplicate 计数不报错）。
// 现状：BLE GATT 收发未接（硬件前置），生产者只有未来的 BLE 模块与 __DEV__ 注入。
//
// 2026-09-13 审计后的三条设计约束（BLE-03…08）：
//   ① 多设备轮转提交，任何一台设备的积压/永久失败都不能拖住另一台的 possible_fall；
//   ② 队列溢出先丢周期事件，高危事件（摔倒/求救/危险）只在整队都是高危时才被挤出；
//   ③ 队列与持久化文件按账号归属分区，换账号不补传别人的设备、也不恢复别人的文件。
import { BLE_RELAY_EVENT_TYPES } from "@helmet/shared";
import type { EventEnvelope, EventType } from "@helmet/shared";
import { File, Paths } from "expo-file-system";

import { relayApi } from "@/api/relay";
import { devLog } from "@/services/dev-log";
import { HelmetLinkService } from "helmet-link-service";

const RELAY_SCOPE = new Set<string>(BLE_RELAY_EVENT_TYPES);
/** 溢出时最后才丢的类型：保命链路与危险留档（与头盔 Flash「高危永不覆盖」口径一致） */
const CRITICAL_TYPES = new Set<string>([
  "possible_fall",
  "manual_sos",
  "collision_risk",
  "obstacle_risk",
]);
/** 离线缓存上限：溢出丢最旧的周期事件并告警，绝不静默截断 */
const QUEUE_MAX = 1000;
/** 高危事件待上传期间的持锁上限：够重试几轮，不够把电池耗干 */
const CRITICAL_HOLD_MS = 90_000;
/** 深睡期间周期事件的补偿：距上次成功上传超过这个时长且队列非空，就短暂持锁把积压冲出去
 *  （华为实测：加白名单 + 「休眠时保持网络」仍挂起后台 HTTP，位置包只能靠持锁窗口批量走） */
const PERIODIC_HOLD_INTERVAL_MS = 5 * 60_000;
const PERIODIC_HOLD_MS = 20_000;
let lastFlushOkAt = Date.now();
/** Contract 硬上限（API.md §12.1） */
const MAX_BATCH = 100;
const FLUSH_INTERVAL_MS = 5_000;
/** 未登录/未知归属时的分区名：仍可入队，但不与任何真实账号的文件混用 */
const ANONYMOUS_OWNER = "anonymous";
/** 持久化文件格式版本：带归属标记，旧的裸数组格式不认（无法证明属于当前账号） */
const STORE_VERSION = 2;

type Envelope = EventEnvelope<EventType>;

interface RelayQueueFile {
  v: number;
  owner: string;
  events: Envelope[];
}

/** 队列持久化接口：文件版（expo-file-system）；所有 IO 包 try/catch，持久化失败绝不阻塞保命链路 */
interface RelayQueueStore {
  load(owner: string): Promise<Envelope[]>;
  save(owner: string, queue: Envelope[]): Promise<void>;
}

const fileFor = (owner: string, suffix = ""): File =>
  new File(
    Paths.document,
    `ble-relay-queue.${encodeURIComponent(owner)}.json${suffix}`,
  );
/** 先写到它、再整文件改名覆盖正式文件：改名是原子的，写到一半被杀只会留下残缺的临时文件 */
const TMP_SUFFIX = ".tmp";

/** 解析一份队列文件；格式 / 归属不符或根本不是 JSON 都返回 null（调用方决定回落到哪一份） */
function parseQueueFile(f: File, owner: string): Envelope[] | null {
  if (!f.exists) return null;
  const parsed: unknown = JSON.parse(f.textSync());
  // 只接受带归属标记且归属一致的文件；裸数组/别人的分区一律不恢复（审计 BLE-06/BLE-08）
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as RelayQueueFile).v !== STORE_VERSION ||
    (parsed as RelayQueueFile).owner !== owner ||
    !Array.isArray((parsed as RelayQueueFile).events)
  ) {
    return null;
  }
  return (parsed as RelayQueueFile).events.filter(isEnvelope);
}

const isEnvelope = (x: unknown): x is Envelope =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as Envelope).eventId === "string" &&
  typeof (x as Envelope).deviceId === "string" &&
  typeof (x as Envelope).eventType === "string";

const fileStore: RelayQueueStore = {
  async load(owner) {
    // 临时文件若完整，就是最近一次落盘（写完还没来得及改名就被杀）；残缺则回落正式文件。
    // 正式文件本身也可能残缺（旧版本直接覆盖写）：那时只能从空队列开始，但要出声——
    // 头盔侧这些事件已经因 ACK 擦除了（10-06 不变式评审 F-6）
    try {
      const fromTmp = parseQueueFile(fileFor(owner, TMP_SUFFIX), owner);
      if (fromTmp) return fromTmp;
    } catch {
      // 写到一半的临时文件，忽略
    }
    try {
      const f = fileFor(owner);
      if (!f.exists) return [];
      const parsed = parseQueueFile(f, owner);
      if (!parsed) {
        devLog("BLE-RELAY", "队列文件格式/归属不符，不恢复");
        return [];
      }
      return parsed;
    } catch (e) {
      console.error("[BLE-RELAY] 队列文件损坏，积压的中转事件无法恢复", e);
      return [];
    }
  },
  async save(owner, q) {
    try {
      const payload: RelayQueueFile = { v: STORE_VERSION, owner, events: q };
      const text = JSON.stringify(payload);
      const target = fileFor(owner);
      const tmp = fileFor(owner, TMP_SUFFIX);
      // 先写临时文件再原子改名；没有 moveSync 的环境（测试假件）退回直接覆盖写
      if (typeof (tmp as { moveSync?: unknown }).moveSync === "function") {
        tmp.write(text);
        tmp.moveSync(target, { overwrite: true });
      } else {
        target.write(text);
      }
    } catch (e) {
      devLog("BLE-RELAY", "队列持久化失败(忽略,仅内存)", e);
    }
  },
};
const store: RelayQueueStore = fileStore;

let queue: Envelope[] = [];
let owner = ANONYMOUS_OWNER;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
/** 多设备轮转的起点：每次 flush 只提交一台设备，下一次换下一台（审计 BLE-03） */
let deviceCursor = 0;

const persist = (): void => {
  void store.save(owner, queue);
};

/** 求救类事件：入队时同步通知订阅方（视频预览页据此让出网络，见 onSosRelayEvent） */
const SOS_TYPES = new Set<string>(["possible_fall", "manual_sos"]);
const sosListeners = new Set<(eventType: string) => void>();

/**
 * 订阅「摔倒 / 求救事件已入队」。在本次上传发起之前同步回调——视频预览期间 Android 把进程
 * 绑在没有互联网的头盔热点上，订阅方必须在回调里立刻解绑，这条事件才能马上送出去。
 * 危险预警不通知：那是留档，不值得打断用户。
 */
export function onSosRelayEvent(
  listener: (eventType: string) => void,
): () => void {
  sosListeners.add(listener);
  return () => {
    sosListeners.delete(listener);
  };
}

/** BLE 模块收到头盔事件后调用：范围外事件本地丢弃(蓝牙版 MVP 只中转 7 种,决策 #31) */
export function enqueueRelayEvent(envelope: Envelope): void {
  if (!RELAY_SCOPE.has(envelope.eventType)) {
    devLog("BLE-RELAY", `范围外事件不中转:${envelope.eventType}`);
    return;
  }
  queue.push(envelope);
  if (SOS_TYPES.has(envelope.eventType)) {
    for (const listener of sosListeners) {
      // 订阅方出错绝不能拦住保命事件的入队与上传
      try {
        listener(envelope.eventType);
      } catch (e) {
        devLog("BLE-RELAY", "求救事件订阅方回调出错(已忽略)", e);
      }
    }
  }
  // 保命事件入队即持锁（Android）：华为息屏深睡会挂起 App 网络，靠锁把上传窗口撑开；周期事件不持
  if (CRITICAL_TYPES.has(envelope.eventType))
    HelmetLinkService.holdNetwork(CRITICAL_HOLD_MS);
  // 深睡里 JS 定时器不走（华为实测 15 min 零 flush），但 BLE 事件到达时 JS 一定在跑：
  // 借每 5 s 一次的位置包做「距上次成功上传 >5 min 就持锁冲一次」的触发点，不依赖 setInterval
  // 队列里还有高危事件（上一次上传失败，例如深睡刚醒时的 SSL 读错误）也要借这次事件立刻重试，
  // 不能等 5 min 的周期窗口——实测一次失败后保命事件被拖到下个窗口
  const criticalPending = queue.some((e) => CRITICAL_TYPES.has(e.eventType));
  if (
    !flushing &&
    (criticalPending || Date.now() - lastFlushOkAt > PERIODIC_HOLD_INTERVAL_MS)
  ) {
    HelmetLinkService.holdNetwork(
      criticalPending ? CRITICAL_HOLD_MS : PERIODIC_HOLD_MS,
    );
    void flushRelayQueue();
  }
  if (queue.length > QUEUE_MAX) {
    // 先丢最旧的周期事件（位置/心跳）；整队都是高危事件时才丢最旧的那条（审计 BLE-04）
    const victim = queue.findIndex((e) => !CRITICAL_TYPES.has(e.eventType));
    const dropped = queue.splice(victim === -1 ? 0 : victim, 1)[0];
    devLog(
      "BLE-RELAY",
      `缓存溢出(>${QUEUE_MAX}),丢弃最旧一条 ${dropped.eventType}`,
    );
  }
  persist();
}

/** 客户端规范化错误（api/client.ts）里带 HTTP 状态时，判断这一批是否再试也没用 */
const isUnrecoverable = (e: unknown): boolean => {
  const status = (e as { status?: unknown })?.status;
  // 404=设备不属于当前账号、403=无权、400=结构性坏体：重试永远同一个结果，再等下去只会堵住别的设备（审计 BLE-05）
  return status === 404 || status === 403 || status === 400;
};

/** flush 进行中又被叫到（高危帧「立即冲刷」正撞上在途的位置包）：结束后立刻补跑一次，不等下个 5 s tick（10-06 并发评审 F5） */
let rerunAfterFlush = false;

/** 高危事件（摔倒 / 求救）被服务端接受后的回调：由 use-realtime 接到「核对进行中的 SOS 并拉起倒计时页」 */
let criticalAcceptedHandler: ((deviceId: string) => void) | null = null;
export function setCriticalAcceptedHandler(
  handler: ((deviceId: string) => void) | null,
): void {
  criticalAcceptedHandler = handler;
}
const SOS_TRIGGER_TYPES = new Set(["possible_fall", "manual_sos"]);
/** 页面直接提交（不经队列）的摔倒 / 求救被接受后也走同一条「核对并拉起倒计时页」的路 */
export function notifyCriticalAccepted(deviceId: string): void {
  try {
    criticalAcceptedHandler?.(deviceId);
  } catch (err) {
    devLog("BLE-RELAY", "高危事件已接受回调抛错", err);
  }
}

/** 批量提交：成功才出队；失败/断网原样保留，下轮按原 eventId 补传 */
export async function flushRelayQueue(): Promise<void> {
  if (queue.length === 0) return;
  if (flushing) {
    rerunAfterFlush = true;
    return;
  }
  flushing = true;
  if (Date.now() - lastFlushOkAt > PERIODIC_HOLD_INTERVAL_MS) {
    HelmetLinkService.holdNetwork(PERIODIC_HOLD_MS);
  }
  const ownerAtStart = owner;
  try {
    // 一批只提交一个设备(接口按设备鉴权)；设备之间轮转，谁也不能长期霸占
    const devices = [...new Set(queue.map((e) => e.deviceId))];
    const dev = devices[deviceCursor % devices.length];
    deviceCursor = (deviceCursor + 1) % Math.max(devices.length, 1);
    const mine = queue.filter((e) => e.deviceId === dev);
    // 高危事件插队：同一台设备积压时先送摔倒/求救/危险，位置心跳排后
    const batch = [
      ...mine.filter((e) => CRITICAL_TYPES.has(e.eventType)),
      ...mine.filter((e) => !CRITICAL_TYPES.has(e.eventType)),
    ].slice(0, MAX_BATCH);
    try {
      const counts = await relayApi.push({ deviceId: dev, envelopes: batch });
      // 202 = 整批已消化(accepted/duplicate 入库,invalid 服务端留档不重试)→ 整批出队
      const sent = new Set(batch);
      queue = queue.filter((e) => !sent.has(e));
      lastFlushOkAt = Date.now();
      // 这一批里有摔倒 / 求救且服务端接受了：此刻 JS 在跑、网络刚被持锁打开——是唯一不依赖
      // WS 存活或远程推送到达就能确认「云端已建单」并拉起倒计时页的时机（10-06 不变式评审 F-1）
      if (
        counts.accepted > 0 &&
        batch.some((e) => SOS_TRIGGER_TYPES.has(e.eventType))
      ) {
        notifyCriticalAccepted(dev);
      }
      if (!queue.some((e) => CRITICAL_TYPES.has(e.eventType)))
        HelmetLinkService.releaseNetwork();
      devLog(
        "BLE-RELAY",
        `已中转 ${dev} accepted=${counts.accepted} duplicate=${counts.duplicate} invalid=${counts.invalid}` +
          (queue.length > 0
            ? `(缓存剩余 ${queue.length}: ${queue.map((e) => `${e.eventType}@${e.deviceId}`).join(",")})`
            : ""),
      );
    } catch (e) {
      if (isUnrecoverable(e)) {
        // 这台设备在当前账号下永远送不出去（已解绑/换账号）：丢掉它的积压，别拖住其他设备
        const doomed = new Set(mine);
        queue = queue.filter((x) => !doomed.has(x));
        devLog(
          "BLE-RELAY",
          `${dev} 的 ${mine.length} 条事件被服务端拒绝(不可重试),已丢弃`,
          e,
        );
      } else {
        devLog("BLE-RELAY", "中转提交失败,保留缓存下轮重试", e);
      }
    }
    // 提交期间账号已切换：这次结果不写到新账号的分区里
    if (owner === ownerAtStart) persist();
  } finally {
    flushing = false;
    if (rerunAfterFlush) {
      rerunAfterFlush = false;
      void flushRelayQueue();
    }
  }
}

/**
 * 登录期间常驻(use-realtime 同生命周期)：恢复本账号的持久化队列 + 周期 flush。
 * ownerKey = 当前用户 id；未登录/未知时用匿名分区，绝不与真实账号的文件混用。
 */
export function startRelayUplink(ownerKey: string = ANONYMOUS_OWNER): void {
  if (flushTimer) return;
  owner = ownerKey;
  void store.load(ownerKey).then((saved) => {
    // 恢复期间可能已 stop/换账号：只在归属仍是自己时合并；按 eventId 去重，重入不会出现两份（审计 BLE-07）
    if (owner !== ownerKey || saved.length === 0) return;
    const known = new Set(queue.map((e) => e.eventId));
    queue = [...saved.filter((e) => !known.has(e.eventId)), ...queue];
  });
  flushTimer = setInterval(() => void flushRelayQueue(), FLUSH_INTERVAL_MS);
  // Node/jest 里不让定时器拖住进程退出；RN 的 setInterval 返回数字，无此方法
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

/** 退出登录/切换账号：落盘到本账号分区并清空内存，下一个账号从自己的分区开始 */
export function stopRelayUplink(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  persist();
  queue = [];
  deviceCursor = 0;
  owner = ANONYMOUS_OWNER;
}
