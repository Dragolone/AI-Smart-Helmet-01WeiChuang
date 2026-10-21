// 求救结束时撤掉极光那条「SOS 倒计时已开始」（O12，负责人 10-21 定：只撤这一条，结果通知留着）。
// 安卓：极光自己贴的通知 expo 能列出来、却读不到是哪一单，只能用极光的编号撤——极光 RN 桥原本不把编号交给 JS，
// patches/jpush-react-native 补上了；到达时按单号记下编号，单子结束时撤。进程被杀时到的那条记不到，留着（已知限制）。
// iOS 那半在 sos-alert（远程推送在 expo 的已送达列表里，带类别 sos 的就是这一条）。

/** 服务器「倒计时已开始」推送的标题（backend sos-trigger.service），结果通知的标题不同 */
export const SOS_START_PUSH_TITLE = "SOS 倒计时已开始";

const arrived = new Map<string, number[]>();
let clearById: ((notificationId: number) => void) | null = null;
let onArrived: ((sosId: string) => void) | null = null;

/**
 * sos-alert 装上：极光那条到达时，这一单的本地提醒若已在通知栏上，当场撤掉它。原来只靠本地提醒弹出后 3 s / 10 s
 * 的补扫，App 在后台时安卓的 JS 定时器不跑，晚到的那条就一直挂着（华为 10-21 夜实测：晚 0.8 s 到、20 s 都没撤）。
 * 到达事件是原生推过来的，后台也会来
 */
export function setSosStartPushArrivalHook(
  hook: ((sosId: string) => void) | null,
): void {
  onArrived = hook;
}

/** push.ts 初始化极光后装上：按编号撤一条极光通知 */
export function setJPushNotificationClearer(
  fn: ((notificationId: number) => void) | null,
): void {
  clearById = fn;
}

/** 极光通知到达（安卓才带编号）：是这一单的「倒计时已开始」就记下编号 */
export function noteSosStartPush(
  sosId: string,
  title: unknown,
  notificationId: unknown,
): void {
  if (title !== SOS_START_PUSH_TITLE) return;
  if (typeof notificationId !== "number" || !Number.isInteger(notificationId))
    return;
  const ids = arrived.get(sosId) ?? [];
  if (!ids.includes(notificationId)) ids.push(notificationId);
  arrived.set(sosId, ids);
  try {
    onArrived?.(sosId);
  } catch {
    // 撤不掉也不影响记下的编号：单子结束时还会再撤
  }
}

/** 这一单结束：撤掉记下的那几条（首投失败重试时同一单可能到了不止一条） */
export function clearSosStartPush(sosId: string): void {
  const ids = arrived.get(sosId);
  arrived.delete(sosId);
  if (!ids || !clearById) return;
  for (const id of ids) {
    try {
      clearById(id);
    } catch {
      // 通知可能已被划掉；撤不掉也不影响别的
    }
  }
}

/** 仅测试用 */
export function __resetSosStartPushForTests(): void {
  arrived.clear();
  clearById = null;
  onArrived = null;
}
