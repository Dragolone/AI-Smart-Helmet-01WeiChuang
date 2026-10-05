// 对讲发言指示：TRTC 每 300 ms 回调一次全员音量，而界面只关心「谁的音量过了发言阈值」。

/** 两份音量表在「谁在发言」这件事上是否相同——相同就不必换状态、不必重画 */
export function sameSpeakers(
  a: Record<string, number>,
  b: Record<string, number>,
  threshold: number,
): boolean {
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[id] ?? 0) >= threshold !== (b[id] ?? 0) >= threshold) return false;
  }
  return true;
}
