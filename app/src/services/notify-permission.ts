// 通知权限的四态读取，给安全首页 / 安全设置页显示用。
// services/sos-alert.ts 的 isSosAlertPermissionDenied 只回答「是否被拒」，区分不了「已开启」
// 「系统还没问过」「查询失败」——后两种在界面上都不能显示成已开启。
// 单独成文件而不是加进 sos-alert.ts：那个模块带通知监听等模块级状态，真机连着 Metro 时改它会
// 重复注册监听。两处对「被拒」的判定保持一致：没授权且不是「还没问过」。
import * as Notifications from "expo-notifications";

import type { NotifyPermission } from "@/services/safety-status";
import {
  isSosChannelBlocked,
  whenSosAlertPermissionAsked,
} from "@/services/sos-alert";

export async function readNotifyPermission(): Promise<NotifyPermission> {
  try {
    const p = await Notifications.getPermissionsAsync();
    // 总开关开着但求救通道被单独关了（Android）也算未开启：锁屏提醒一条都出不来（华为 10-19 实测）
    if (p.granted) return (await isSosChannelBlocked()) ? "denied" : "granted";
    return (p as { status?: string }).status === "undetermined"
      ? "undetermined"
      : "denied";
  } catch {
    return "unknown";
  }
}

/**
 * 界面上用这个：等登录后那一次系统通知授权框有了结果再读。
 * Android 13+ 上没授权之前查到的就是「被拒」，分不出「还没问过」——expo-notifications 在系统通知开关
 * 还关着时一律报 denied（NotificationPermissionsModule 的 API 33+ 一支）。全新安装第一次登录，系统框还
 * 开着的时候安全页就去读，会在系统框下面先弹好「通知未开启」，用户点了「允许」它也还在
 *（2026-10-08 Android 16 模拟器重装登录看到；华为 P30 是 Android 10，没有这个授权框，一直测不到）。
 * 求救倒计时页在屏时那次申请会推迟到页面关掉后（O10），这里等的是推迟后真正弹出的那次。
 * 申请本身出错不拦着读：那时读到什么就是什么。
 */
export async function readNotifyPermissionAfterAsk(): Promise<NotifyPermission> {
  await whenSosAlertPermissionAsked().catch(() => undefined);
  return readNotifyPermission();
}
