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
import { isUnrecoverableRelayError } from "@/services/relay-errors";
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
/**
 * 最近一个补偿窗口开始的时刻；null = 开窗之后已经传成功（或还没开过）。没信号时 lastFlushOkAt 一直不更新，
 * 原来每个位置包都续一次 20 s 锁，整个无信号期 CPU 都不能休眠：现在一个窗口只拿一次锁，窗口里逐事件重试
 * （深睡刚醒的第一个 HTTPS 常失败、几秒后重试才成），用完仍失败就放锁，5 分钟后开下一窗
 */
let periodicWindowAt: number | null = null;
/** Contract 硬上限（API.md §12.1） */
const MAX_BATCH = 100;
/**
 * 这一轮每批最多送几条：413（请求体超 100 KB）时减半重试、成功后翻倍恢复，下限 1——
 * 原来 413 整批原样重发，排在批首的摔倒永远送不出去（10-16 A7）
 */
let batchLimit = MAX_BATCH;
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

/** 已注销的账号：它的分区不再落盘（注销之后链路停下来时的那次落盘不能把文件写回来） */
const discardedOwners = new Set<string>();

/**
 * 本账号分区的积压正在读、还没并进内存：这期间不落盘——内存里这份缺了文件里的积压，写下去就把它们盖掉了
 * （登录后链路刚起来、冷启动时登录过期被强制登出早于读盘，10-19 夜测记下、10-21 负责人让修）。读完合并后补落一次
 */
let loading: { owner: string; saved: Promise<Envelope[]> } | null = null;

const persist = (): void => {
  if (discardedOwners.has(owner)) return;
  if (loading && loading.owner === owner) return;
  void store.save(owner, queue);
};

/** 把文件里读出来的积压并进内存（按 头盔号:事件号 去重，文件里的排前面） */
const mergeSaved = (saved: Envelope[], mem: Envelope[]): Envelope[] => {
  const known = new Set(mem.map(dedupeKey));
  return [...saved.filter((e) => !known.has(dedupeKey(e))), ...mem];
};

/**
 * 注销账号之后：丢掉这个账号分区的积压、删掉它的文件。账号已不存在、名下头盔已全部解绑，
 * 这些事件再也送不出去；留在手机上就是一份没人管的位置 / 事件记录（10-17 评审）。
 */
