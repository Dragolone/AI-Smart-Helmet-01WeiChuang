// 高德跳转链接工具(决策 #32:导航一律拉起高德 App,不做 App 内导航)。
// 坐标须为 GCJ-02(dev=0);未安装高德时回落网页版。
import { Linking, Platform } from "react-native";
import type { LngLat } from "./coords";

export async function openAmapNavigation(
  pos: LngLat,
  label: string,
): Promise<void> {
  const { longitude, latitude } = pos;
  const scheme =
    Platform.OS === "ios"
      ? `iosamap://navi?sourceApplication=helmet&lat=${latitude}&lon=${longitude}&dev=0`
      : `androidamap://navi?sourceApplication=helmet&lat=${latitude}&lon=${longitude}&dev=0`;
  const web = `https://uri.amap.com/navigation?to=${longitude},${latitude},${encodeURIComponent(label)}&mode=car`;
  if (Platform.OS === "ios") {
    // iOS：先问系统装没装高德（需要 Info.plist LSApplicationQueriesSchemes 含 iosamap）。
    // 装了就只拉起 scheme——用户在系统"打开高德地图?"里点取消时 openURL 会 reject，
    // 此时绝不能再回落到网页链接（网页是 universal link，会无提示直接跳进高德；负责人 2026-09-17 指正）
    const installed = await Linking.canOpenURL(scheme).catch(() => false);
    if (installed) {
      await Linking.openURL(scheme).catch(() => undefined);
      return;
    }
    await Linking.openURL(web);
    return;
  }
  try {
    await Linking.openURL(scheme);
  } catch {
    await Linking.openURL(web);
  }
}
