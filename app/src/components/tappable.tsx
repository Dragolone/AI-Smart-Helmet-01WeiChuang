// 统一的可点击容器：所有可点元素都必须有按压反馈（负责人 2026-09-10 口径）。
// 反馈 = 透明度下降 + 轻微缩放 + 可选触觉；用 Pressable 的 pressed 状态驱动，不引动画库。
// 为什么不用 TouchableOpacity：它的反馈只有透明度，且在 Android 新架构下偶发延迟；
// Pressable 的 pressed 回调是同步的，双端一致。
import * as Haptics from 'expo-haptics';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

type Feedback = 'opacity' | 'fill' | 'scale';

export type TappableProps = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** opacity：整体变淡（图标按钮/文字链接）；fill：底色变 backgroundSelected（列表行）；scale：缩小到 0.97（卡片/大按钮） */
  feedback?: Feedback | Feedback[];
  /** 按下时轻触觉；主操作、危险操作打开，列表行默认关 */
  haptic?: boolean;
};

export function Tappable({
  style,
  feedback = 'opacity',
  haptic = false,
  disabled,
  onPressIn,
  children,
  ...rest
}: TappableProps) {
  const theme = useTheme();
  const modes = Array.isArray(feedback) ? feedback : [feedback];
  return (
    <Pressable
      disabled={disabled}
      onPressIn={(e) => {
        if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPressIn?.(e);
      }}
      style={({ pressed }) => [
        style,
        disabled && { opacity: 0.45 },
        pressed && modes.includes('opacity') && { opacity: 0.6 },
        pressed && modes.includes('fill') && { backgroundColor: theme.backgroundSelected },
        pressed && modes.includes('scale') && { transform: [{ scale: 0.97 }] },
      ]}
      {...rest}>
      {children}
    </Pressable>
  );
}