export function discardRelayQueue(ownerKey: string): void {
  discardedOwners.add(ownerKey);
  if (owner === ownerKey) queue = [];
  for (const suffix of ["", TMP_SUFFIX]) {
    try {
      const f = fileFor(ownerKey, suffix);
      if (f.exists) f.delete();
    } catch (e) {
      devLog("BLE-RELAY", "删除已注销账号的队列文件失败", e);
    }
  }
}

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
  abandonIfStuck();
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
  // 借每 5 s 一次的位置包做「距上次成功上传 >5 min 就开窗持锁冲一次」的触发点，不依赖 setInterval
  // 队列里还有高危事件（上一次上传失败，例如深睡刚醒时的 SSL 读错误）也要借这次事件立刻重试，
  // 不能等 5 min 的周期窗口——实测一次失败后保命事件被拖到下个窗口
  const criticalPending = queue.some((e) => CRITICAL_TYPES.has(e.eventType));
  if (!flushing && (criticalPending || periodicWindowOpen())) {
    if (criticalPending) HelmetLinkService.holdNetwork(CRITICAL_HOLD_MS);
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

/** flush 进行中又被叫到（高危帧「立即冲刷」正撞上在途的位置包）：结束后立刻补跑一次，不等下个 5 s tick（10-06 并发评审 F5） */
let rerunAfterFlush = false;

/**
 * 在途的那次提交。安卓后台时 JS 定时器不走，提交自带的 15 s 超时也就不走；底层又不设超时（expo/fetch 用 RN 的
 * OkHttp 客户端，连接 / 读 / 写超时都是 0），连接半开时请求永远不结束——flushing 一直为真，之后的摔倒照样回 ACK、
 * 入队，却再也传不上去（10-25 审查）。后台能叫醒 JS 的只有蓝牙事件：每来一条就看一眼，卡过 RELAY_STUCK_MS
 * 就放弃这次、立刻重发（服务端按 eventId 去重，原来那次后来到了也只算重复）
 */
let inflight: { startedAt: number; abandon: (e: Error) => void } | null = null;
const RELAY_STUCK_MS = 20_000;

function abandonIfStuck(): void {
  if (!inflight || Date.now() - inflight.startedAt < RELAY_STUCK_MS) return;
  devLog(
    "BLE-RELAY",
    `中转提交 ${RELAY_STUCK_MS / 1000} s 没有结果，放弃这次、重发`,
  );
  inflight.abandon(new Error("中转提交卡住"));
  inflight = null;
  rerunAfterFlush = true;
}

/** 「高危事件已接受」后的补拉还在跑几个：它要在网络锁里把倒计时页 / 锁屏提醒拉起来，跑完之前别放锁 */
let resumesPending = 0;

/**
 * 积压正一批接一批往外冲：成功一批就续一次锁，冲完或失败才放。原来一批成功就放，后面几批在没有锁的情况下发，
 * 深睡的华为网络随即挂起、请求卡住，要等下个窗口才再传 100 条（隧道 30 min 积压约 360 条，10-31 交叉审）
 */
let drainingBacklog = false;

/** 放网络锁：还有高危事件没送完、积压没冲完、或补拉还在跑就先不放（满批重跑那一批先回来时原来会直接放，10-25 审查） */
function releaseNetworkIfIdle(): void {
  if (
    drainingBacklog ||
    resumesPending > 0 ||
    queue.some((e) => CRITICAL_TYPES.has(e.eventType))
  )
    return;
  HelmetLinkService.releaseNetwork();
}

function endBacklogDrain(): void {
  if (!drainingBacklog) return;
  drainingBacklog = false;
  releaseNetworkIfIdle();
}

/**
 * 周期事件这会儿该不该持锁上传。只给队列里没有高危事件时用：有高危走自己的 90 s 锁，不受窗口限制。
 * 时钟往回拨过就把基准拉回现在：减出负数会一直算「不到 5 分钟」，开过的窗也会一直算「还没用完」
 */
function periodicWindowOpen(): boolean {
  const now = Date.now();
  if (now < lastFlushOkAt) lastFlushOkAt = now;
  if (periodicWindowAt !== null && now < periodicWindowAt)
    periodicWindowAt = null;
  if (now - lastFlushOkAt <= PERIODIC_HOLD_INTERVAL_MS) return false;
  const sinceOpen =
    periodicWindowAt === null ? Infinity : now - periodicWindowAt;
  if (sinceOpen < PERIODIC_HOLD_MS) return true;
  if (sinceOpen >= PERIODIC_HOLD_MS + PERIODIC_HOLD_INTERVAL_MS) {
    periodicWindowAt = now;
    HelmetLinkService.holdNetwork(PERIODIC_HOLD_MS);
    return true;
  }
  // 窗口用完了：CPU 锁已到时自己放，Wi-Fi 锁原生没有时限，不放就一直开到下次传成功
  releaseNetworkIfIdle();
  return false;
}

/** 高危事件（摔倒 / 求救）被服务端接受后的回调：由 use-realtime 接到「核对进行中的 SOS 并拉起倒计时页」 */
// 返回 Promise 时（补拉进行中的求救）上行队列等它跑完再放网络锁；别的返回值不管
let criticalAcceptedHandler: ((deviceId: string) => unknown) | null = null;
/** 服务端说这顶不归这个账号了：让设备列表马上刷新、链路摘掉目标 */
let relayRejected: (() => void) | null = null;
export function setRelayRejectedHandler(handler: (() => void) | null): void {
  relayRejected = handler;
}

export function setCriticalAcceptedHandler(
  handler: ((deviceId: string) => unknown) | null,
): void {
  criticalAcceptedHandler = handler;
}
const SOS_TRIGGER_TYPES = new Set(["possible_fall", "manual_sos"]);
/** 页面直接提交（不经队列）的摔倒 / 求救被接受后也走同一条「核对并拉起倒计时页」的路 */
/** 返回回调给的 Promise（补拉进行中的求救）：上行队列要等它跑完再放网络锁；不会 reject */
export function notifyCriticalAccepted(
  deviceId: string,
): Promise<unknown> | undefined {
  try {
    const r = criticalAcceptedHandler?.(deviceId);
    return r instanceof Promise
      ? r.catch((err: unknown) =>
          devLog("BLE-RELAY", "高危事件已接受后的补拉失败", err),
        )
      : undefined;
  } catch (err) {
    devLog("BLE-RELAY", "高危事件已接受回调抛错", err);
    return undefined;
  }
}

/** 放网络锁前最多等补拉多久（补拉自带 2 s / 5 s 两次重试；锁本身是 90 s 的） */
const RESUME_HOLD_MAX_MS = 30_000;

/** 批量提交：成功才出队；失败/断网原样保留，下轮按原 eventId 补传 */
export async function flushRelayQueue(): Promise<void> {
  if (queue.length === 0) {
    endBacklogDrain();
    return;
  }
  if (flushing) {
    abandonIfStuck();
    rerunAfterFlush = true;
    return;
  }
  flushing = true;
  // 队里有高危时不走窗口：那次锁还在就不会被缩短（holdNetwork 只延长），到时了这里再续上
  if (!queue.some((e) => CRITICAL_TYPES.has(e.eventType))) periodicWindowOpen();
  else if (Date.now() - lastFlushOkAt > PERIODIC_HOLD_INTERVAL_MS) {
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
    const limit = batchLimit;
    const batch = [
      ...mine.filter((e) => CRITICAL_TYPES.has(e.eventType)),
      ...mine.filter((e) => !CRITICAL_TYPES.has(e.eventType)),
    ].slice(0, limit);
    try {
      // 2xx 但响应体是 null（网关改写）：服务端已消化这一批，按全部接受走后续——原来读 counts.invalid 抛 TypeError，
      // 「高危已接受」回调没走、网络锁没放（10-16 A8）
      const mine = { startedAt: Date.now(), abandon: (_e: Error) => {} };
      const pushed = new Promise<Awaited<ReturnType<typeof relayApi.push>>>(
        (resolve, reject) => {
          mine.abandon = reject;
          relayApi
            .push({ deviceId: dev, envelopes: batch })
            .then(resolve, reject);
        },
      );
      inflight = mine;
      let res: Awaited<typeof pushed>;
      try {
        res = await pushed;
      } finally {
        if (inflight === mine) inflight = null;
      }
      const counts = res ?? {
        accepted: batch.length,
        duplicate: 0,
        invalid: 0,
      };
      batchLimit = Math.min(MAX_BATCH, batchLimit * 2);
      // 202 = 整批已消化(accepted/duplicate 入库,invalid 服务端留档不重试)→ 整批出队
      const sent = new Set(batch);
      queue = queue.filter((e) => !sent.has(e));
      lastFlushOkAt = Date.now();
      periodicWindowAt = null;
      // 这一批是满的 = 积压至少还有一批：不等 5 秒的定时器，接着冲下一批，积压不足一批再回到 5 秒一轮
      //（原来 1000 条要 50 秒才传完，优化清单 7）。失败不连发（留给下一轮）；不满的批也不连发——头盔一秒十几个点时，
      // 「有就接着发」会变成每个请求一回来就再发一两条，比 5 秒一批的请求还多
      drainingBacklog = batch.length >= limit && queue.length > 0;
      if (drainingBacklog) {
        rerunAfterFlush = true;
        HelmetLinkService.holdNetwork(PERIODIC_HOLD_MS);
      }
      // 摔倒 / 求救被服务端判为 invalid 只留档不建单：出队是对的（重发也不会变合法），但不能只 devLog——骑手以为求救已发出。
      // 计数不分条，只知道这一批里有求救且有 invalid；App 自建 envelope 几乎不会 invalid，真发生多半是协议漂移（10-15 复审 F-3）
      if (
        counts.invalid > 0 &&
        batch.some((e) => SOS_TRIGGER_TYPES.has(e.eventType))
      ) {
        console.error(
          `[BLE-RELAY] ${dev} 这一批含摔倒 / 求救，其中 ${counts.invalid} 条被服务端判为 invalid（只留档、不建单）`,
        );
      }
      // 这一批里有摔倒 / 求救且服务端已入库：此刻 JS 在跑、网络刚被持锁打开——是唯一不依赖
      // WS 存活或远程推送到达就能确认「云端已建单」并拉起倒计时页的时机（10-06 不变式评审 F-1）。
      // duplicate 也算：第一次提交到了服务端但响应丢了（深睡刚醒的 SSL 读错误就是这种），重传按原
      // eventId 回 duplicate——单子早就建好了，只看 accepted 会漏掉这次拉起（10-14 代码审查）
      let resumed: Promise<unknown> | undefined;
      if (
        counts.accepted + counts.duplicate > 0 &&
        batch.some((e) => SOS_TRIGGER_TYPES.has(e.eventType))
      ) {
        resumed = notifyCriticalAccepted(dev);
      }
      if (resumed) {
        // 补拉进行中的求救（拉起倒计时页 / 带「我没事，取消」的锁屏提醒）要在网络锁里跑完：深睡的华为一放锁
        // 网络就挂起，这一下补拉落空就只剩极光那条没按钮的通知（10-25 审查）。不阻塞上行队列，最多等 30 s
        resumesPending += 1;
        void Promise.race([
          resumed,
          new Promise((r) => setTimeout(r, RESUME_HOLD_MAX_MS)),
        ]).then(() => {
          resumesPending -= 1;
          releaseNetworkIfIdle();
        });
      } else releaseNetworkIfIdle();
      devLog(
        "BLE-RELAY",
        `已中转 ${dev} accepted=${counts.accepted} duplicate=${counts.duplicate} invalid=${counts.invalid}` +
          // 只写条数：积压时队列最多 1000 条（约 26 KB），每次 flush 都整条拼进日志会刷屏
          (queue.length > 0 ? `(缓存剩余 ${queue.length})` : ""),
      );
    } catch (e) {
      if ((e as { status?: unknown })?.status === 413 && batch.length > 1) {
        batchLimit = Math.max(1, Math.floor(batch.length / 2));
        rerunAfterFlush = true;
        devLog(
          "BLE-RELAY",
          `${dev} 这一批太大(413)，批量减到 ${batchLimit} 条立即重试`,
          e,
        );
      } else if (isUnrecoverableRelayError(e)) {
        // 这台设备在当前账号下永远送不出去（已解绑/换账号）：丢掉它的积压，别拖住其他设备
        const doomed = new Set(mine);
        queue = queue.filter((x) => !doomed.has(x));
        devLog(
          "BLE-RELAY",
          `${dev} 的 ${mine.length} 条事件被服务端拒绝(不可重试),已丢弃`,
          e,
        );
        endBacklogDrain();
        // 别处解绑了这顶、这台手机在后台不知道：还连着就还在回 ACK，头盔擦掉、事件又被这里丢掉。
        // 目标原来只靠页面轮询和回前台刷新（11-01 审计）
        relayRejected?.();
      } else {
        devLog("BLE-RELAY", "中转提交失败,保留缓存下轮重试", e);
        endBacklogDrain();
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

/** 手机里还没传上去的头盔事件：总数、其中摔倒 / 求救几条（退出登录前提示用，O21） */
export function relayBacklog(): { total: number; sos: number } {
  return {
    total: queue.length,
    sos: queue.filter((e) => SOS_TRIGGER_TYPES.has(e.eventType)).length,
  };
}

const waitMs = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, Math.max(0, ms)));

/**
 * 退出登录前尽力把积压送完（负责人 10-21 定，O21）：一轮轮提交，送完、到时限、或某一轮一条没送出去（断网 / 被拒）为止，
 * 返回剩下的。退出后这些要等这个账号下次在这台手机上登录才补传——换个账号登录不会替它传。
 */
export async function drainRelayQueue(
  timeoutMs: number,
): Promise<{ total: number; sos: number }> {
  const until = Date.now() + timeoutMs;
  while (queue.length > 0 && Date.now() < until) {
    // 周期提交正在途：等它回来再看，别把「它还没回来」当成「送不出去」
    if (flushing) {
      await waitMs(Math.min(200, until - Date.now()));
      continue;
    }
    const before = queue.length;
    await Promise.race([flushRelayQueue(), waitMs(until - Date.now())]);
    if (queue.length >= before) break;
  }
  return relayBacklog();
}

/**
 * 登录期间常驻(use-realtime 同生命周期)：恢复本账号的持久化队列 + 周期 flush。
 * ownerKey = 当前用户 id；未登录/未知时用匿名分区，绝不与真实账号的文件混用。
 */
export function startRelayUplink(ownerKey: string = ANONYMOUS_OWNER): void {
  if (flushTimer) return;
  owner = ownerKey;
  const mine = { owner: ownerKey, saved: store.load(ownerKey) };
  loading = mine;
  void mine.saved.then((saved) => {
    // 恢复期间已 stop / 换账号 / 又起了一次：那边负责（stop 把这份和当时的内存合并写回）。按身份判断，不按归属键——
    // 匿名分区 stop 之后归属还是匿名，按归属判断会把它当成没停。按 eventId 去重，重入不会出现两份（审计 BLE-07）
    if (loading !== mine) return;
    loading = null;
    if (owner !== ownerKey) return;
    if (saved.length > 0) queue = mergeSaved(saved, queue);
    persist();
  });
  flushTimer = setInterval(() => void flushRelayQueue(), FLUSH_INTERVAL_MS);
  // Node/jest 里不让定时器拖住进程退出；RN 的 setInterval 返回数字，无此方法
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

/** eventId 只在一台头盔内唯一（决策 #54）：去重键带上头盔号，与服务端 (device_id, event_id) 幂等同口径（10-16 A13） */
const dedupeKey = (e: Envelope): string => `${e.deviceId}:${e.eventId}`;

/**
 * 同一会话里档案晚到（钥匙串只有 token、user 要等 /users/me）：匿名分区里已收到的事件都是这个 token 下的，
 * 换到本人名下时带过去，再并入本人分区之前落盘的积压。真正的「未登录 → 别人登录」走 stop + start，不经这里。
 * 原来是 stop（落到匿名文件）再 start(uid)，匿名期间首发失败的摔倒就留在匿名文件里不再补传（10-16 A6）
 */
export function adoptRelayUplinkOwner(ownerKey: string): boolean {
  if (ownerKey === ANONYMOUS_OWNER || owner !== ANONYMOUS_OWNER) return false;
  owner = ownerKey;
  // 先读本人分区再落盘：save 不等待、同步就写文件，先 persist 会把上次没送完的那份覆盖掉。
  // 匿名文件等合并落盘之后再清，中途被杀也不丢
  const mine = { owner: ownerKey, saved: store.load(ownerKey) };
  loading = mine;
  void mine.saved.then((saved) => {
    if (loading !== mine) return;
    loading = null;
    if (owner !== ownerKey) return;
    if (saved.length > 0) queue = mergeSaved(saved, queue);
    persist();
    void store.save(ANONYMOUS_OWNER, []);
  });
  return true;
}

/** 退出登录/切换账号：落盘到本账号分区并清空内存，下一个账号从自己的分区开始 */
export function stopRelayUplink(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  const pending = loading && loading.owner === owner ? loading : null;
  if (pending) {
    // 积压还没读进内存就停了：等读完，把文件里的和此刻内存里的合在一起写回本人分区，不拿缺了积压的内存那份盖文件
    const stoppedOwner = owner;
    const mem = queue;
    loading = null;
    void pending.saved.then((saved) => {
      if (discardedOwners.has(stoppedOwner)) return;
      void store.save(stoppedOwner, mergeSaved(saved, mem));
    });
  } else {
    persist();
  }
  queue = [];
  endBacklogDrain();
  deviceCursor = 0;
  batchLimit = MAX_BATCH;
  owner = ANONYMOUS_OWNER;
}
