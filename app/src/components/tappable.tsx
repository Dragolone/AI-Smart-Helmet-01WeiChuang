// 统一的可点击容器：所有可点元素都必须有按压反馈（负责人 2026-09-10 口径）。
// 反馈 = 透明度下降 + 轻微缩放 + 可选触觉。
// scale 模式用 reanimated 弹簧（按下顺滑缩入、松手低阻尼回弹带轻微过冲）——
// 瞬时切换的缩放在真机上显僵硬（负责人 2026-09-11 动效口径:灵动不堆料）;
// opacity/fill 仍走 Pressable pressed 状态（文字/列表行不需要弹性）。
import * as Haptics from "expo-haptics";
import type { ReactElement } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";

import { useTheme } from "@/hooks/use-theme";

type Feedback = "opacity" | "fill" | "scale";

export type TappableProps = Omit<PressableProps, "style"> & {
  style?: StyleProp<ViewStyle>;
  /** opacity：整体变淡（图标按钮/文字链接）；fill：底色变 backgroundSelected（列表行）；scale：弹簧缩放（卡片/大按钮） */
  feedback?: Feedback | Feedback[];
  /** 按下时轻触觉；主操作、危险操作打开，列表行默认关 */
  haptic?: boolean;
};

/**
 * 只有 scale 模式才建 Reanimated 的共享值和动画样式（ScaleWrap）：全 App 100 来处调用里约 80 处不缩放，
 * 每个实例都白建这两样东西有跨线程成本（安全记录每页 50 行）。非 scale 直接返回 Pressable，渲染树和样式不变。
 * feedback 在「带 scale」和「不带 scale」之间运行中切换会让子树重新挂载，现有调用方没有这种用法。
 */
export function Tappable({
  style,
  feedback = "opacity",
  haptic = false,
  disabled,
  onPressIn,
  onPressOut,
  children,
  ...rest
}: TappableProps) {
  const theme = useTheme();
  const modes = Array.isArray(feedback) ? feedback : [feedback];
  const hasScale = modes.includes("scale");

  const pressable = (scale?: SharedValue<number>) => (
    <Pressable
      disabled={disabled}
      onPressIn={(e) => {
        if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        scale?.set(withSpring(0.965, { damping: 20, stiffness: 420 }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale?.set(withSpring(1, { damping: 9, stiffness: 240 }));
        onPressOut?.(e);
      }}
      style={({ pressed }) => [
        style,
        disabled && { opacity: 0.45 },
        pressed && modes.includes("opacity") && { opacity: 0.6 },
        pressed && modes.includes("fill") && { backgroundColor: theme.backgroundSelected },
      ]}
      {...rest}>
      {children}
    </Pressable>
  );

  if (!hasScale) return pressable();
  return <ScaleWrap hitSlop={rest.hitSlop} render={pressable} />;
}

/**
 * scale 模式:外层只挂弹簧变换,style 归 Pressable。
 * hitSlop 外层也要有:原生命中测试先问父视图,这层和 Pressable 一样大,点在它外面就不再往里找,Pressable 的 hitSlop 等于没写。
 */
function ScaleWrap({
  hitSlop,
  render,
}: {
  hitSlop: PressableProps["hitSlop"];
  render: (scale: SharedValue<number>) => ReactElement;
}) {
  const scale = useSharedValue(1);
  const springStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  return (
    <Animated.View hitSlop={hitSlop} style={springStyle}>
      {render(scale)}
    </Animated.View>
  );
}
