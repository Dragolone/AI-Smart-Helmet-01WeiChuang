// 蓝牙相关的平台差异，给界面文案用（不引蓝牙原生库，页面 / 指引 / 状态推导都能直接用）。
import { Linking, Platform } from "react-native";

/**
 * 安卓 12（API 31）以下搜索蓝牙设备靠「位置信息」权限：系统设置里没有单独的蓝牙权限可开，提示用户去开权限时
 * 得说位置信息，不然他在设置里找不到（10-19 华为 P30 Pro 实测：拒绝定位后页面写「未授权蓝牙权限」）。
 * 鸿蒙 2/3 的安卓兼容层多在 API 31 以下，华为用户里占不少。与 services/ble-link 申请权限的分界一致。
 * Platform.Version 在安卓上是数字、iOS 上是字符串
 */
export function bleNeedsLocationPermission(): boolean {
  return (
    Platform.OS === "android" &&
    typeof Platform.Version === "number" &&
    Platform.Version < 31
  );
}

/** 系统定位设置页（安卓 11 及以下定位总开关关着时搜不到头盔）。发不出 intent 的机型退回应用信息页 */
export async function openLocationSettings(): Promise<void> {
  await Linking.sendIntent("android.settings.LOCATION_SOURCE_SETTINGS").catch(
    () => Linking.openSettings(),
  );
}
