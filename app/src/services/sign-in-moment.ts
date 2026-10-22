// 这个进程里最近一次登录（登录页 / 注册页拿到 token）的时刻，以及「刚登录的几秒里先别弹系统授权框」这道门。
// 冷启动时本来就登录着的不算，一直是 0。
//
// 为什么要等（10-22 iPad 真机 + iPad 模拟器实测）：登录页一消失，iOS 会弹「保存密码？」卡片（SafariViewService
// 托管在 UITextEffectsWindow 里，点登录后约 1.4 s 出来）。它还在弹出的过程中，通知 / 蓝牙授权框就压上来的话：
// 卡片没显示出来，承载它的全屏视图却留在最上层，所有点按都被它接走，用户看不到卡片也点不了「以后」，
// 整个 App 卡死到杀掉重开。卡片单独出现时正常；卡片完整弹出之后授权框再来也正常（授权框叠在卡片上，
// 点完授权框卡片还在，点「以后」后照常操作）。会弹系统授权框的三处都过这道门：通知（sos-alert）、
// 极光初始化（push，iOS 上 init 当场申请通知授权）、起蓝牙链路（use-realtime，新建蓝牙管理器即弹框）。
// 安卓没有这张卡片，不等
import { Platform } from "react-native";

export const SIGN_IN_PROMPT_QUIET_MS = 4_000;

let signedInAt = 0;

export function markSignedIn(now: number = Date.now()): void {
  signedInAt = now;
}

/** iOS 刚登录还要等多少毫秒才能弹系统授权框；冷启动本来就登录着、安卓都是 0 */
export function signInQuietRemainingMs(now: number = Date.now()): number {
  if (Platform.OS !== "ios") return 0;
  return Math.max(0, SIGN_IN_PROMPT_QUIET_MS - (now - signedInAt));
}

export async function whenSignInQuiet(): Promise<void> {
  const wait = signInQuietRemainingMs();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
