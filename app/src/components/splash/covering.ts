// 开屏这一层还盖在 App 上（从挂上到卸掉）。App 自己弹的东西要等它让开再出：系统提示框和 Modal 是单独的窗口，
// 会直接压在开屏上；Toast 在安卓上带 elevation，层级也比开屏高。2026-10-21 华为正式包：通知被关着时冷启动，
// 「通知权限已关闭」的说明框弹在还在播的路线动画上。
// 没有开屏（单测里、由通知拉起时它一挂上就收）就一律是「没盖着」。只在 JS 线程上用。
import { useSyncExternalStore } from "react";

let covering = false;
const listeners = new Set<() => void>();

export function subscribeSplashCovering(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 开屏这一层挂上 / 卸掉时调 */
export function setSplashCovering(on: boolean): void {
  if (covering === on) return;
  covering = on;
  for (const l of [...listeners]) l();
}

export function isSplashCovering(): boolean {
  return covering;
}

/** 开屏让开之后做一次 run（现在就没盖着则立刻做）。返回取消函数：取消之后不会再调 run */
export function whenSplashGone(run: () => void): () => void {
  if (!covering) {
    run();
    return () => undefined;
  }
  const unsubscribe = subscribeSplashCovering(() => {
    if (covering) return;
    unsubscribe();
    run();
  });
  return unsubscribe;
}

/**
 * 系统授权框（通知 / 蓝牙）最多为开屏等这么久（O27，负责人 10-21 定）：框和开屏抢不过——它是单独的窗口，
 * 弹在还在播的路线动画上；但蓝牙链路排在授权结果后面，等太久头盔就晚连上
 */
export const PROMPT_AFTER_SPLASH_MAX_MS = 5_000;

/** 开屏让开就兑现，最多等 maxMs（到点不再等）；现在就没盖着则立刻兑现 */
export function splashGoneWithin(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cancel?.();
      resolve();
    };
    cancel = whenSplashGone(finish);
    if (!done) timer = setTimeout(finish, maxMs);
  });
}

/** 组件用：true = 开屏还盖着，自己的 Modal 先别挂 */
export function useSplashCovering(): boolean {
  return useSyncExternalStore(subscribeSplashCovering, isSplashCovering);
}
