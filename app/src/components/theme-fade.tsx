// 深浅色切换的软过渡：切换瞬间用「旧主题底色」盖一层再 240ms 淡出，避免整屏硬切。
// 不重挂载任何东西（重挂载会丢导航栈），只是一层 pointerEvents=none 的覆盖。
import { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { Colors } from "@/constants/theme";

export function ThemeFade({ scheme }: { scheme: "light" | "dark" }) {
  const opacity = useSharedValue(0);
  const prev = useRef(scheme);
  const cover = useSharedValue(Colors[scheme].background);
  useEffect(() => {
    if (prev.current === scheme) return;
    cover.set(Colors[prev.current].background);
    prev.current = scheme;
    opacity.set(1);
    opacity.set(withTiming(0, { duration: 240 }));
  }, [scheme, opacity, cover]);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    backgroundColor: cover.get(),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.top, style]}
    />
  );
}

const styles = StyleSheet.create({ top: { zIndex: 1000, elevation: 1000 } });
