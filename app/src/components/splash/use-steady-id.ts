// 给会出现多份的组件用：每一份一个不重复的 id（配合 steady-style.ts 的 steady()），卸掉时把记着的那份样式也清掉。
import { useEffect, useId } from "react";
import { scheduleOnUI } from "react-native-worklets";

import { forgetSteady } from "./steady-style";

export function useSteadyId(): string {
  const id = useId();
  useEffect(
    () => () => {
      // 两边都记过：头一次求值在 JS 线程上，之后在 UI 线程上
      forgetSteady(id);
      scheduleOnUI(forgetSteady, id);
    },
    [id],
  );
  return id;
}
