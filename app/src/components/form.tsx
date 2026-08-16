// Auth/绑定表单的共用控件（2026-08-16 风格迭代）：
// 药丸主按钮（品牌荧光色 + 深色文字）、深色描边输入框、危险操作红药丸
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputProps,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export function FormInput(props: TextInputProps & { label: string }) {
  const { label, style, ...rest } = props;
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <>
      <ThemedText type="label" themeColor="textSecondary">
        {label}
      </ThemedText>
      <TextInput
        placeholderTextColor={theme.textSecondary}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          {
            color: theme.text,
            backgroundColor: theme.backgroundElement,
            borderColor: focused ? theme.brand : theme.border,
          },
          style,
        ]}
        {...rest}
      />
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
  input: {
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
  },
  button: {
    borderRadius: Radius.pill,
    paddingVertical: 16,
    alignItems: 'center',
  },
});
