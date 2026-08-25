// App 中转传输（MVP 唯一真机链路，API.md §12.1 / DEVICE_PROTOCOL §1.1，决策 #31/#35）：
// 模拟"手机 App 收到 BLE 事件后批量转交云端"，用来在硬件 BLE 协议与 A 线中转模块就绪前，
// 用同一套剧本把服务端侧这条链路跑通——批量提交、断线缓存、按原 eventId 补传、重复去重。
//
// 与真机 App 的一致性：envelope 内容、eventId 幂等规则、7 种事件范围完全按 Contract，
// 服务端无法区分这是 Mock 还是真 App（CLAUDE.md Mock Data Strategy）。
import { BLE_RELAY_EVENT_TYPES } from '@helmet/shared';
import type {
  AppRelayResponse,
  EventEnvelope,
  EventType,
  RelayAckResponse,
  WsDeviceCommandData,
  WsMessage,
} from '@helmet/shared';
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
  /** 命令回执行为（与 MQTT 模式的 MOCK_CMD_RESULT 同三态）：success | failed | silent（不回 executed，演示 offline） */
  cmdResult: 'success' | 'failed' | 'silent';
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

  // —— 下行命令（决策 #36）：WS 收 device_command → 模拟 BLE 写入（relay-ack delivered）
  //    → 模拟头盔执行后回执（relay-ack executed）。commandId 去重：连接补推会重复送达。 ——
  const seenCommands = new Set<string>();
  let ws: WebSocket | null = null;
  let wsClosed = false;

  const relayAckPath = (commandId: string): string =>
    `/api/v1/devices/${deviceId}/commands/${commandId}/relay-ack`;

  const postAck = async (commandId: string, body: unknown): Promise<void> => {
    let { status, json } = await post(relayAckPath(commandId), body, true);
    if (status === 401) {
      await reauth();
      ({ status, json } = await post(relayAckPath(commandId), body, true));
    }
    if (status !== 200) {
      log(`relay-ack 失败 ${status}：${JSON.stringify(json)}`);
      return;
    }
    const r = json as RelayAckResponse;
    log(`已回执 ${JSON.stringify(body)} → 服务端状态 ${r.status}（${commandId.slice(0, 8)}…）`);
  };

  const handleCommand = (msg: WsMessage<WsDeviceCommandData>): void => {
    const cmd = msg.data;
    if (cmd.deviceId !== deviceId) return; // 同账号其他设备的命令，本"头盔"不认
    if (seenCommands.has(cmd.commandId)) {
      log(`重复命令已跳过（连接补推的幂等语义）：${cmd.commandId.slice(0, 8)}…`);
      return;
    }
    seenCommands.add(cmd.commandId);
    log(`收到命令 ${cmd.type}（${cmd.commandId.slice(0, 8)}…）params=${JSON.stringify(cmd.params)}`);
    // 模拟 App 经 BLE 写入头盔成功 → delivered
    void postAck(cmd.commandId, { stage: 'delivered' });
    if (cfg.cmdResult === 'silent') {
      log('（MOCK_CMD_RESULT=silent：头盔不回执行结果，服务端将超时判 offline）');
      return;
    }
    // 模拟头盔执行耗时后回执（与 MQTT 模式同 500ms）
    setTimeout(() => {
      void postAck(cmd.commandId, {
        stage: 'executed',
        result: cfg.cmdResult,
        ...(cfg.cmdResult === 'failed' ? { errorCode: 'MOCK_REJECTED' } : {}),
        executedAt: new Date().toISOString(),
      });
    }, 500);
  };

  const connectWs = (): void => {
    if (wsClosed) return;
    const wsUrl = `${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(accessToken)}`;
    ws = new WebSocket(wsUrl); // Node 24 原生 WebSocket，零依赖
    ws.onopen = () => log('WS 已连接（监听下行命令 device_command）');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsMessage<WsDeviceCommandData>;
        if (msg.type === 'device_command') handleCommand(msg);
      } catch {
        /* 非 JSON 消息忽略 */
      }
    };
    ws.onclose = (ev) => {
      if (wsClosed) return;
      // 4401 = token 失效：刷新后重连；其他断开固定退避重连
      const fix = ev.code === 4401 ? reauth() : Promise.resolve();
      void fix.finally(() => setTimeout(connectWs, 5000));
      log(`WS 断开（code=${ev.code}），5s 后重连`);
    };
    ws.onerror = () => {
      /* 错误后必触发 onclose，重连逻辑在那里 */
    };
  };

  return {
    start(onReady) {
      log(`中转模式：事件经 HTTP 提交 ${base}/api/v1/ingest/app-relay（模拟手机 App 中转）`);
      login()
        .then(() => {
          log(`已登录 ${phone}，设备 ${deviceId} 必须已绑定到该账号，否则中转返回 404`);
          flushTimer = setInterval(() => void flush(), cfg.flushIntervalMs);
          connectWs();
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
      wsClosed = true;
      ws?.close();
      if (flushTimer) clearInterval(flushTimer);
      // 退出前尽力把缓存交出去，模拟 App 退到后台前的最后一次提交
      void flush().finally(() => {
        if (queue.length > 0) log(`退出时仍有 ${queue.length} 条未提交（真机 App 会持久化后下次补传）`);
        done();
      });
    },
  };
}
