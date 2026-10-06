// 这次进程是不是由「通知上的按钮」拉起的（不是点横幅）。启动动画据此缩短：
// 用户刚在锁屏上按了「我没事，取消」，不该再看两三秒的流光才知道结果（2026-10-07 iPhone 实测）。
import * as Notifications from "expo-notifications";

export function launchedByNotificationAction(): boolean {
  try {
    const r = Notifications.getLastNotificationResponse();
    return (
      !!r &&
      typeof r.actionIdentifier === "string" &&
      r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER
    );
  } catch {
    return false;
  }
}
