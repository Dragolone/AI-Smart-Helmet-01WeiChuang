// 打开「本 App 的通知设置」：Android 直接进通知那一页（ACTION_APP_NOTIFICATION_SETTINGS），
// 不是应用信息页再让用户找「通知」（2026-10-15 模拟器：点「去系统设置开启通知」落在应用信息页，差一层）。
// iOS 没有分页，只能开 App 的设置页。发不出 intent（个别 ROM）就退回应用信息页。
import { Linking, Platform } from "react-native";

const ANDROID_PACKAGE = "com.lingyiweichuang.app";

export async function openNotificationSettings(): Promise<void> {
  if (Platform.OS === "android") {
    try {
      await Linking.sendIntent("android.settings.APP_NOTIFICATION_SETTINGS", [
        { key: "android.provider.extra.APP_PACKAGE", value: ANDROID_PACKAGE },
      ]);
      return;
    } catch {
      // 落到下面的通用设置页
    }
  }
  await Linking.openSettings();
}

/**
 * Android：打开本 App 某一条通知通道的设置页（「允许打扰」开关就在这一页）。
 * 打不开（个别 ROM 没有这一页）就退回本 App 的通知设置页，通道列表在那里；iOS 没有通道，同 openNotificationSettings。
 */
export async function openNotificationChannelSettings(
  channelId: string,
): Promise<void> {
  if (Platform.OS === "android") {
    try {
      await Linking.sendIntent(
        "android.settings.CHANNEL_NOTIFICATION_SETTINGS",
        [
          { key: "android.provider.extra.APP_PACKAGE", value: ANDROID_PACKAGE },
          { key: "android.provider.extra.CHANNEL_ID", value: channelId },
        ],
      );
      return;
    } catch {
      // 落到通知设置页
    }
  }
  await openNotificationSettings();
}
