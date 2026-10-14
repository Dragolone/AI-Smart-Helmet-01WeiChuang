// 开屏遮罩和它底下的页面之间传话用的几个共享值。
// 遮罩播到收尾时，页面上有些东西要配合：某个元素在遮罩把自己的那一份送到位之前先不显示
// （SplashAnchor），某几块内容跟着同一个时钟依次进场（SplashArrive）。没有开屏在播时这些值都是
// 「不参与」，页面照常显示。
import { useEffect, useSyncExternalStore } from "react";
import { makeMutable, type SharedValue } from "react-native-reanimated";

/** 页面上遮罩要落上去的位置 */
export type AnchorName =
  | "loginMark"
  | "loginTitle"
  | "hero"
  | "heroPill"
  | "guideCard"
  | "guideEmblem";

export type AnchorRect = { x: number; y: number; w: number; h: number };

/** 故事时间（毫秒）；-1 = 没有开屏在播 */
export const splashStory: SharedValue<number> = makeMutable(-1);

/**
 * 1 = 开屏正在播。遮罩里那些「跟着故事时间去改页面上的值」的反应都先看它：
 * 收场时这里先置 0，之后哪怕它们还没卸掉、又被触发了一次，也不会把刚放回去的值改回来
 * （2026-10-08 出过：收场后设备页的大图又被藏了起来）。
 */
export const splashOn: SharedValue<number> = makeMutable(0);

/** 页面内容进场的起点（故事时间）；-1 = 不做进场动画，直接显示 */
export const arriveFrom: SharedValue<number> = makeMutable(-1);

/** 页面标题栏进场的起点；-1 = 同上。单独一个：引导页变成设备页时内容要进场，标题栏是一直在的 */
export const headerFrom: SharedValue<number> = makeMutable(-1);

/** 设备页连接状态那一粒（和它上面的名字）出现的时刻：光点落到它上面的那一刻，由遮罩按电量算出来；-1 = 同上 */
export const pillFrom: SharedValue<number> = makeMutable(-1);

/** 没绑定头盔的引导页：卡片从商标的位置立起来的起点；-1 = 同上 */
export const guideFrom: SharedValue<number> = makeMutable(-1);

const names: AnchorName[] = [
  "loginMark",
  "loginTitle",
  "hero",
  "heroPill",
  "guideCard",
  "guideEmblem",
];
const rects = {} as Record<AnchorName, SharedValue<AnchorRect | null>>;
const owned = {} as Record<AnchorName, SharedValue<number>>;
for (const n of names) {
  rects[n] = makeMutable<AnchorRect | null>(null);
  owned[n] = makeMutable(0);
}

/** 各个位置在窗口里的矩形（页面量好之后填进来） */
export const anchorRect = rects;
/** 1 = 这个元素现在由遮罩画着，页面上的那一份先藏起来；交还时从 1 渐变到 0 */
export const anchorOwned = owned;

/** 页面想让遮罩知道的东西（比如设备页大图现在是什么颜色、多少电量）。只在 JS 线程上读写。 */
const anchorData = new Map<AnchorName, unknown>();
const listeners = new Set<() => void>();
export function setAnchorData(name: AnchorName, data: unknown): void {
  anchorData.set(name, data);
  for (const l of listeners) l();
}
export function getAnchorData<T>(name: AnchorName): T | undefined {
  return anchorData.get(name) as T | undefined;
}
export function subscribeAnchorData(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 要落上去的页面已经搭好、排过版了。遮罩等到这个才开播：页面第一次搭建要占主线程几十毫秒，
 * 和动画开头撞在一起会卡一下（2026-10-08 实测），放在开播之前就看不出来。只在 JS 线程上用。
 */
let pageReady = false;
const pageWaiters = new Set<() => void>();
export function markPageReady(): void {
  if (pageReady) return;
  pageReady = true;
  for (const done of pageWaiters) done();
  pageWaiters.clear();
}
export function whenPageReady(): Promise<void> {
  if (pageReady) return Promise.resolve();
  return new Promise((done) => pageWaiters.add(done));
}

/**
 * 冷启动、开屏的路线段还在播的时候，页面上重的内容（设备页的大图和列表、引导卡）先别搭，画着骨架等一等：
 * 搭这些要占主线程几十到上百毫秒，撞上路线动画就是一下明显的卡顿（2026-10-08 实测）。商标成形那一刻
 * 画面是静止的，遮罩在那时放行，页面再搭，卡的那一下只是商标多停了几帧。
 * 进程刚起来时默认是「等」；遮罩不播（通知拉起）、播完、或者出了岔子，都会放行。
 */
let holding = true;
const holdListeners = new Set<() => void>();
export function releaseSplashHold(): void {
  if (!holding) return;
  holding = false;
  for (const l of holdListeners) l();
}
function subscribeHold(listener: () => void): () => void {
  holdListeners.add(listener);
  return () => holdListeners.delete(listener);
}
/** 页面用：true = 现在先画骨架，别搭重的内容 */
export function useSplashHold(): boolean {
  const hold = useSyncExternalStore(subscribeHold, () => holding);
  // 保险：遮罩那边万一没放行，页面自己到时限也要把内容搭出来
  useEffect(() => {
    if (!hold) return;
    const id = setTimeout(releaseSplashHold, 6000);
    return () => clearTimeout(id);
  }, [hold]);
  return hold;
}

/**
 * 收场的第一步：页面上的东西全部放回「不参与」（该显示的显示出来、不再跟着故事时间动）。
 * 故事时间本身先不动：遮罩这时还在（要晚两帧才卸），把时间拨回去它会回到开头那一片底色的样子，
 * 整屏闪一下黑（2026-10-08 逐帧检查时见到）。时间由 endSplashStory 在遮罩卸掉之后归位。
 */
export function releaseSplashPage(): void {
  splashOn.set(0);
  arriveFrom.set(-1);
  headerFrom.set(-1);
  pillFrom.set(-1);
  guideFrom.set(-1);
  for (const n of names) owned[n].set(0);
}
/** 收场的第二步：遮罩已经卸掉，故事时间放回 -1 */
export function endSplashStory(): void {
  splashStory.set(-1);
}
