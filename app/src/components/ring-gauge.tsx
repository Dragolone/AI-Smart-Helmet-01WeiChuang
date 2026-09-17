// 环形仪表（无 SVG 依赖）：两个半圆裁切盒 + 旋转半盘的经典做法，中心盖一块底色盘留出环。
// 0–50% 走右半环（从顶部顺时针到底部），50–100% 走左半环（从底部继续到顶部）。
import type { ReactNode } from "react";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

export function RingGauge({
  value,
  size = 64,
  stroke = 7,
  color,
  track,
  inner,
  children,
}: {
  /** 0–100 */
  value: number;
  size?: number;
  stroke?: number;
  color: string;
  track: string;
  /** 中心盘颜色 = 卡片底色 */
  inner: string;
  children?: ReactNode;
}) {
  const p = useSharedValue(0);
  useEffect(() => {
    const v = Math.max(0, Math.min(100, value)) / 100;
    p.set(withTiming(v, { duration: 700, easing: Easing.out(Easing.cubic) }));
  }, [value, p]);
  // 右半：0→0.5 映射到 0→180°；左半：0.5→1 映射到 0→180°
  const rightStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${Math.min(p.get(), 0.5) * 360}deg` }],
  }));
  const leftStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${Math.max(p.get() - 0.5, 0) * 360}deg` }],
  }));
  const half = size / 2;
  const disc = { width: size, height: size, borderRadius: half };
  return (
    <View style={[disc, { backgroundColor: track }]}>
      {/* 右半裁切盒：里面放一个左半盘，旋转进来 */}
      <View style={[styles.clip, { left: half, width: half, height: size }]}>
        <Animated.View
          style={[styles.rot, disc, { marginLeft: -half }, rightStyle]}
        >
          <View
            style={{
              width: half,
              height: size,
              backgroundColor: color,
              borderTopLeftRadius: half,
              borderBottomLeftRadius: half,
            }}
          />
        </Animated.View>
      </View>
      {/* 左半裁切盒：里面放一个右半盘 */}
      <View style={[styles.clip, { left: 0, width: half, height: size }]}>
        <Animated.View style={[styles.rot, disc, leftStyle]}>
          <View style={{ width: half, height: size, marginLeft: half }}>
            <View
              style={{
                width: half,
                height: size,
                backgroundColor: color,
                borderTopRightRadius: half,
                borderBottomRightRadius: half,
              }}
            />
          </View>
        </Animated.View>
      </View>
      <View
        style={[
          styles.center,
          {
            left: stroke,
            top: stroke,
            width: size - stroke * 2,
            height: size - stroke * 2,
            borderRadius: half - stroke,
            backgroundColor: inner,
          },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { position: "absolute", top: 0, overflow: "hidden" },
  rot: { position: "absolute", top: 0, left: 0 },
  center: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
});
