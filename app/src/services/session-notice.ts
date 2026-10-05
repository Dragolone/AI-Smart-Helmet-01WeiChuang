// 会话被动结束时的提醒（2026-10-05 评审）。
// 背景：MVP 头盔不带 4G，摔倒事件靠手机 App 经 BLE 中转上云（决策 #35）。会话一旦被服务端否定
// （另一台手机改了密码 / 找回密码 / 注销账号 / refresh token 被判复用），App 回到登录页，
// BLE 中转、实时通道、推送别名随之全停——此后头盔摔倒，服务端不会建单，联系人收不到通知。
// 原来这一切是静默的：手机在口袋里，用户以为头盔仍受保护。这里在 App 不在前台时发一条本地通知；
// 在前台时登录页顶部有同样的说明（auth-store.sessionExpired）。
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { translate } from "@/i18n";
import { devLog } from "@/services/dev-log";

/** 与 SOS 提醒同一个 Android 通道（高优先级、可越过勿扰）；通道在登录后已建好 */
const CHANNEL_ID = "sos";
export const SESSION_EXPIRED_NOTIFICATION_ID = "session-expired";

export function notifySessionExpired(): void {
  if (AppState.currentState === "active") return;
  void Notifications.scheduleNotificationAsync({
    identifier: SESSION_EXPIRED_NOTIFICATION_ID,
    content: {
      title: translate("auth.sessionExpiredTitle"),
      body: translate("auth.sessionExpiredBody"),
      sound: Platform.OS === "ios" ? "default" : true,
      interruptionLevel: "timeSensitive",
      priority: Notifications.AndroidNotificationPriority.MAX,
    },
    // Android 的通道只从 trigger 读（同 sos-alert）
    trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
  }).catch((e: Error) => devLog("SESSION", "会话失效通知失败", e));
}

/** 重新登录后撤掉那条提醒 */
export function clearSessionExpiredNotice(): void {
  void Notifications.dismissNotificationAsync(
    SESSION_EXPIRED_NOTIFICATION_ID,
  ).catch(() => undefined);
}
