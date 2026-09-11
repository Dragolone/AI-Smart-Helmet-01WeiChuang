// 统一的可点击容器：所有可点元素都必须有按压反馈（负责人 2026-09-10 口径）。
// 反馈 = 透明度下降 + 轻微缩放 + 可选触觉。
// scale 模式用 reanimated 弹簧（按下顺滑缩入、松手低阻尼回弹带轻微过冲）——
// 瞬时切换的缩放在真机上显僵硬（负责人 2026-09-11 动效口径:灵动不堆料）;
// opacity/fill 仍走 Pressable pressed 状态（文字/列表行不需要弹性）。
import * as Haptics from "expo-haptics";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import { useTheme } from "@/hooks/use-theme";

type Feedback = "opacity" | "fill" | "scale";

export type TappableProps = Omit<PressableProps, "style"> & {
  style?: StyleProp<ViewStyle>;
  /** opacity：整体变淡（图标按钮/文字链接）；fill：底色变 backgroundSelected（列表行）；scale：弹簧缩放（卡片/大按钮） */
  feedback?: Feedback | Feedback[];
  /** 按下时轻触觉；主操作、危险操作打开，列表行默认关 */
  haptic?: boolean;
};

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
  const scale = useSharedValue(1);
  const springStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));

  const inner = (
    <Pressable
      disabled={disabled}
      onPressIn={(e) => {
        if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        if (hasScale) scale.set(withSpring(0.965, { damping: 20, stiffness: 420 }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        if (hasScale) scale.set(withSpring(1, { damping: 9, stiffness: 240 }));
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

  if (!hasScale) return inner;
  // scale 模式:外层只挂弹簧变换,style/热区仍归 Pressable
  return <Animated.View style={springStyle}>{inner}</Animated.View>;
}
