import * as Notifications from "expo-notifications";

/**
 * 这次进程是不是由通知拉起的（点横幅或点通知上的按钮都算）。这个 App 的通知都和安全有关（求救、摔倒、
 * 危险提醒），由它拉起时不播开屏动画（负责人 2026-10-08：和求救有关的启动不播，先保证求救）。
 */
export function launchedByNotification(): boolean {
  try {
    return Notifications.getLastNotificationResponse() != null;
  } catch {
    return false;
  }
}
