// 通知权限的四态读取，给安全首页 / 安全设置页显示用。
// services/sos-alert.ts 的 isSosAlertPermissionDenied 只回答「是否被拒」，区分不了「已开启」
// 「系统还没问过」「查询失败」——后两种在界面上都不能显示成已开启。
// 单独成文件而不是加进 sos-alert.ts：那个模块带通知监听等模块级状态，真机连着 Metro 时改它会
// 重复注册监听。两处对「被拒」的判定保持一致：没授权且不是「还没问过」。
import * as Notifications from "expo-notifications";

import type { NotifyPermission } from "@/services/safety-status";

export async function readNotifyPermission(): Promise<NotifyPermission> {
  try {
    const p = await Notifications.getPermissionsAsync();
    if (p.granted) return "granted";
    return (p as { status?: string }).status === "undetermined"
      ? "undetermined"
      : "denied";
  } catch {
    return "unknown";
  }
}
