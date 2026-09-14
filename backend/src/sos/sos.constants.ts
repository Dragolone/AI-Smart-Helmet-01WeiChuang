/**
 * SOS 状态机配置（.env.example 有键）：调用时读取而非 import 时读取，
 * 让测试能在 app 初始化前用环境变量把倒计时/扫描间隔调短，全路径不用等真 60 秒。
 */

const readPositiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** 倒计时秒数（产品口径 60s；CLAUDE.md SOS 状态机） */
export const countdownMs = (): number =>
  readPositiveInt(process.env.SOS_COUNTDOWN_SECONDS, 60) * 1000;

/** 后台扫描间隔（决策 #8：持久化 deadline + 周期扫描，禁止仅靠内存 timer） */
export const scanIntervalMs = (): number =>
  readPositiveInt(process.env.SOS_SCAN_INTERVAL_MS, 5000);

/** 单条通知最大投递次数（含首次）；到上限终态 failed 留档 */
export const maxNotifyAttempts = (): number =>
  readPositiveInt(process.env.SOS_NOTIFY_MAX_ATTEMPTS, 3);

/** 单次 Provider 调用超时（毫秒）：一条挂起的短信/推送不能占住整个扫描任务（审计 SOS-05） */
export const notifyTimeoutMs = (): number =>
  readPositiveInt(process.env.SOS_NOTIFY_TIMEOUT_MS, 10_000);

/** 启动对账回看窗口（分钟）：raw 已落库但没建单的摔倒/求救事件在此窗口内补建（审计 SOS-02） */
export const reconcileWindowMs = (): number =>
  readPositiveInt(process.env.SOS_RECONCILE_WINDOW_MINUTES, 15) * 60_000;

/** 对账宽限（毫秒）：刚落库、分发仍在进行中的事件不参与对账，避免与在途分发重复触发 */
export const reconcileGraceMs = (): number =>
  readPositiveInt(process.env.SOS_RECONCILE_GRACE_MS, 3000);

export const SOS_STATUS = {
  pending: 'pending',
  notified: 'notified',
  cancelled: 'cancelled',
} as const;

export const NOTIFICATION_STATUS = {
  pending: 'pending',
  sent: 'sent',
  failed: 'failed',
} as const;
