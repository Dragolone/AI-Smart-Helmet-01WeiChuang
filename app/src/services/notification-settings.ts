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
