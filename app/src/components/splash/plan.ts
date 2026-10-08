// 开屏播到商标完成时落到哪种页面（纯函数，单测覆盖）。
import type { SplashLanding } from "./timeline";

export type LandingFacts = {
  /** 登录态从钥匙串读出来了没有 */
  hydrated: boolean;
  /** 外观设置读出来了没有（没读出来之前默认是深色，不能拿来判断） */
  themeReady: boolean;
  /** 现在是深色外观 */
  dark: boolean;
  /** 系统开了「减弱动态效果」 */
  reduceMotion: boolean;
  authed: boolean;
  /** 设备列表：回来了就是台数，没回来是 null */
  deviceCount: number | null;
  /** 本机记住的上次结果：true / false = 上次有 / 没有头盔；null = 没有这位用户的记录；undefined = 记录还没读出来 */
  remembered: boolean | null | undefined;
  /** 商标完成后已经等满了时限 */
  waited: boolean;
};

/**
 * 返回 null 表示还定不下来（商标先停着）。
 * 负责人 2026-10-08 定的口径：设备列表没回来时按本机记住的上次结果播；没有记录就停在商标上
 * 最多 1 秒，然后直接进页面（"plain"：商标和品牌名淡出，不做落位）。
 * 三种落位都是按深色（品牌默认外观）的页面设计的：用户选了浅色时不做落位，同样走 "plain"。
 * 系统开了「减弱动态效果」时也走 "plain"：不播路线，也不做落位那些飞来飞去的动作。
 */
export function planLanding(f: LandingFacts): SplashLanding | null {
  if (!f.hydrated || !f.themeReady) return f.waited ? "plain" : null;
  if (!f.dark || f.reduceMotion) return "plain";
  if (!f.authed) return "login";
  if (f.deviceCount !== null) return f.deviceCount > 0 ? "device" : "unbound";
  if (f.remembered === true) return "device";
  if (f.remembered === false) return "unbound";
  return f.waited ? "plain" : null;
}
