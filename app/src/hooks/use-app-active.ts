// App 此刻是不是在前台、能被人看见（退到后台、iOS 上拉下通知中心 / 进了多任务界面都不算）。
import { useEffect, useState } from "react";
import { AppState } from "react-native";

export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) =>
      setActive(st === "active"),
    );
    return () => sub.remove();
  }, []);
  return active;
}
