// Auth/绑定表单的共用控件：输入框、主按钮、错误提示（跟随主题）
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputProps,
  useColorScheme,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors } from '@/constants/theme';

export function FormInput(props: TextInputProps & { label: string }) {
  const { label, style, ...rest } = props;
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];
  const [focused, setFocused] = useState(false);
  return (
    <>
      <ThemedText type="smallBold">{label}</ThemedText>
      <TextInput
        placeholderTextColor={colors.textSecondary}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.backgroundElement,
            borderColor: focused ? '#208AEF' : 'transparent',
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
  return (
    <Pressable
      style={[styles.button, danger && styles.buttonDanger, loading && styles.buttonDisabled]}
      disabled={loading}
      onPress={onPress}>
      {loading ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <ThemedText type="smallBold" style={styles.buttonText}>
          {title}
        </ThemedText>
      )}
    </Pressable>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <ThemedText type="small" style={styles.error}>
      {message}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  input: {
    borderRadius: 12,
    borderWidth: 1.5,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDanger: { backgroundColor: '#D9534F' },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff' },
  error: { color: '#D9534F' },
});
