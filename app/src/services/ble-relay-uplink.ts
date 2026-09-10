// BLE 上行中转队列骨架（决策 #29/#31/#35,API.md §12.1;参考 mock-device/relay-transport.ts）。
// 职责:BLE 事件 → 过滤(7 种)→ 入队 → 批量提交 /ingest/app-relay(单批 ≤100)→
// 失败原样保留、按原 eventId 补传(服务端幂等,重复返回 duplicate 计数不报错)。
// 现状:BLE GATT 协议未定(硬件前置),生产者只有未来的 BLE 模块与 __DEV__ 注入;
// 队列经 expo-file-system 持久化到 documentDirectory,App 被杀后启动恢复补传。
import { BLE_RELAY_EVENT_TYPES } from '@helmet/shared';
import type { EventEnvelope, EventType } from '@helmet/shared';
import { File, Paths } from 'expo-file-system';

import { relayApi } from '@/api/relay';

const RELAY_SCOPE = new Set<string>(BLE_RELAY_EVENT_TYPES);
/** 离线缓存上限:溢出丢最旧并告警,绝不静默截断(与参考实现同口径) */
const QUEUE_MAX = 1000;
/** Contract 硬上限(API.md §12.1) */
const MAX_BATCH = 100;
const FLUSH_INTERVAL_MS = 5_000;

/** 队列持久化接口:内存版为骨架默认;文件版(expo-file-system)随 BLE 原生依赖批次加 */
interface RelayQueueStore {
  load(): Promise<EventEnvelope<EventType>[]>;
  save(queue: EventEnvelope<EventType>[]): Promise<void>;
}
/** 文件持久化:documentDirectory 下 JSON 快照,App 被杀后启动时恢复补传。
 *  所有 IO 包 try/catch:持久化失败绝不阻塞保命链路(内存队列照常工作)。 */
const fileStore: RelayQueueStore = {
  async load() {
    try {
      const f = new File(Paths.document, 'ble-relay-queue.json');
      if (!f.exists) return [];
      return JSON.parse(f.textSync()) as EventEnvelope<EventType>[];
    } catch (e) {
      console.warn('[BLE-RELAY] 队列恢复失败(忽略,从空队列开始)', e);
      return [];
    }
  },
  async save(q) {
    try {
      const f = new File(Paths.document, 'ble-relay-queue.json');
      f.write(JSON.stringify(q));
    } catch (e) {
      console.warn('[BLE-RELAY] 队列持久化失败(忽略,仅内存)', e);
    }
  },
};
const store: RelayQueueStore = fileStore;

let queue: EventEnvelope<EventType>[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

/** BLE 模块收到头盔事件后调用:范围外事件本地丢弃(蓝牙版 MVP 只中转 7 种,决策 #31) */
export function enqueueRelayEvent(envelope: EventEnvelope<EventType>): void {
  if (!RELAY_SCOPE.has(envelope.eventType)) {
    console.warn(`[BLE-RELAY] 范围外事件不中转:${envelope.eventType}`);
    return;
  }
  queue.push(envelope);
  if (queue.length > QUEUE_MAX) {
    queue.shift();
    console.warn(`[BLE-RELAY] 缓存溢出(>${QUEUE_MAX}),丢弃最旧一条`);
  }
  void store.save(queue);
}

/** 批量提交:成功才出队;失败/断网原样保留,下轮按原 eventId 补传 */
export async function flushRelayQueue(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  try {
    // 一批只提交一个设备(接口按设备鉴权);多设备时下一轮接着提交其余设备
    const dev = queue[0].deviceId;
    const batch = queue.filter((e) => e.deviceId === dev).slice(0, MAX_BATCH);
    const counts = await relayApi.push({ deviceId: dev, envelopes: batch });
    // 202 = 整批已消化(accepted/duplicate 入库,invalid 服务端留档不重试)→ 整批出队
    const sent = new Set(batch);
    queue = queue.filter((e) => !sent.has(e));
    console.log(
      `[BLE-RELAY] 已中转 accepted=${counts.accepted} duplicate=${counts.duplicate} invalid=${counts.invalid}` +
        (queue.length > 0 ? `(缓存剩余 ${queue.length})` : ''),
    );
    void store.save(queue);
  } catch (e) {
    console.warn('[BLE-RELAY] 中转提交失败,保留缓存下轮重试', e);
  } finally {
    flushing = false;
  }
}

/** 登录期间常驻(use-realtime 同生命周期):恢复持久化队列 + 周期 flush */
export function startRelayUplink(): void {
  if (flushTimer) return;
  void store.load().then((saved) => {
    if (saved.length > 0) queue = [...saved, ...queue];
  });
  flushTimer = setInterval(() => void flushRelayQueue(), FLUSH_INTERVAL_MS);
}

export function stopRelayUplink(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
