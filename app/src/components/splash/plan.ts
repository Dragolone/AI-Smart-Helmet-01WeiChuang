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

/**
 * 窗口宽高比（宽 ÷ 高）超过它就不播开屏。开屏整套按屏幕宽度排（商标边长 = 屏宽 × 196/282），
 * 窗口越接近方形，底下的「零一智行」越往屏幕底边挤：10-21 安卓 16 模拟器逐个比例量过，0.83（竖着拿的展开折叠屏）、
 * 0.92、1.0 都完整（1.0 时品牌名离底边只剩约一成），1.08 压到手势条，1.17 / 1.2（横着拿）被切掉一半。
 * 取 0.95：正方形也不播，给三键导航栏（比手势条高）留余量
 */
export const SPLASH_MAX_ASPECT = 0.95;

/**
 * 这个窗口放不下开屏：展开的折叠屏 / 平板横着拿（安卓 16 起大屏上系统无视竖屏锁）、分屏里又宽又矮的窗口。
 * 负责人 10-21 定（O32 选 A）：这时不播，直接进页面；按短边自适应的开屏记在 plan/OPTIMIZATIONS.md。
 * 高度还没量出来（0）时不拦，照常播
 */
export function tooWideForSplash(width: number, height: number): boolean {
  return height > 0 && width / height > SPLASH_MAX_ASPECT;
}
