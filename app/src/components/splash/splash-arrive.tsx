// 开屏收尾时页面上依次进场的一块内容。没有开屏在播（对应的起点为 -1）时不做任何事，子元素照常显示。
//   rise（默认）从下面浮上来、略微放大到位，第几个（order）决定它晚多少出发；
//   soft        原地淡入、只挪一点点（设备名）；
//   pop         从小弹到原大（连接状态那一粒）。
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";

import { arriveFrom, headerFrom, pillFrom, splashStory } from "./bus";
import { steady } from "./steady-style";
import { useSteadyId } from "./use-steady-id";

const STEP = 60;
const DUR = { rise: 650, soft: 300, pop: 600 };

export function SplashArrive({
  order = 0,
  from = 30,
  cue = "page",
  lead = 0,
  kind = "rise",
  style,
  children,
}: {
  order?: number;
  /** 从下面多远的地方上来；负数是从上面下来 */
  from?: number;
  /** 跟着哪个起点：page = 页面内容进场；header = 标题栏进场；pill = 设备页连接状态出现的那一刻 */
  cue?: "page" | "header" | "pill";
  /** 比起点早（负）/ 晚多少毫秒 */
  lead?: number;
  kind?: "rise" | "soft" | "pop";
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  // 这块内容大多数时候是不动的（还没轮到它、或者已经到位）；不动时把同一个样式对象交回去，
  // 否则每帧都要往原生推一次更新（见 steady-style.ts）
  const id = useSteadyId();
  const st = useAnimatedStyle(() => {
    const start =
      cue === "pill"
        ? pillFrom.get()
        : cue === "header"
          ? headerFrom.get()
          : arriveFrom.get();
    if (start < 0)
      return steady(id, {
        opacity: 1,
        transform: [{ translateY: 0 }, { scale: 1 }],
      });
    const p = Math.min(
      1,
      Math.max(
        0,
        (splashStory.get() - start - lead - order * STEP) / DUR[kind],
      ),
    );
    // 带一点回弹的到位
    const settled =
      p === 1
        ? 1
        : 1 -
          Math.exp(-7 * p) * (Math.cos(11 * p) + (7 / 11) * Math.sin(11 * p));
    const eased = 1 - (1 - p) * (1 - p) * (1 - p);
    if (kind === "soft")
      return steady(id, {
        opacity: p * p * (3 - 2 * p),
        transform: [{ translateY: 6 * (1 - eased) }, { scale: 1 }],
      });
    if (kind === "pop") {
      const f = Math.min(1, p / 0.45);
      return steady(id, {
        opacity: 1 - (1 - f) * (1 - f) * (1 - f),
        transform: [{ translateY: 0 }, { scale: 0.86 + 0.14 * settled }],
      });
    }
    const fade = Math.min(1, p / 0.7);
    return steady(id, {
      opacity: 1 - (1 - fade) * (1 - fade) * (1 - fade),
      transform: [
        { translateY: from * (1 - settled) },
        { scale: 0.97 + 0.03 * settled },
      ],
    });
  });
  return <Animated.View style={[style, st]}>{children}</Animated.View>;
}
