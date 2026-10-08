// 开屏的时间表（纯函数：遮罩、落位的页面和单测共用）。
// 整段动画按「故事时间」写；镜头离开路面到商标完成这一段放慢 1.6 倍播，真实时间经一条平滑的曲线
// 换算成故事时间，两头不会突然变速。商标完成（1600）之后两种时间一比一地走。
import { smooth } from "./route-scene";

export type SplashLanding = "login" | "device" | "unbound" | "plain";

/** 商标完成的故事时间 */
export const MARK_DONE = 1600;
const SLOW = [380, 600, 1420, 1600] as const;
export const PACE = 1.6;

/** 各种收尾在故事时间上到哪一刻结束 */
export const STORY_TOTAL: Record<SplashLanding, number> = {
  login: 3850,
  device: 3400,
  unbound: 3760,
  // 没有可落的页面（设备列表没回来、也没有上次的记录）：商标和品牌名停一下就淡出
  plain: 2300,
};

/** 品牌名在商标下面出现：从这一刻起、用这么久 */
export const LOCKUP = { start: 1580, dur: 260 } as const;

/** realOf[s] = 故事时间 s（0..1600 的整数毫秒）对应的真实毫秒数 */
export function buildWarp(): number[] {
  const out = [0];
  let t = 0;
  for (let s = 1; s <= MARK_DONE; s++) {
    const slow =
      smooth((s - SLOW[0]) / (SLOW[1] - SLOW[0])) *
      (1 - smooth((s - SLOW[2]) / (SLOW[3] - SLOW[2])));
    t += 1 + (PACE - 1) * slow;
    out.push(t);
  }
  return out;
}

/** 真实时间 → 故事时间 */
export function storyAt(warp: number[], real: number): number {
  "worklet";
  const end = warp[MARK_DONE];
  if (real >= end) return MARK_DONE + (real - end);
  if (real <= 0) return 0;
  let a = 0;
  let b = MARK_DONE;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (warp[m] <= real) a = m;
    else b = m;
  }
  return a + (real - warp[a]) / (warp[b] - warp[a] || 1);
}

/** 故事时间 → 真实时间 */
export function realAt(warp: number[], story: number): number {
  "worklet";
  if (story >= MARK_DONE) return warp[MARK_DONE] + (story - MARK_DONE);
  if (story <= 0) return 0;
  const i = Math.floor(story);
  return warp[i] + (warp[i + 1] - warp[i]) * (story - i);
}
