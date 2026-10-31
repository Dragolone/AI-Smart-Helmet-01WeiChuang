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
/**
 * 连上之后稳住这么久（或先收到一条消息）才清零退避。服务端先接受握手、验完 token 才以 4401 关掉，
 * onopen 不代表鉴权通过：原来一 open 就清零，被拒的 token 每秒重连一次、每次都去刷新 token（10-17 评审）
 */
export const STABLE_MS = 5_000;

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
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * 代次：start / stop / kick 各加一。4401 之后的换 token 是异步的，回来时若代次已变
   * （期间回了前台 kick 过、或登出又登录），它那一轮重连就不该再排——否则两路各建一条连接，
   * 先建的那条被 `this.ws` 覆盖后成了没人关的孤儿，一直挂到 token 过期（2026-10-05 评审）。
   */
  private epoch = 0;
  /**
   * 本轮（稳住一次就清零）里被 4401 之后真正换到新 token 的次数。断网期间 access token 到期是常事（15 min）：
   * 网络一恢复、第一次重连就被 4401，刷新成功后若还按断网攒下的退避（16–30 s）干等，实时通道白白空一轮
   * （2026-10-24 安卓模拟器断网 23 s 实测：恢复 → 4401 → 换好 token → 等了 16 s 才连）。
   * 所以本轮第一次「确实换到了新 token」就立刻重连；之后再换照 10-17 口径退避照涨，坏 token 仍刷不起来。
   * 按「换到新 token」算而不按「被拒第几次」算：第一次刷新撞上断网失败、第二次才换到时，快速重连的额度不能被失败那次吃掉（10-29 评审）
   */
  private freshTokensInStreak = 0;

  start(deps: Deps): void {
    this.deps = deps;
    if (this.running) return;
    this.running = true;
    this.epoch += 1;
    this.attempts = 0;
    this.freshTokensInStreak = 0;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.epoch += 1;
    this.setConnected(false);
    this.clearStable();
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

  /**
   * 连接看着还在、其实已经收不到东西（半开：静默丢包时 onclose 迟迟不来，kick 又因为「已连上」直接返回）：扔掉重连。
   * 前台核对发现「服务端有单、这条连接没推过来」时调用（11-01 模拟器实测）
   */
  reconnect(): void {
    if (!this.running) return;
    this.setConnected(false);
    this.kick();
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

  private clearStable(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  /** 这条连接确实可用（稳住了 / 收到了消息）：退避清零 */
  private markStable(): void {
    this.clearStable();
    this.attempts = 0;
    this.freshTokensInStreak = 0;
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
    this.clearStable();
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // stop() 或新连接已接管：迟到的 open 不能把状态翻回已连接
      this.setConnected(true);
      devLog("realtime", "已连接");
      this.clearStable();
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.ws === ws) this.markStable();
      }, STABLE_MS);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return; // 同上：被放弃的连接上迟到的消息不再分发
      // 服务端只给鉴权通过的连接推消息：收到一条就算稳了
      if (this.stableTimer) this.markStable();
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
      this.clearStable();
      if (!this.running) return;
      if (event.code === CLOSE_UNAUTHORIZED) {
        // 这条连接用的 token 已经被换掉了（别的请求顺手刷新过）：直接拿新的重连，不再刷新一遍
        if (this.deps?.getAccessToken() !== token) {
          this.resetBackoffForFreshToken(token);
          this.scheduleReconnect();
          return;
        }
        // token 过期：借 api 层完成刷新后重连（失败则走常规退避）。连续被拒时退避照涨（没稳住不清零）。
        // 刷新期间若 kick / stop / start 过，那一方已经接管了重连，这里作罢
        const epoch = this.epoch;
        void this.deps
          ?.triggerTokenRefresh()
          .catch(() => undefined)
          .finally(() => {
            if (this.epoch !== epoch) return;
            // 确实换到了新 token：不再等断网攒下的那轮退避。按「换到的那张 token」只清一次，
            // 不按「本轮第几次被拒」算——第一次刷新撞上断网失败、第二次才换到新 token 时，照样该立刻重连（10-29 评审）
            this.resetBackoffForFreshToken(token);
            this.scheduleReconnect();
          });
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose 会随后触发并统一走重连，这里仅防未处理事件告警
    };
  }

  /** 被拒的那条连接用的是 refused；现在手里的 token 若已不同，就是本轮又换到一张新的——第一张清零退避 */
  private resetBackoffForFreshToken(refused: string | null): void {
    const fresh = this.deps?.getAccessToken() ?? null;
    if (!fresh || fresh === refused) return;
    this.freshTokensInStreak += 1;
    if (this.freshTokensInStreak > 1 || this.attempts === 0) return;
    devLog("realtime", "token 已换新，退避清零");
    this.attempts = 0;
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
