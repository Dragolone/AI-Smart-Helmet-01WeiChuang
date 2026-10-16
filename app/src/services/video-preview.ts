// 实时视频预览（决策 #37/#49，DEVICE_PROTOCOL §1.3）的纯逻辑：常量 + 页面状态机。
// 页面只负责接线（原生 Wi-Fi、播放器回调、AppState），判断都在这里，便于单测。
import type { MessageKey } from "@/i18n";

/** 头盔 SoftAP 与拉流约定（§1.3，硬件 2026-09-23 定稿；无鉴权，端口 8554 不是 554） */
export const HELMET_HOTSPOT = {
  ssid: "X821cam",
  passphrase: "Aa123456",
  streamUrl: "rtsp://192.168.176.1:8554/ch0",
} as const;

/** libVLC 参数沿用 Spike：§1.3 要求强制 RTSP over TCP；无音频；低缓存、迟到帧直接丢 */
export const VLC_INIT_OPTIONS = [
  "--rtsp-tcp",
  "--network-caching=150",
  "--no-audio",
  "--drop-late-frames",
  "--skip-frames",
];

/** 首帧前等多久开始提示「检查 Wi-Fi」（§1.3 ③：约 5 s） */
export const NO_PICTURE_HINT_MS = 5_000;
/** 系统连热点弹窗 + 关联的最长等待 */
export const JOIN_TIMEOUT_MS = 30_000;

export type PreviewPhase =
  | "joining" // 正在连头盔热点
  | "manual" // 需要用户去系统设置手动连（Android 8/9 或自动连接不可用）
  | "connecting" // 热点已就绪，等 RTSP 首帧
  | "playing"
  | "paused" // 退后台 / 让位求救上报
  | "error";

export type PauseReason = "background" | "sos";

export interface PreviewState {
  phase: PreviewPhase;
  /** 每次重新开始 +1：页面用它作为播放器 key，保证重试是一次全新的连接 */
  attempt: number;
  /** connecting 超过 NO_PICTURE_HINT_MS 仍无画面 */
  stalled: boolean;
  errorKey?: MessageKey;
  pauseReason?: PauseReason;
}

export type PreviewAction =
  | { type: "retry" }
  | { type: "joined" }
  | { type: "joinFailed"; code?: string }
  | { type: "manualNoWifi" }
  | { type: "firstFrame" }
  | { type: "noPictureTimeout" }
  | { type: "playerError" }
  | { type: "streamEnded" }
  | { type: "wifiLost" }
  | { type: "suspend"; reason: PauseReason }
  | { type: "foreground" };

export const initialPreviewState: PreviewState = {
  phase: "joining",
  attempt: 1,
  stalled: false,
};

const JOIN_ERROR_KEYS: Record<string, MessageKey> = {
  USER_DENIED: "video.err.denied",
  UNAVAILABLE: "video.err.notFound",
  BIND_FAILED: "video.err.bind",
};

/** 需要占用头盔 Wi-Fi 的阶段（离开这些阶段就该释放，把网络还给云端上报） */
export const holdsHelmetWifi = (phase: PreviewPhase): boolean =>
  phase === "joining" || phase === "connecting" || phase === "playing";

/** 播放器应处于挂载状态的阶段 */
export const showsPlayer = (phase: PreviewPhase): boolean =>
  phase === "connecting" || phase === "playing";

const restart = (s: PreviewState): PreviewState => ({
  phase: "joining",
  attempt: s.attempt + 1,
  stalled: false,
});

export function previewReducer(
  s: PreviewState,
  a: PreviewAction,
): PreviewState {
  switch (a.type) {
    case "retry":
      return restart(s);
    case "joined":
      return s.phase === "joining" || s.phase === "manual"
        ? { phase: "connecting", attempt: s.attempt, stalled: false }
        : s;
    case "joinFailed":
      if (s.phase !== "joining") return s;
      if (a.code === "MANUAL_REQUIRED")
        return { phase: "manual", attempt: s.attempt, stalled: false };
      return {
        phase: "error",
        attempt: s.attempt,
        stalled: false,
        // 只认表里自己的键：码叫 toString / constructor 时普通下标会取到原型上的函数，当成文案 key 显示成空白
        errorKey:
          (a.code !== undefined &&
            Object.prototype.hasOwnProperty.call(JOIN_ERROR_KEYS, a.code) &&
            JOIN_ERROR_KEYS[a.code]) ||
          "video.err.notFound",
      };
    case "manualNoWifi":
      return s.phase === "manual" ? { ...s, errorKey: "video.err.noWifi" } : s;
    case "firstFrame":
      return s.phase === "connecting"
        ? { phase: "playing", attempt: s.attempt, stalled: false }
        : s;
    case "noPictureTimeout":
      return s.phase === "connecting" ? { ...s, stalled: true } : s;
    case "playerError":
      return showsPlayer(s.phase)
        ? {
            phase: "error",
            attempt: s.attempt,
            stalled: false,
            errorKey: "video.err.stream",
          }
        : s;
    case "streamEnded":
      return s.phase === "playing"
        ? {
            phase: "error",
            attempt: s.attempt,
            stalled: false,
            errorKey: "video.err.streamEnded",
          }
        : s;
    case "wifiLost":
      return holdsHelmetWifi(s.phase)
        ? {
            phase: "error",
            attempt: s.attempt,
            stalled: false,
            errorKey: "video.err.wifiLost",
          }
        : s;
    case "suspend":
      // 求救优先级最高：已因退后台暂停的也改记为求救，回前台不自动重连，由用户决定
      if (a.reason === "sos")
        return {
          phase: "paused",
          attempt: s.attempt,
          stalled: false,
          pauseReason: "sos",
        };
      return holdsHelmetWifi(s.phase)
        ? {
            phase: "paused",
            attempt: s.attempt,
            stalled: false,
            pauseReason: "background",
          }
        : s;
    case "foreground":
      return s.phase === "paused" && s.pauseReason === "background"
        ? restart(s)
        : s;
  }
}

/**
 * iOS 第一次拉流会弹「本地网络」授权，拒过之后拉流永远失败、点重新连接也没用，只能去设置里开
 * （DEVELOPMENT.md 平台限制清单 2026-09-30）：拉流失败时多一句提示和去设置的按钮
 */
export const suggestsLocalNetwork = (s: PreviewState, os: string): boolean =>
  os === "ios" && s.phase === "error" && s.errorKey === "video.err.stream";

/** 截图写到缓存目录的纯文件系统路径（播放器原生侧用 new File(path) / saveVideoSnapshotAt，不认 file://） */
export const toFsPath = (uri: string): string =>
  uri.startsWith("file://") ? decodeURI(uri.slice("file://".length)) : uri;
