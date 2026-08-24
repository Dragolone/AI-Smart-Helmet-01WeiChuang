// App 中转传输（MVP 唯一真机链路，API.md §12.1 / DEVICE_PROTOCOL §1.1，决策 #31/#35）：
// 模拟"手机 App 收到 BLE 事件后批量转交云端"，用来在硬件 BLE 协议与 A 线中转模块就绪前，
// 用同一套剧本把服务端侧这条链路跑通——批量提交、断线缓存、按原 eventId 补传、重复去重。
//
// 与真机 App 的一致性：envelope 内容、eventId 幂等规则、7 种事件范围完全按 Contract，
// 服务端无法区分这是 Mock 还是真 App（CLAUDE.md Mock Data Strategy）。
import { BLE_RELAY_EVENT_TYPES } from '@helmet/shared';
import type { AppRelayResponse, EventEnvelope, EventType } from '@helmet/shared';
import type { EventKind, Log, Transport } from './transport.ts';

const RELAY_SCOPE = new Set<string>(BLE_RELAY_EVENT_TYPES);

export interface RelayConfig {
  apiBaseUrl: string;
  deviceId: string;
  phone: string;
  password: string;
  /** 批量提交间隔（ms）：真机 App 会攒一小批再发，省电省流量 */
  flushIntervalMs: number;
  /** 单批上限，Contract 硬上限 100（API.md §12.1） */
  maxBatch: number;
  /** 每隔几次 flush 故意断一次网（模拟隧道/电梯）；0 = 不模拟 */
  offlineCycle: number;
  /** 是否把范围外事件也发出去（用于验证服务端的超范围留档行为）；默认 false = 像真 App 一样过滤 */
  sendOutOfScope: boolean;
  log: Log;
}

// 缓存上限：真机 App 的离线缓存也有边界。溢出时丢最旧并告警——绝不静默截断。
const QUEUE_MAX = 1000;

export function createRelayTransport(cfg: RelayConfig): Transport {
  const { apiBaseUrl, deviceId, phone, password, log } = cfg;
  const base = apiBaseUrl.replace(/\/+$/, '');
  const queue: EventEnvelope<EventType>[] = [];
  let accessToken = '';
  let refreshToken = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let flushCount = 0;
  let flushing = false;
  let droppedOutOfScope = 0;

  const post = async (
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json: unknown = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };

  const login = async (): Promise<void> => {
    const { status, json } = await post('/api/v1/auth/login', { phone, password }, false);
    if (status !== 200 && status !== 201) {
      throw new Error(
        `登录失败 ${status}：${JSON.stringify(json)}——检查 RELAY_PHONE / RELAY_PASSWORD，账号需先在 App 或 Admin 注册`,
      );
    }
    const t = json as { accessToken: string; refreshToken: string };
    accessToken = t.accessToken;
    refreshToken = t.refreshToken;
  };

  /** access 过期时先刷新，刷新也失败就重登（真机 App 的 401 处理同款） */
  const reauth = async (): Promise<void> => {
    try {
      const { status, json } = await post('/api/v1/auth/refresh', { refreshToken }, false);
      if (status === 200 || status === 201) {
        const t = json as { accessToken: string; refreshToken: string };
        accessToken = t.accessToken;
        refreshToken = t.refreshToken;
        return;
      }
    } catch {
      /* 落到重登 */
    }
    await login();
  };

  const flush = async (): Promise<void> => {
    if (flushing || queue.length === 0) return;
    flushing = true;
    flushCount += 1;
    try {
      // 模拟断网：队列原样保留，下一轮按原 eventId 补传（服务端幂等消化重复）
      if (cfg.offlineCycle > 0 && flushCount % cfg.offlineCycle === 0) {
        log(`📵 模拟断网（第 ${flushCount} 次 flush）：${queue.length} 条留在缓存，下轮补传`);
        return;
      }
      const batch = queue.slice(0, cfg.maxBatch);
      let { status, json } = await post(
        '/api/v1/ingest/app-relay',
        { deviceId, envelopes: batch },
        true,
      );
      if (status === 401) {
        await reauth();
        ({ status, json } = await post(
          '/api/v1/ingest/app-relay',
          { deviceId, envelopes: batch },
          true,
        ));
      }
      if (status !== 202) {
        // 404 DEVICE_NOT_FOUND 是最常见的坑：设备没绑到这个账号上
        log(`中转提交失败 ${status}：${JSON.stringify(json)}（保留缓存，下轮重试）`);
        return;
      }
      const counts = json as AppRelayResponse;
      queue.splice(0, batch.length);
      log(
        `📤 已中转 ${batch.length} 条 → accepted=${counts.accepted} duplicate=${counts.duplicate} invalid=${counts.invalid}` +
          (queue.length > 0 ? `（缓存剩余 ${queue.length}）` : ''),
      );
    } catch (err) {
      log(`中转异常：${(err as Error).message}（保留缓存，下轮重试）`);
    } finally {
      flushing = false;
    }
  };

  return {
    start(onReady) {
      log(`中转模式：事件经 HTTP 提交 ${base}/api/v1/ingest/app-relay（模拟手机 App 中转）`);
      log('⚠️ 下行命令（设置下发）在本链路上没有通道——4G 链路走 MQTT cmd，BLE 链路的下行 Contract 尚未定义');
      login()
        .then(() => {
          log(`已登录 ${phone}，设备 ${deviceId} 必须已绑定到该账号，否则中转返回 404`);
          flushTimer = setInterval(() => void flush(), cfg.flushIntervalMs);
          onReady();
        })
        .catch((err: Error) => {
          log(`❌ ${err.message}`);
          process.exit(1);
        });
    },

    send(_kind: EventKind, envelope: EventEnvelope<EventType>) {
      // 蓝牙版第一期只中转 7 种事件（DEVICE_PROTOCOL §1.1）——真机 App 也应在本地过滤，
      // 不该把范围外事件推给云端；sendOutOfScope 打开时故意发出，用于验证服务端的留档告警行为。
      if (!RELAY_SCOPE.has(envelope.eventType) && !cfg.sendOutOfScope) {
        droppedOutOfScope += 1;
        if (droppedOutOfScope <= 3) {
          log(
            `⏭️ ${envelope.eventType} 不在蓝牙版第一期中转范围（DEVICE_PROTOCOL §1.1），本地跳过` +
              (droppedOutOfScope === 3 ? '（后续同类不再逐条提示）' : ''),
          );
        }
        return;
      }
      if (queue.length >= QUEUE_MAX) {
        queue.shift();
        log(`⚠️ 离线缓存已满（${QUEUE_MAX} 条），丢弃最旧一条`);
      }
      queue.push(envelope);
      log(`已入队 ${envelope.eventType} (eventId=${envelope.eventId.slice(0, 8)}…) 队列=${queue.length}`);
    },

    stop(done) {
      if (flushTimer) clearInterval(flushTimer);
      // 退出前尽力把缓存交出去，模拟 App 退到后台前的最后一次提交
      void flush().finally(() => {
        if (queue.length > 0) log(`退出时仍有 ${queue.length} 条未提交（真机 App 会持久化后下次补传）`);
        done();
      });
    },
  };
}
