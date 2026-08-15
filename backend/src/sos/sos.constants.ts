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
