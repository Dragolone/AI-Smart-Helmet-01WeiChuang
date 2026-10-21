// 外部链接拉进 App 时先过这里（expo-router 的 +native-intent）。
// 求救倒计时页在屏上时不跳走（10-21 夜测）：倒计时页拦着返回键不让退，但在别的 App 里点开本 App 的一个链接
// （设备页 / 地图 / 通讯录……）会把它从页面栈里挤掉——服务端这单照常倒数，页面却没了；「已拉起过」的登记又让 App
// 不再弹它，设备页也没有提示，要等下次重开 App 才回来。倒计时期间外来的链接一律不跳（求救页自己的链接照常），
// 倒计时结束（到了结果页）就放行。推送 / 本地通知的点击不走这里（各自已先去倒计时页，services/push、sos-alert）
import { sosScreen } from "@/services/sos-queue";

export function redirectSystemPath({
  path,
}: {
  path: string;
  initial: boolean;
}): string | null {
  try {
    if (sosScreen.counting && !/(^|\/)sos-active(\?|$)/.test(path)) return null;
  } catch {
    // 这里抛错会把 App 带崩（expo-router 的说明）：判断不了就照常跳
  }
  return path;
}
