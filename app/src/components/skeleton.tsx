// 首屏加载骨架:透明度脉冲占位块。纯 JS,无原生依赖。
// Animated.Value 用惰性 useState 持有(useRef(...).current 渲染期读 ref 会被
// React Compiler 报错,同 toast.tsx 的教训)。
import { useEffect, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';
import type { DimensionValue, StyleProp, ViewStyle } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

interface Props {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

export function Skeleton({ width = '100%', height = 16, radius = 8, style }: Props) {
  const theme = useTheme();
  const [pulse] = useState(() => new Animated.Value(0.35));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.75, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={[
        styles.base,
        { width, height, borderRadius: radius, opacity: pulse, backgroundColor: theme.backgroundSelected },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({ base: { overflow: 'hidden' } });
