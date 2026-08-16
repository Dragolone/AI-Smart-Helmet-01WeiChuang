// Auth/绑定表单的共用控件（2026-08-16 风格迭代）：
// 药丸主按钮（品牌荧光色 + 深色文字）、深色描边输入框（可带前置图标）、危险操作红药丸
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
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
        {icon && (
          <Ionicons name={icon} size={18} color={theme.textSecondary} />
        )}
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

export function PrimaryButton({
  title,
  onPress,
  loading = false,
  danger = false,
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  danger?: boolean;
}) {
  const theme = useTheme();
  const bg = danger ? theme.danger : theme.brand;
  const fg = danger ? '#FFFFFF' : theme.onBrand;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: loading ? 0.6 : pressed ? 0.85 : 1 },
      ]}
      disabled={loading}
      onPress={onPress}>
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <ThemedText type="smallBold" style={{ color: fg, fontSize: 16 }}>
          {title}
        </ThemedText>
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
    borderRadius: Radius.pill,
    paddingVertical: 16,
    alignItems: 'center',
  },
});
