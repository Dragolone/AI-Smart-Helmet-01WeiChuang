// 页面上遮罩要落上去的元素。两件事：把自己在窗口里的位置报给遮罩；遮罩还画着它的时候先不显示，
// 等遮罩把自己的那一份送到位再换上来（位置相同，所以看不出换）。没有开屏在播时就是一个普通的容器。
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";

import {
  anchorOwned,
  anchorRect,
  markPageReady,
  setAnchorData,
  type AnchorName,
} from "./bus";

export function SplashAnchor({
  name,
  data,
  style,
  children,
}: {
  name: AnchorName;
  /** 遮罩画它的那一份时要用到的东西 */
  data?: unknown;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const ref = useRef<View>(null);
  const report = useCallback(() => {
    ref.current?.measureInWindow((x, y, w, h) => {
      if (w <= 0 || h <= 0) return;
      anchorRect[name].set({ x, y, w, h });
      markPageReady();
    });
  }, [name]);
  useEffect(() => {
    setAnchorData(name, data);
  }, [name, data]);
  // 位置可能在布局之后才稳定（滚动区量到高度、图片加载完）：挂上之后再量几次
  useEffect(() => {
    const timers = [50, 250, 700, 1500].map((ms) => setTimeout(report, ms));
    return () => timers.forEach(clearTimeout);
  }, [report, data]);
  // 0..1：遮罩把自己的那一份交还时是渐变着换的
  const hidden = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, Math.max(0, anchorOwned[name].get())),
  }));
  return (
    <Animated.View
      ref={ref}
      collapsable={false}
      onLayout={report}
      style={[style, hidden]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * 放在冷启动可能落到的页面里：它排好版，就说明这一页（哪怕只是骨架）已经搭好了，开屏可以起步。
 * 页面上有 SplashAnchor 时不用另放，它量到位置也算。
 */
export function SplashPageMark() {
  return (
    <View
      pointerEvents="none"
      collapsable={false}
      onLayout={markPageReady}
      style={styles.mark}
    />
  );
}

const styles = StyleSheet.create({
  mark: { position: "absolute", width: 1, height: 1, opacity: 0 },
});
