// 页面挂着时屏幕常亮。和 expo-keep-awake 的 useKeepAwake 一样，只是两次原生调用的失败都接住：
// 那个 hook 卸载时调 deactivateKeepAwake 不接 Promise，Activity 已经不在（按 HOME、被系统回收）时
// 会冒出「Uncaught (in promise) … The current activity is no longer available」（2026-10-15 模拟器）。
// 常亮开关失败不影响页面本身，吞掉即可
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect } from "react";

export function useKeepAwakeSafe(tag: string): void {
  useEffect(() => {
    activateKeepAwakeAsync(tag).catch(() => {});
    return () => {
      deactivateKeepAwake(tag).catch(() => {});
    };
  }, [tag]);
}
