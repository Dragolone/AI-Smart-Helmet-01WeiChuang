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

/**
 * 启动那一次对账的回看窗口（小时，默认 48 = 头盔离线缓存上限，DEVICE_PROTOCOL §6）。
 * 周期对账只看 15 分钟：进程在「raw 落库」与「建单」之间倒下、二十分钟后才起来，15 分钟窗口看不到那条摔倒。
 */
export const reconcileStartupWindowMs = (): number =>
  envPositiveInt('SOS_RECONCILE_STARTUP_WINDOW_HOURS', 48) * 3_600_000;

/**
 * 建单时给本人的「SOS 倒计时已开始」推送：首投失败后再试几次的等待（秒，逗号分隔，默认 5,20）。
 * 这条推送上有「我没事，取消」按钮，是 App 被杀 / 没连头盔时唯一能取消误报的入口，不能只发一次。
 * 空串 = 不重试（测试用）。写错任何一项整体回落默认。
 */
export const createdPushRetryDelaysMs = (): number[] => {
  const raw = process.env.SOS_CREATED_PUSH_RETRY_DELAYS_SECONDS;
  if (raw === '') return [];
  const parts = (raw ?? '5,20').split(',').map((part) => part.trim());
  return (parts.every((part) => /^\d+$/.test(part)) ? parts : ['5', '20']).map(
    (s) => Number(s) * 1000,
  );
};

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

/**
 * 本人「SOS 倒计时已开始」推送的 iOS 通知类别，与 App 登录后向系统注册的类别同名
 * （app/src/services/sos-alert.ts 的 CATEGORY_ID，挂「我没事，取消」「查看」两个按钮）。
 * 只给倒计时推送用：到期 / 确认后的推送不带，免得已终态的单上还显示「取消」。
 */
export const SOS_PUSH_CATEGORY = 'sos';

/**
 * 本人「SOS 倒计时已开始」推送 extras 里的 `kind`（API.md §7「推送 extras」）：App 据此认出这一条，单子结束时撤掉它、
 * 结果通知留着（O12），不靠标题文字。到期 / 确认后的结果推送不带 kind
 */
export const SOS_STARTED_PUSH_KIND = 'sos_started';
