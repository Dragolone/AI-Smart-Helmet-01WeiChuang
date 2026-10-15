// 轻量动效原语（2026-09-17 动效批次 2）：只调"手感"，不堆视觉料；全部 reanimated 本地实现。
// - AnimatedChip：选中态颜色过渡 + 选中瞬间小弹一下（分段选择不再硬切）
// - ValueTransition：数值变化时旧值上滑淡出、新值下滑淡入（数据"活"起来）
// - PulseDot：进行中状态的呼吸点（搜索/连接中）；静态时不动
// - DotsLoader：三点波浪 loader（按钮 loading 态）
// - useJello：长按未满松手时的果冻抖动（提示"要按住"，不是装饰）
// 2026-10-15 联动批次（负责人画板口径：状态翻转时整块一起过渡，不硬切）：
// - useTintStyle：底色 / 描边 / 文字颜色变化时过渡
// - CrossfadeIcon：换图标 / 换颜色时淡入淡出，可选弹一下
import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import {
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutUp,
  LayoutAnimationConfig,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
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
/** 状态色过渡的时长：连上 / 断开、电量跨档、核对项变档都用它 */
export const TINT_MS = 240;

/**
 * 底色 / 描边 / 文字颜色变化时过渡（TINT_MS），不硬切。交给 Animated.View / Animated.Text 的 style。
 * 只过渡颜色：位置、大小这类布局属性不走这里（Android 上持续变 transform 会不停发无障碍事件）。
 */
export function useTintStyle(tint: {
  backgroundColor?: string;
  borderColor?: string;
  color?: string;
}) {
  const { backgroundColor, borderColor, color } = tint;
  return useAnimatedStyle(() => {
    const out: {
      backgroundColor?: string;
      borderColor?: string;
      color?: string;
    } = {};
    if (backgroundColor !== undefined)
      out.backgroundColor = withTiming(backgroundColor, { duration: TINT_MS });
    if (borderColor !== undefined)
      out.borderColor = withTiming(borderColor, { duration: TINT_MS });
    if (color !== undefined) out.color = withTiming(color, { duration: TINT_MS });
    return out;
  }, [backgroundColor, borderColor, color]);
}

/**
 * 换图标 / 换颜色时淡入淡出（旧的在快照上淡出、新的淡入），pop 时再弹一下；不硬切。
 * 核对项变档、「安全」格的结论、状态卡的图标都用它。首次挂上不动。
 */
export function CrossfadeIcon({
  name,
  size,
  color,
  pop = false,
  style,
}: {
  name: keyof typeof Ionicons.glyphMap;
  size: number;
  color: string;
  /** 换的时候弹一下（1 → 1.25 → 1）；系统开了「减弱动态效果」时不弹 */
  pop?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const scale = useSharedValue(1);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!pop || reduced) return;
    scale.set(
      withSequence(
        withTiming(1.25, { duration: 110 }),
        withSpring(1, { damping: 12, stiffness: 320 }),
      ),
    );
  }, [name, color, pop, reduced, scale]);
  const popStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  return (
    <Animated.View style={[{ width: size, height: size }, style, popStyle]}>
      <LayoutAnimationConfig skipEntering>
        <Animated.View
          key={`${name}|${color}`}
          entering={FadeIn.duration(TINT_MS)}
          exiting={FadeOut.duration(TINT_MS)}
          style={styles.fillAbs}
        >
          <Ionicons name={name} size={size} color={color} />
        </Animated.View>
      </LayoutAnimationConfig>
    </Animated.View>
  );
}

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
  fillAbs: {
    position: "absolute",
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
});
