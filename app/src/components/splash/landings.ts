// 开屏收尾的编排：商标完成之后，按落到哪种页面，每一刻各样东西在哪、多大、多亮。
// 全是按故事时间（毫秒）算的纯函数，在 UI 线程上逐帧调用；数值照设计原型（route-converge-splash 三份）。
import { clamp01, easeOut, lerp, smooth, smoother } from "./route-scene";
import { LOCKUP, MARK_DONE } from "./timeline";

/** 0 还没定；其余对应 SplashLanding */
export const LAND_NONE = 0;
export const LAND_LOGIN = 1;
export const LAND_DEVICE = 2;
export const LAND_UNBOUND = 3;
export const LAND_PLAIN = 4;

/** 带一点过冲的到位 */
export function spring(v: number): number {
  "worklet";
  const p = clamp01(v);
  return p === 1
    ? 1
    : 1 - Math.exp(-7 * p) * (Math.cos(11 * p) + (7 / 11) * Math.sin(11 * p));
}
/** 起步快、很长的减速滑到位，不过冲 */
export function glide(v: number): number {
  "worklet";
  const p = clamp01(v);
  const end = 1 - Math.exp(-7) * 8;
  return (1 - Math.exp(-7 * p) * (1 + 7 * p)) / end;
}

// ---------------------------------------------------------------- 去登录页
export const LOGIN = {
  /** 商标开始上移、缩小，落到登录页顶部 */
  dockFrom: 2300,
  dockLen: 820,
  /** 一次呼吸加两圈细环 */
  pulse: [1600, 2020] as const,
  /** 页面从下面涌上来 */
  revealFrom: 2430,
  revealLen: 780,
  /** 页面上的内容依次进场 */
  arriveFrom: 2660,
  /** 品牌名在商标下出现（之后中文那一行变成登录页的标题） */
  wordsFrom: 1660,
  wordsLen: 290,
};
export function loginDock(t: number): number {
  "worklet";
  return glide((t - LOGIN.dockFrom) / LOGIN.dockLen);
}
export function loginBreath(t: number): number {
  "worklet";
  return Math.sin(
    clamp01((t - LOGIN.pulse[0]) / (LOGIN.pulse[1] - LOGIN.pulse[0])) * Math.PI,
  );
}
export function loginReveal(t: number): number {
  "worklet";
  return glide((t - LOGIN.revealFrom) / LOGIN.revealLen);
}

// ---------------------------------------------------------------- 去设备页（已绑定头盔）
export const DEVICE = {
  /** 商标收一点，好让电量环绕着它画出来 */
  tuck: [1600, 1850] as const,
  tuckScale: 0.74,
  /** 一个光点从电量环的起点出现，沿环滑到电量处 */
  line: 1680,
  lineDur: 440,
  /** 从中心扫描：头盔显出来，商标从中心被擦掉 */
  scan: [2060, 2400] as const,
  /** 表盘带着头盔上移到页面里的位置，页面其余部分淡入 */
  hand: 2410,
  glide: 620,
  arriveFrom: 2480,
  /** 品牌名在扫描开始时收走 */
  wordsLeave: 2060,
  wordsLeaveLen: 240,
  /** 环的全长：240 画布上半径 104 的 270° */
  arc: 490.09,
  /** 环刚出现时的边长，占屏幕宽的多少（设计稿：390 宽的页面上 280） */
  ring0: 280 / 390,
  /** 收到 0.74 的商标在环自己的 240 画布上有多大 */
  markInDial: ((196 * 0.74) / 282 / (280 / 390)) * 240,
  /** 表盘到位、交还给页面：页面上真的那一份从这一刻起淡入，遮罩画的这一份随后淡出 */
  give: 2970,
  /** 光点离开电量停住的地方、去点亮连接状态：从这一刻出发 */
  spark: 2360,
};
export function deviceWipe(t: number): number {
  "worklet";
  return smoother((t - DEVICE.scan[0]) / (DEVICE.scan[1] - DEVICE.scan[0]));
}
export function deviceGlide(t: number): number {
  "worklet";
  return glide((t - DEVICE.hand) / DEVICE.glide);
}
/** 光点从电量处沿环走完剩下的一段、再落到连接状态那一粒上，一共要多久（onRing、drop 都按环的 240 画布算） */
export function sparkDuration(onRing: number, drop: number): number {
  "worklet";
  return Math.min(420, Math.max(220, 160 + 0.5 * (onRing + drop)));
}
/** 从静止起步，然后滑很长一段停下：光点滑到电量处 */
export function slide(v: number): number {
  "worklet";
  const p = clamp01(v);
  return lerp(p * p, 1 - Math.pow(1 - p, 2.4), p);
}

// ---------------------------------------------------------------- 去设备页（还没绑定头盔：引导卡）
export const UNBOUND = {
  /** 衔接从这一刻开始（商标先和品牌名一起停一下） */
  start: 2000,
  len: 1760,
  wordsLeaveLen: 200,
  /** 以下都从 start 算起。商标落到卡片左上角、换成页面上那枚徽标 */
  swap: 760,
  /** 页面标题和右上角的按钮进场 */
  header: 720,
};

// ---------------------------------------------------------------- 三种收尾共用
/** 品牌名的显隐：0..1，以及这一刻它往上挪了多少（屏幕单位） */
export function lockupAt(land: number, t: number): number {
  "worklet";
  if (land === LAND_LOGIN)
    return easeOut((t - LOGIN.wordsFrom) / LOGIN.wordsLen);
  const coming = easeOut((t - LOCKUP.start) / LOCKUP.dur);
  if (land === LAND_DEVICE)
    return (
      coming * (1 - smooth((t - DEVICE.wordsLeave) / DEVICE.wordsLeaveLen))
    );
  if (land === LAND_UNBOUND)
    return coming * (1 - smooth((t - UNBOUND.start) / UNBOUND.wordsLeaveLen));
  if (land === LAND_PLAIN) return coming;
  return coming;
}

/** 商标离开原位的程度：画布上它周围的光随之收掉 */
export function glowDockAt(land: number, t: number): number {
  "worklet";
  if (t < MARK_DONE) return 0;
  if (land === LAND_LOGIN) return loginDock(t);
  if (land === LAND_DEVICE) return smooth(deviceWipe(t) / 0.6);
  if (land === LAND_UNBOUND) return smooth((t - UNBOUND.start + 130) / 200);
  return 0;
}
