// 「等系统的弹框都走完」再做一件事：App 连续处在前台满一小段时间才算走完。
// 系统的权限框（通知、蓝牙）盖在上面时 App 不算在前台（Android 是 background，iOS 是 inactive）。
// 第一次登录这些框一个接一个出：通知 → 拒绝的话紧接着再问一次（ble-link 为前台服务的常驻通知另问的那次）
// → 蓝牙，中间只隔几十毫秒。这个空当里弹 App 自己的说明框，Android 上会丢——
// 2026-10-08 模拟器实测：两个系统框之间调 Alert.alert，三个框都点完后屏幕上没有这张说明框。
import { AppState } from "react-native";

export const FOREGROUND_SETTLE_MS = 1000;

/**
 * App 连续在前台满 settleMs 后调用一次 run；中途离开前台（又来了一个系统框、用户切走）就等回来重新计。
 * 返回取消函数：取消之后不会再调 run。
 */
export function whenForegroundSettled(
  run: () => void,
  settleMs: number = FOREGROUND_SETTLE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const arm = () => {
    clearTimeout(timer);
    timer = undefined;
    if (finished || AppState.currentState !== "active") return;
    timer = setTimeout(() => {
      // 离开前台的事件可能还排在后面没处理：以此刻的状态为准，不在前台就等下一次回来
      if (finished || AppState.currentState !== "active") return;
      finished = true;
      sub.remove();
      run();
    }, settleMs);
  };
  const sub = AppState.addEventListener("change", arm);
  arm();
  return () => {
    finished = true;
    clearTimeout(timer);
    sub.remove();
  };
}
