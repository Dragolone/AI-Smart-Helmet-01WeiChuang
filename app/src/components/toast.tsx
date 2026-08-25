// 全局轻提示:2 秒自动消失,替代"操作成功"类 Alert(危险操作确认仍用 Alert)。
// 模块级 showToast() + 根布局挂载一次 <ToastHost/>;纯 JS,无原生依赖。
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Listener = (message: string) => void;
let listener: Listener | null = null;

/** 任意位置调用;Host 未挂载时静默丢弃(不阻塞业务) */
export function showToast(message: string): void {
  listener?.(message);
}

const SHOW_MS = 2000;

export function ToastHost() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);
  // Animated.Value 用惰性 useState 持有:useRef(...).current 属渲染期读 ref,React Compiler 报错
  const [opacity] = useState(() => new Animated.Value(0));
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    listener = (msg) => {
      setMessage(msg);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(
          () => setMessage(null),
        );
      }, SHOW_MS);
    };
    return () => {
      listener = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [opacity]);

  if (!message) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.toast,
        {
          opacity,
          bottom: insets.bottom + 96,
          backgroundColor: theme.backgroundSelected,
          borderColor: theme.border,
        },
      ]}>
      <ThemedText type="smallBold" style={styles.text}>
        {message}
      </ThemedText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '80%',
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 10,
    zIndex: 999,
    elevation: 20,
  },
  text: { fontSize: 14, textAlign: 'center' },
});
