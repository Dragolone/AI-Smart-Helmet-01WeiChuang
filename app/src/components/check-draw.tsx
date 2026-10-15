// 画出来的勾：先一圈（半透明），再把勾钩上，勾落下时整体轻弹一下。
// 用在主按钮的成功态（components/form）和设置回执的「已生效」（components/device-settings）。
// 路径和引导页卡片上的勾（device-guide 的 Tick）是同一套；那边跟着卡片的时钟走，这里自己起时钟，节奏更快。
// 系统开了「减弱动态效果」时不画，直接是画好的样子。
import { Ionicons } from "@expo/vector-icons";
import {
  Canvas,
  Group,
  Path,
  Skia,
} from "@shopify/react-native-skia";
import { useEffect, useMemo } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { clamp01, easeOut, smooth } from "@/components/splash/route-scene";
import { steady } from "@/components/splash/steady-style";
import { useSteadyId } from "@/components/splash/use-steady-id";

/** 毫秒，从开始画那一刻算起：[从什么时候, 多久] */
const RING = [40, 320] as const;
const STROKE = [330, 260] as const;
const POP = [560, 280] as const;
/** 画完（含弹一下）要多久；外面要在勾画完之后再做事的，等这么久 */
export const CHECK_DRAW_MS = 860;

/** 先起后落：p 走到 peak 时最大 */
function bump(v: number, peak: number): number {
  "worklet";
  const p = clamp01(v);
  return p < peak ? smooth(p / peak) : 1 - smooth((p - peak) / (1 - peak));
}

export function CheckDraw({
  size = 24,
  color,
  strokeWidth = 2.2,
  ringOpacity = 0.5,
  play = true,
  style,
}: {
  size?: number;
  color: string;
  /** 以 24 为画布的线宽（随 size 等比缩放） */
  strokeWidth?: number;
  ringOpacity?: number;
  /** 变成 true 的那一刻开始画；false 时是空的 */
  play?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const at = useSharedValue(0);
  useEffect(() => {
    if (!play) {
      at.set(0);
      return;
    }
    if (reduced) {
      at.set(CHECK_DRAW_MS);
      return;
    }
    at.set(0);
    at.set(
      withTiming(CHECK_DRAW_MS, {
        duration: CHECK_DRAW_MS,
        easing: Easing.linear,
      }),
    );
  }, [play, reduced, at]);

  const paths = useMemo(
    () => ({
      ring: Skia.Path.MakeFromSVGString("M12 2.5A9.5 9.5 0 1 1 11.99 2.5"),
      stroke: Skia.Path.MakeFromSVGString("M7.6 12.5l3 3 5.9-6.2"),
    }),
    [],
  );
  const ringEnd = useDerivedValue(() =>
    smooth(clamp01((at.get() - RING[0]) / RING[1])),
  );
  const strokeEnd = useDerivedValue(() =>
    easeOut(clamp01((at.get() - STROKE[0]) / STROKE[1])),
  );
  // 跟着每帧都在变的时钟走、又带 transform 的样式：没变时交回同一个对象（splash/steady-style.ts 的约定）
  const id = useSteadyId();
  const pop = useAnimatedStyle(() =>
    steady(id, {
      transform: [
        { scale: 1 + 0.16 * bump((at.get() - POP[0]) / POP[1], 0.45) },
      ],
    }),
  );
  if (!paths.ring || !paths.stroke)
    return <Ionicons name="checkmark" size={size} color={color} />;
  return (
    <Animated.View style={[{ width: size, height: size }, style, pop]}>
      <Canvas pointerEvents="none" style={{ width: size, height: size }}>
        <Group transform={[{ scale: size / 24 }]}>
          <Path
            path={paths.ring}
            style="stroke"
            strokeWidth={strokeWidth}
            strokeCap="round"
            color={color}
            opacity={ringOpacity}
            end={ringEnd}
          />
          <Path
            path={paths.stroke}
            style="stroke"
            strokeWidth={strokeWidth}
            strokeCap="round"
            strokeJoin="round"
            color={color}
            end={strokeEnd}
          />
        </Group>
      </Canvas>
    </Animated.View>
  );
}
