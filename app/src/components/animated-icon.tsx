// 开屏动画:柔光弧环绕圈 + 「AI智能头盔」逐字波浪浮现 + 漂浮星点。
// 节奏参照 uiverse popular-puma 加载动效(逐字 stagger 波浪 + 旋转辉光),
// 实现与视觉全部按本项目暗色/荧光语言用 reanimated 重写,未引用其源码。
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const BG = '#0E0F12';
const BRAND = '#D4FF00';
const CYCLE = 2000;        // 一轮波浪/一圈辉光
const HOLD = 2400;         // 播完约一轮后开始淡出
const FADE = 420;

const LETTERS = ['A', 'I', '智', '能', '头', '盔'];

/** 逐字:静默(暗、微糊感) → 提亮放大上浮 → 回落,按序错峰 */
function WaveLetter({ ch, delay }: { ch: string; delay: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.set(
      withDelay(
        delay,
        withRepeat(withTiming(1, { duration: CYCLE, easing: Easing.linear }), -1, false),
      ),
    );
  }, [p, delay]);
  const st = useAnimatedStyle(() => {
    const t = p.get();
    return {
      opacity: interpolate(t, [0, 0.18, 0.4, 1], [0.3, 1, 0.42, 0.3]),
      transform: [
        { scale: interpolate(t, [0, 0.18, 0.4, 1], [1, 1.22, 1, 1]) },
        { translateY: interpolate(t, [0, 0.18, 0.4, 1], [0, -4, 0, 0]) },
      ],
      textShadowRadius: interpolate(t, [0, 0.18, 0.4, 1], [0, 12, 2, 0]),
    };
  });
  return (
    <Animated.Text style={[styles.letter, { textShadowColor: BRAND }, st]}>{ch}</Animated.Text>
  );
}

/** 环上柔光头尾双点,随容器整体旋转成"彗星扫圈" */
function OrbitGlow() {
  const rot = useSharedValue(0);
  useEffect(() => {
    rot.set(withRepeat(withTiming(360, { duration: CYCLE, easing: Easing.linear }), -1, false));
  }, [rot]);
  const st = useAnimatedStyle(() => ({
    transform: [{ rotateZ: `${rot.get()}deg` }],
  }));
  return (
    <Animated.View style={[styles.orbit, st]}>
      <View style={[styles.comet, { opacity: 0.95 }]} />
      <View style={[styles.comet, styles.cometTail1]} />
      <View style={[styles.comet, styles.cometTail2]} />
    </Animated.View>
  );
}

/** 漂浮星点:各自错峰呼吸 */
function Star({ x, y, size, delay }: { x: number; y: number; size: number; delay: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.set(
      withDelay(
        delay,
        withRepeat(withTiming(1, { duration: CYCLE, easing: Easing.linear }), -1, false),
      ),
    );
  }, [p, delay]);
  const st = useAnimatedStyle(() => ({
    opacity: interpolate(p.get(), [0, 0.5, 1], [0.12, 0.6, 0.12]),
    transform: [{ scale: interpolate(p.get(), [0, 0.5, 1], [0.9, 1.15, 0.9]) }],
  }));
  return (
    <Animated.View
      style={[
        styles.star,
        { width: size, height: size, borderRadius: size / 2, transform: [{ translateX: x }, { translateY: y }] },
        st,
      ]}
    />
  );
}

export function AnimatedSplashOverlay() {
  const [phase, setPhase] = useState<'boot' | 'anim'>('boot');
  const [visible, setVisible] = useState(true);
  const fade = useSharedValue(1);

  useEffect(() => {
    if (phase !== 'anim') return;
    fade.set(
      withDelay(
        HOLD,
        withTiming(0, { duration: FADE, easing: Easing.out(Easing.quad) }, (finished) => {
          'worklet';
          if (finished) scheduleOnRN(setVisible, false);
        }),
      ),
    );
  }, [phase, fade]);

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: fade.get(),
    transform: [{ scale: interpolate(fade.get(), [0, 1], [1.05, 1]) }],
  }));

  if (!visible) return null;

  if (phase === 'boot') {
    // 首帧静态字标,与原生启动图(纯 AI 字标)视觉衔接,隐藏原生层后进入动画
    return (
      <View
        onLayout={() => {
          SplashScreen.hideAsync().finally(() => setPhase('anim'));
        }}
        style={styles.overlay}>
        <View style={styles.letterRow}>
          {LETTERS.map((ch, i) => (
            <Text key={i} style={[styles.letter, { opacity: 0.3 }]}>
              {ch}
            </Text>
          ))}
        </View>
      </View>
    );
  }

  return (
    <Animated.View style={[styles.overlay, overlayStyle]}>
      <Star x={-96} y={-120} size={7} delay={300} />
      <Star x={110} y={-72} size={5} delay={800} />
      <Star x={-128} y={40} size={6} delay={100} />
      <Star x={88} y={96} size={8} delay={550} />
      <Star x={-40} y={148} size={5} delay={950} />
      <View style={styles.stage}>
        <OrbitGlow />
        <View style={styles.letterRow}>
          {LETTERS.map((ch, i) => (
            <WaveLetter key={i} ch={ch} delay={i * 120} />
          ))}
        </View>
      </View>
    </Animated.View>
  );
}

const RING = 316;

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: BG,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  stage: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orbit: { ...StyleSheet.absoluteFill },
  comet: {
    position: 'absolute',
    top: -4,
    left: RING / 2 - 5,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: BRAND,
    shadowColor: BRAND,
    shadowOpacity: 1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  cometTail1: {
    opacity: 0.4,
    transform: [{ translateX: -20 }, { translateY: 3 }, { scale: 0.7 }],
  },
  cometTail2: {
    opacity: 0.18,
    transform: [{ translateX: -38 }, { translateY: 9 }, { scale: 0.5 }],
  },
  letterRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  letter: {
    color: '#F5F6F8',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 1,
    textShadowOffset: { width: 0, height: 0 },
  },
  star: { position: 'absolute', backgroundColor: BRAND },
});
