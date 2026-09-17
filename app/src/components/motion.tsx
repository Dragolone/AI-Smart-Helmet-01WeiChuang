// 轻量动效原语（2026-09-17 动效批次 2）：只调"手感"，不堆视觉料；全部 reanimated 本地实现。
// - AnimatedChip：选中态颜色过渡 + 选中瞬间小弹一下（分段选择不再硬切）
// - ValueTransition：数值变化时旧值上滑淡出、新值下滑淡入（数据"活"起来）
// - PulseDot：进行中状态的呼吸点（搜索/连接中）；静态时不动
// - DotsLoader：三点波浪 loader（按钮 loading 态）
// - useJello：长按未满松手时的果冻抖动（提示"要按住"，不是装饰）
import type { ReactNode } from "react";
import { useEffect } from "react";
import {
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  FadeInDown,
  FadeOutUp,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";

const COLOR_MS = 180;

export function AnimatedChip({
  active,
  onPress,
  disabled = false,
  label,
  activeBg,
  inactiveBg,
  activeFg,
  inactiveFg,
  style,
  textStyle,
  borderActive,
  borderInactive,
}: {
  active: boolean;
  onPress: () => void;
  disabled?: boolean;
  label: string;
  activeBg: string;
  inactiveBg: string;
  activeFg: string;
  inactiveFg: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  borderActive?: string;
  borderInactive?: string;
}) {
  const progress = useSharedValue(active ? 1 : 0);
  const pop = useSharedValue(1);
  useEffect(() => {
    progress.set(withTiming(active ? 1 : 0, { duration: COLOR_MS }));
    if (active) {
      // 选中瞬间：1 → 1.06 → 1，低阻尼回弹
      pop.set(
        withSequence(
          withTiming(1.06, { duration: 90 }),
          withSpring(1, { damping: 12, stiffness: 320 }),
        ),
      );
    }
  }, [active, progress, pop]);
  const boxStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      progress.get(),
      [0, 1],
      [inactiveBg, activeBg],
    ),
    ...(borderActive && borderInactive
      ? {
          borderColor: interpolateColor(
            progress.get(),
            [0, 1],
            [borderInactive, borderActive],
          ),
        }
      : {}),
    transform: [{ scale: pop.get() }],
  }));
  const fg = useDerivedValue(() =>
    interpolateColor(progress.get(), [0, 1], [inactiveFg, activeFg]),
  );
  const labelStyle = useAnimatedStyle(() => ({ color: fg.get() }));
  return (
    <Tappable disabled={disabled} onPress={onPress} feedback="opacity">
      <Animated.View style={[style, boxStyle]}>
        <Animated.Text style={[styles.chipText, textStyle, labelStyle]}>
          {label}
        </Animated.Text>
      </Animated.View>
    </Tappable>
  );
}

/** 数值变化过渡：key 变化触发进出场，reanimated 的退场在快照上播放，不撑开布局 */
export function ValueTransition({
  value,
  children,
  style,
}: {
  value: string | number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    // flexShrink/minWidth：作为 flex row 里的一员要能被压缩，否则数字撑出单位（地图里程实测）
    <View style={[styles.shrink, style]}>
      <Animated.View
        style={styles.shrink}
        key={String(value)}
        entering={FadeInDown.duration(200).easing(Easing.out(Easing.cubic))}
        exiting={FadeOutUp.duration(140)}
      >
        {children}
      </Animated.View>
    </View>
  );
}

/** 呼吸点：active 时 0.35 ↔ 1 循环（1.1 s），否则静态实心 */
export function PulseDot({
  color,
  size = 8,
  active,
  style,
}: {
  color: string;
  size?: number;
  active: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (active) {
      opacity.set(
        withRepeat(
          withSequence(
            withTiming(0.35, { duration: 550 }),
            withTiming(1, { duration: 550 }),
          ),
          -1,
          true,
        ),
      );
    } else {
      opacity.set(withTiming(1, { duration: 200 }));
    }
  }, [active, opacity]);
  const s = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        },
        style,
        s,
      ]}
    />
  );
}

/** 三点波浪：每点相位错开 120 ms，上下 4pt */
export function DotsLoader({
  color,
  size = 6,
}: {
  color: string;
  size?: number;
}) {
  return (
    <View style={styles.dotsRow}>
      {[0, 1, 2].map((i) => (
        <Dot key={i} color={color} size={size} delay={i * 120} />
      ))}
    </View>
  );
}

function Dot({
  color,
  size,
  delay,
}: {
  color: string;
  size: number;
  delay: number;
}) {
  const y = useSharedValue(0);
  useEffect(() => {
    y.set(
      withDelay(
        delay,
        withRepeat(
          withSequence(
            withTiming(-4, { duration: 260 }),
            withTiming(0, { duration: 260 }),
          ),
          -1,
          true,
        ),
      ),
    );
  }, [delay, y]);
  const s = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));
  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        },
        s,
      ]}
    />
  );
}

/** 果冻抖动：水平 scaleX/scaleY 交替 3 次，总时长 ~420 ms */
export function useJello() {
  const sx = useSharedValue(1);
  const sy = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ scaleX: sx.get() }, { scaleY: sy.get() }],
  }));
  const trigger = () => {
    sx.set(
      withSequence(
        withTiming(1.05, { duration: 70 }),
        withTiming(0.96, { duration: 70 }),
        withTiming(1.03, { duration: 70 }),
        withTiming(0.98, { duration: 70 }),
        withTiming(1, { duration: 140 }),
      ),
    );
    sy.set(
      withSequence(
        withTiming(0.95, { duration: 70 }),
        withTiming(1.04, { duration: 70 }),
        withTiming(0.97, { duration: 70 }),
        withTiming(1.02, { duration: 70 }),
        withTiming(1, { duration: 140 }),
      ),
    );
  };
  return { style, trigger };
}

/** 列表条目错峰入场：第 i 项延迟 min(i×40, 320) ms */
export const listEntering = (i: number) =>
  FadeInDown.duration(280).delay(Math.min(i * 40, 320));

/** 供需要纯文本动画样式的地方复用 */
export const MotionText = ThemedText;

const styles = StyleSheet.create({
  chipText: { fontSize: 13, fontWeight: "700" },
  shrink: { flexShrink: 1, minWidth: 0 },
  dotsRow: { flexDirection: "row", alignItems: "center", gap: 5, height: 20 },
});
