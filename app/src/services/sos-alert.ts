// SOS 锁屏提醒：App 不在前台时收到 pending 的 SOS 推送，用本地通知把「摔倒/求救倒计时」顶到锁屏上。
// 背景：iOS 锁屏下 SOS 页的 expo-audio 警报音激活会失败（AVAudioSession 不允许后台起播，2026-09-17
// 真机实测：事件当秒上云、页面已推、但用户听不到任何声音）；本地通知的声音与横幅不依赖音频会话，
// 是锁屏告警唯一可靠的路径。Android 上同样走这里（前台服务的常驻通知是静音的）。
// 服务端仍是 SOS 权威，这里只做提醒，不做任何判断。
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import { translate } from "@/i18n";
import { devLog } from "@/services/dev-log";

const CHANNEL_ID = "sos";
let permissionAsked = false;
let shownForSosId: string | null = null;
let notificationId: string | null = null;

/** 登录后调用一次：申请通知权限并建 Android 高优先级通道（拒绝也不阻塞链路） */
export async function ensureSosAlertPermission(): Promise<void> {
  if (permissionAsked) return;
  permissionAsked = true;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: translate("sosAlert.channel"),
        importance: Notifications.AndroidImportance.MAX,
        sound: "default",
        vibrationPattern: [0, 500, 250, 500],
        lockscreenVisibility:
          Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) await Notifications.requestPermissionsAsync();
  } catch (e) {
    devLog("SOS-ALERT", "通知权限/通道初始化失败", e as Error);
  }
}

/** pending SOS 到达且 App 不在前台 → 立即弹本地通知（同一单只弹一次） */
export async function showSosAlertIfBackground(
  sosId: string,
  deviceId: string,
): Promise<void> {
  if (AppState.currentState === "active") return;
  if (shownForSosId === sosId) return;
  shownForSosId = sosId;
  try {
    notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: translate("sosAlert.title"),
        body: translate("sosAlert.body"),
        // Android 上 "default" 会被当成自定义音频文件名报错；true = 通道默认铃声
        sound: Platform.OS === "ios" ? "default" : true,
        interruptionLevel: "timeSensitive",
        priority: Notifications.AndroidNotificationPriority.MAX,
        data: { sosId, deviceId },
        ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
      },
      trigger: null,
    });
    devLog("SOS-ALERT", "锁屏通知已弹", sosId);
  } catch (e) {
    devLog("SOS-ALERT", "本地通知失败", e as Error);
  }
}

/** SOS 不再 pending（取消/确认/已通知）→ 撤掉通知 */
export async function clearSosAlert(sosId: string): Promise<void> {
  if (shownForSosId !== sosId) return;
  shownForSosId = null;
  try {
    if (notificationId)
      await Notifications.dismissNotificationAsync(notificationId);
  } catch {
    // 通知可能已被用户划掉
  }
  notificationId = null;
}
