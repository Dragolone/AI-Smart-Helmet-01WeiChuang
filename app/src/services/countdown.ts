// 倒计时页「什么时候再读一次时钟」的算法（纯函数）。
// 剩余秒数是 ⌈(截止时刻 − 现在) / 1000⌉，它在「离截止时刻正好还有整数秒」的那一刻换数字。
// 对着这些时刻去读，数字就一秒换一次、一个不落；固定每秒读一次的话，定时器每次晚几毫秒，
// 两次读数会偶尔跨过两个整秒，数字从 11 直接跳到 9（2026-10-08 模拟器录屏见到）。

/** 离下一次换数字还有多少毫秒（1–1000）。截止时刻已经过了也照样返回到下一个整秒的时间 */
export function msToNextSecond(deadlineMs: number, nowMs: number): number {
  const rem = (((deadlineMs - nowMs) % 1000) + 1000) % 1000;
  return rem === 0 ? 1000 : rem;
}

/** 服务端的求救倒计时是 60 秒（决策 #8） */
export const SOS_COUNTDOWN_S = 60;

/**
 * 页面 / 锁屏通知上显示的剩余秒数，封顶 60。服务端的 Date 头只到秒，学到的时钟偏移会偏小 0–1 秒
 * （server-clock 取的是「最近几次里最大的」，只会偏早不会偏晚），刚拉起时按它算会显示 61
 * （10-16 iPhone 实测）。截止时刻以服务端为准，这里只管显示
 */
export function shownSeconds(rawSeconds: number): number {
  return Math.min(SOS_COUNTDOWN_S, Math.max(0, rawSeconds));
}
