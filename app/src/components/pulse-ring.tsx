// 呼吸波纹动效：active 时从中心持续外扩渐隐的圆环（发言指示/PTT 反馈用）
// 用 RN 内置 Animated + useNativeDriver，不引入动画库依赖
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

function Ring({
  progress,
  size,
  color,
  maxScale,
}: {
  progress: Animated.Value;
  size: number;
  color: string;
  maxScale: number;
}) {
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.ring,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: color,
          opacity: progress.interpolate({
            inputRange: [0, 0.15, 1],
            outputRange: [0, 0.55, 0],
          }),
          transform: [
            {
              scale: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [1, maxScale],
              }),
            },
          ],
        },
      ]}
    />
  );
}

/**
 * 包一层相对定位容器使用：<View><PulseRing active size color /><你的圆形内容/></View>
 * count 圈波纹错峰循环；inactive 时自动停止并隐藏。
 * 系统开了「减弱动态效果」就不画：这是装饰，状态由调用方的颜色和文字表达。
 */
export function PulseRing({
  active,
  size,
  color,
  count = 2,
  duration = 1600,
  maxScale = 1.55,
}: {
  active: boolean;
  size: number;
  color: string;
  count?: number;
  duration?: number;
  maxScale?: number;
}) {
  // useState 惰性初始化：稳定引用且渲染期可安全访问（useRef.current 会触发 react-compiler 告警）
  const [values] = useState(() =>
    Array.from({ length: count }, () => new Animated.Value(0)),
  );

  const reduced = useReducedMotion();
  const running = active && !reduced;

  useEffect(() => {
    if (!running) {
      values.forEach((v) => v.setValue(0));
      return;
    }
    const loops = values.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay((duration / count) * i),
          Animated.timing(v, {
            toValue: 1,
            duration,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => {
      loops.forEach((l) => l.stop());
      values.forEach((v) => v.setValue(0));
    };
  }, [running, values, count, duration]);

  if (!running) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.center}>
        {values.map((v, i) => (
          <Ring key={i} progress={v} size={size} color={color} maxScale={maxScale} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', borderWidth: 3 },
});
