// 全局轻提示:自动消失(16 字以内 2 秒,更长的按字数加到 5 秒封顶),替代"操作成功"类 Alert(危险操作确认仍用 Alert)。
// 模块级 showToast() + 根布局挂载一次 <ToastHost/>;纯 JS,无原生依赖。
import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { whenSplashGone } from "@/components/splash/covering";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

type Listener = (message: string) => void;
let listener: Listener | null = null;

/**
 * 任意位置调用;Host 未挂载时静默丢弃(不阻塞业务)。
 * 冷启动开屏还盖着时先压着、等它让开再出:安卓上这条带 elevation,会叠在开屏上;
 * iOS 上被开屏挡住,2 秒后自己消失,等于没提示过(冷启动时到的低电量提醒就会落在这一段,2026-10-21)
 */
export function showToast(message: string): void {
  whenSplashGone(() => listener?.(message));
}

const SHOW_MS = 2000;
const SHOW_MAX_MS = 5000;
/** 超过这么多字才开始加时 */
const SHORT_CHARS = 16;
const EXTRA_MS_PER_CHAR = 150;

/**
 * 固定 2 秒读不完长句:「通话已被结束:你的账号可能在另一台手机上进入了对讲」这种一闪而过。
 * 16 字以内不变(「已保存」这类短提示不拖长),之后每多一字加 150 ms,5 秒封顶
 */
function showMsFor(message: string): number {
  const extra = Math.max(0, message.length - SHORT_CHARS) * EXTRA_MS_PER_CHAR;
  return Math.min(SHOW_MAX_MS, SHOW_MS + extra);
}

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
      Animated.timing(opacity, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }).start(() => setMessage(null));
      }, showMsFor(msg));
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
          transform: [
            {
              translateY: opacity.interpolate({
                inputRange: [0, 1],
                outputRange: [14, 0],
              }),
            },
          ],
          bottom: insets.bottom + 96,
          backgroundColor: theme.backgroundSelected,
          borderColor: theme.border,
        },
      ]}
    >
      <ThemedText type="smallBold" style={styles.text}>
        {message}
      </ThemedText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    alignSelf: "center",
    maxWidth: "80%",
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 10,
    zIndex: 999,
    elevation: 20,
  },
  text: { fontSize: 14, textAlign: "center" },
});
