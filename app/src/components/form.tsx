// Auth/绑定表单的共用控件（2026-08-16 风格迭代；2026-09-10 重设计：按压反馈统一，新增描边次按钮）：
// 药丸主按钮（品牌荧光色 + 深色文字）、描边次按钮、深色描边输入框（可带前置图标）、危险操作红药丸
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function FormInput(
  props: TextInputProps & {
    label: string;
    icon?: keyof typeof Ionicons.glyphMap;
  },
) {
  const { label, icon, style, ...rest } = props;
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <>
      <ThemedText type="label" themeColor="textSecondary">
        {label}
      </ThemedText>
      <View
        style={[
          styles.inputWrap,
          {
            backgroundColor: theme.backgroundElement,
            borderColor: focused ? theme.brand : theme.border,
          },
        ]}>
        {icon && <Ionicons name={icon} size={18} color={theme.textSecondary} />}
        <TextInput
          placeholderTextColor={theme.textSecondary}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.input, { color: theme.text }, style]}
          {...rest}
        />
      </View>
    </>
  );
}

type ButtonProps = {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>;
  /** 紧凑档：46px 高、15px 字，用于卡片内并排的两个动作 */
  compact?: boolean;
};

/** 主按钮：品牌黄药丸。按压 = 变淡 + 轻缩 + 触觉（主操作都该有"按到了"的确认） */
export function PrimaryButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  danger = false,
  icon,
  style,
  compact = false,
}: ButtonProps & { danger?: boolean }) {
  const theme = useTheme();
  const bg = danger ? theme.danger : theme.brand;
  const fg = danger ? '#FFFFFF' : theme.onBrand;
  const inactive = loading || disabled;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: bg, opacity: inactive ? 0.55 : pressed ? 0.8 : 1 },
        pressed && !inactive && { transform: [{ scale: 0.97 }] },
        style,
      ]}
      disabled={inactive}
      onPressIn={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})}
      onPress={onPress}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={compact ? 17 : 18} color={fg} />}
          <ThemedText type="smallBold" style={{ color: fg, fontSize: compact ? 15 : 16 }}>
            {title}
          </ThemedText>
        </>
      )}
    </Pressable>
  );
}

/** 次按钮：描边药丸，白字。用于同屏第二动作（绑定新设备、历史轨迹、邀请码加入） */
export function SecondaryButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  icon,
  style,
  compact = false,
}: ButtonProps) {
  const theme = useTheme();
  const inactive = loading || disabled;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        styles.secondary,
        {
          borderColor: 'rgba(255,255,255,0.24)',
          backgroundColor: pressed ? theme.backgroundSelected : 'transparent',
          opacity: inactive ? 0.55 : 1,
        },
        pressed && !inactive && { transform: [{ scale: 0.97 }] },
        style,
      ]}
      disabled={inactive}
      onPress={onPress}>
      {loading ? (
        <ActivityIndicator color={theme.text} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={compact ? 17 : 18} color={theme.text} />}
          <ThemedText type="smallBold" style={{ color: theme.text, fontSize: compact ? 15 : 16 }}>
            {title}
          </ThemedText>
        </>
      )}
    </Pressable>
  );
}

export function FormError({ message }: { message: string | null }) {
  const theme = useTheme();
  if (!message) return null;
  return (
    <ThemedText type="small" style={{ color: theme.danger }}>
      {message}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 16,
  },
  button: {
    flexDirection: 'row',
    gap: 8,
    borderRadius: Radius.pill,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonCompact: { height: 46 },
  secondary: { borderWidth: 1 },
});
