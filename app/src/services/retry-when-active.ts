// 钥匙串读不出来时「回到前台再读一次」（同 consent-store 的做法，语言 / 外观 / 当前头盔共用）。
// BLE 状态恢复能在锁屏下把被回收的进程拉起来，这时只在解锁后可读的条目（钥匙串默认的 WHEN_UNLOCKED）读不出：
// 先按默认值把这次进程跑起来，用户解锁打开 App 的那一刻再读，不让默认值在整个进程里定死。
import { AppState } from "react-native";

const waiting = new Map<string, { remove: () => void }>();

/** App 回到前台时调一次 retry；同一个 key 同时只挂一个监听（连着失败几次也只重读一次） */
export function retryWhenActive(key: string, retry: () => void): void {
  if (waiting.has(key)) return;
  const sub = AppState.addEventListener("change", (state) => {
    if (state !== "active") return;
    waiting.get(key)?.remove();
    waiting.delete(key);
    retry();
  });
  waiting.set(key, sub);
}
