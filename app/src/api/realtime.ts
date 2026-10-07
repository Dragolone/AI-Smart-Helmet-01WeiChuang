// App 实时通道客户端（API.md §11 / backend realtime.gateway）：
// - `ws://<host>/ws?token=<accessToken>`，服务端按用户自动推送，无订阅指令；
// - 加速通道不是可靠通道：断线指数退避重连，REST 轮询继续作为兜底；
// - 4401（token 失效）→ 触发一次认证请求让 api 层静默刷新，再用新 token 重连。
import type { WsMessage } from "@helmet/shared";

import { API_BASE_URL } from "@/constants/api";
import { devLog } from "@/services/dev-log";

/** http(s)://host[:port]/api/v1 → ws(s)://host[:port]/ws */
const WS_URL = API_BASE_URL.replace(/^http/, "ws").replace(
  /\/api\/v1\/?$/,
  "/ws",
);

const CLOSE_UNAUTHORIZED = 4401;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

type Listener = (message: WsMessage) => void;
type StateListener = (connected: boolean) => void;

type Deps = {
  getAccessToken: () => string | null;
  /** 任意需要鉴权的轻请求：401 时由 api 层完成 refresh 轮换（见 client.ts） */
  triggerTokenRefresh: () => Promise<unknown>;
};

class RealtimeClient {
  private deps: Deps | null = null;
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private connected = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * 代次：start / stop / kick 各加一。4401 之后的换 token 是异步的，回来时若代次已变
   * （期间回了前台 kick 过、或登出又登录），它那一轮重连就不该再排——否则两路各建一条连接，
   * 先建的那条被 `this.ws` 覆盖后成了没人关的孤儿，一直挂到 token 过期（2026-10-05 评审）。
   */
  private epoch = 0;

  start(deps: Deps): void {
    this.deps = deps;
    if (this.running) return;
    this.running = true;
    this.epoch += 1;
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.epoch += 1;
    this.setConnected(false);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  /**
   * 立刻重连（清零退避）：断网期间退避会涨到 16–30 s，网络恢复后还得干等那一轮
   * （2026-09-26 iPhone 飞行模式实测：提示条在恢复后拖了十几秒才消失）。
   * 回前台 / 用户明显有动作时调用；已连上或没在运行时什么都不做。
   */
  kick(): void {
    if (!this.running || this.connected) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.epoch += 1;
    this.attempts = 0;
    // 上一条连接可能还卡在握手阶段（断网时 onclose 迟迟不来）：直接放弃它，onclose 会被 `this.ws !== ws` 挡掉
    const stale = this.ws;
    this.ws = null;
    stale?.close();
    devLog("realtime", "立即重连（退避清零）");
    this.connect();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 连接状态订阅(加速通道健康度,UI 提示用);订阅时立即回放当前值 */
  subscribeState(listener: StateListener): () => void {
    listener(this.connected);
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    for (const l of this.stateListeners) l(v);
  }

  private connect(): void {
    if (!this.running || !this.deps) return;
    const token = this.deps.getAccessToken();
    if (!token) {
      // 未登录：等下一次 start（登录后由 hook 重新驱动）
      this.running = false;
      return;
    }
    // 任何时候只留一条连接：万一还有一条没收掉的，先放弃它（它的回调都会被 `this.ws !== ws` 挡掉）
    const stale = this.ws;
    this.ws = null;
    stale?.close();
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // stop() 或新连接已接管：迟到的 open 不能把状态翻回已连接
      this.attempts = 0;
      this.setConnected(true);
      devLog("realtime", "已连接");
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return; // 同上：被放弃的连接上迟到的消息不再分发
      try {
        const message = JSON.parse(String(event.data)) as WsMessage;
        for (const listener of this.listeners) listener(message);
      } catch {
        if (__DEV__) console.warn("[realtime] 消息解析失败，已忽略");
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return; // stop() 或新连接已接管
      devLog(
        "realtime",
        `连接关闭 code=${event.code} reason=${event.reason || "(空)"}`,
      );
      this.ws = null;
      this.setConnected(false);
      if (!this.running) return;
      if (event.code === CLOSE_UNAUTHORIZED) {
        // token 过期：借 api 层完成刷新后立刻重连（失败则走常规退避）。
        // 刷新期间若 kick / stop / start 过，那一方已经接管了重连，这里作罢
        const epoch = this.epoch;
        void this.deps
          ?.triggerTokenRefresh()
          .catch(() => undefined)
          .finally(() => {
            if (this.epoch === epoch) this.scheduleReconnect();
          });
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose 会随后触发并统一走重连，这里仅防未处理事件告警
    };
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** this.attempts,
      BACKOFF_MAX_MS,
    );
    this.attempts += 1;
    devLog("realtime", `${delay}ms 后重连（第 ${this.attempts} 次）`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const realtimeClient = new RealtimeClient();
