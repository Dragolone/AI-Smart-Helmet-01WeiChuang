import { envPositiveInt } from '../common/env';

/**
 * SOS 状态机配置（.env.example 有键）：调用时读取而非 import 时读取，
 * 让测试能在 app 初始化前用环境变量把倒计时/扫描间隔调短，全路径不用等真 60 秒。
 */

/** 倒计时秒数（产品口径 60s；CLAUDE.md SOS 状态机） */
export const countdownMs = (): number =>
  envPositiveInt('SOS_COUNTDOWN_SECONDS', 60) * 1000;

/** 后台扫描间隔（决策 #8：持久化 deadline + 周期扫描，禁止仅靠内存 timer） */
export const scanIntervalMs = (): number =>
  envPositiveInt('SOS_SCAN_INTERVAL_MS', 5000);

/** 单条通知最大投递次数（含首次）；到上限终态 failed 留档（决策 #50：5 次） */
export const maxNotifyAttempts = (): number =>
  envPositiveInt('SOS_NOTIFY_MAX_ATTEMPTS', 5);

/** 决策 #50：10 秒 / 1 分钟 / 5 分钟 / 15 分钟——连首次共 5 次，前后约 21 分钟 */
const DEFAULT_RETRY_DELAYS_SECONDS = [10, 60, 300, 900];

/**
 * 相邻两次投递之间的等待（毫秒）：第 n 次失败后等第 n 项，项数不够沿用最后一项。
 * 原先每轮扫描（5 秒）就重试，3 次在 10 秒内用完——短信通道抖一下，这条求救短信就永久失败了。
 * `SOS_NOTIFY_RETRY_DELAYS_SECONDS` 为逗号分隔的非负整数秒（测试用 0 跑即时重试）；写错任何一项整体回落默认。
 */
export const notifyRetryDelaysMs = (): number[] => {
  // 逐项按纯数字校验：Number('') 是 0，空串或多打一个逗号不能被读成「立即重试」
  const parts = (process.env.SOS_NOTIFY_RETRY_DELAYS_SECONDS ?? '')
    .split(',')
    .map((part) => part.trim());
  const seconds = parts.every((part) => /^\d+$/.test(part))
    ? parts.map(Number)
    : DEFAULT_RETRY_DELAYS_SECONDS;
  return seconds.map((s) => s * 1000);
};

/**
 * 已投递 attempts 次的通知，最早在创建后多久可以投下一次（毫秒）。
 * 按「创建时间 + 累计等待」算而不是「上次投递 + 等待」：通知行上没有上次投递时间，不为此加列。
 * 代价是后端停机越过几档等待后重启，剩余次数会按扫描间隔连续用掉——那时距事发已久，尽快发出才是对的。
 */
export const notifyDueAfterMs = (attempts: number): number => {
  const delays = notifyRetryDelaysMs();
  let total = 0;
  for (let n = 0; n < attempts; n += 1) {
    total += delays[Math.min(n, delays.length - 1)];
  }
  return total;
};

/** 单次 Provider 调用超时（毫秒）：一条挂起的短信/推送不能占住整个扫描任务（审计 SOS-05） */
export const notifyTimeoutMs = (): number =>
  envPositiveInt('SOS_NOTIFY_TIMEOUT_MS', 10_000);

/** 对账间隔（决策 #51：启动时跑一次，之后每 60 秒）：分发阶段丢掉的建单不必等到下次重启才补 */
export const reconcileIntervalMs = (): number =>
  envPositiveInt('SOS_RECONCILE_INTERVAL_SECONDS', 60) * 1000;

/** 对账回看窗口（分钟）：raw 已落库但没建单的摔倒/求救事件在此窗口内补建（审计 SOS-02） */
export const reconcileWindowMs = (): number =>
  envPositiveInt('SOS_RECONCILE_WINDOW_MINUTES', 15) * 60_000;

/** 对账宽限（毫秒）：刚落库、分发仍在进行中的事件不参与对账，避免与在途分发重复触发 */
export const reconcileGraceMs = (): number =>
  envPositiveInt('SOS_RECONCILE_GRACE_MS', 3000);

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
