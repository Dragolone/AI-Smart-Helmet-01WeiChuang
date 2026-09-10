// 开屏动画(公司品牌定稿版):
// 商标大水印居中作背景 → 「ZERO-ONE INNOVATION」压标居中,流光单次扫过 →
// 中文「零一唯创」小字随后浮现 → 背景散布呼吸光点 → 整层淡出。
import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const BG = '#070A18';
const CYAN = '#5CF0FF';
const SWEEP_STEP = 55;      // 每字流光间隔
const SWEEP_DUR = 650;      // 单字提亮-回落
const WORD = 'ZERO-ONE INNOVATION'.split('');
const SWEEP_TOTAL = SWEEP_STEP * WORD.length + SWEEP_DUR;
const HOLD = SWEEP_TOTAL + 900;   // 流光完+中文亮相后停留
const FADE = 460;

/** 单字:流光经过时提亮+发光,过后落回常亮(只跑一次) */
function ShineLetter({ ch, delay }: { ch: string; delay: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.set(withDelay(delay, withTiming(1, { duration: SWEEP_DUR, easing: Easing.out(Easing.quad) })));
  }, [p, delay]);
  const st = useAnimatedStyle(() => {
    const t = p.get();
    return {
      opacity: interpolate(t, [0, 0.45, 1], [0.4, 1, 0.94]),
      transform: [{ translateY: interpolate(t, [0, 0.45, 1], [0, -2, 0]) }],
      textShadowRadius: interpolate(t, [0, 0.45, 1], [0, 16, 2]),
    };
  });
  return (
    <Animated.Text style={[styles.en, { textShadowColor: CYAN }, st]}>{ch}</Animated.Text>
  );
}

/** 背景光点:错峰呼吸(明暗+缩放),不旋转 */
function Star({ x, y, size, delay, dur }: { x: number; y: number; size: number; delay: number; dur: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.set(
      withDelay(
        delay,
        withRepeat(withTiming(1, { duration: dur, easing: Easing.inOut(Easing.quad) }), -1, true),
      ),
    );
  }, [p, delay, dur]);
  const st = useAnimatedStyle(() => ({
    opacity: interpolate(p.get(), [0, 1], [0.08, 0.5]),
    transform: [{ scale: interpolate(p.get(), [0, 1], [0.8, 1.25]) }],
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

const STARS = [
  { x: -120, y: -210, size: 6, delay: 0, dur: 1600 },
  { x: 130, y: -160, size: 5, delay: 500, dur: 2100 },
  { x: -150, y: -40, size: 7, delay: 900, dur: 1800 },
  { x: 150, y: 30, size: 5, delay: 250, dur: 2300 },
  { x: -90, y: 170, size: 6, delay: 700, dur: 1900 },
  { x: 110, y: 220, size: 8, delay: 1100, dur: 1700 },
  { x: 20, y: -260, size: 5, delay: 350, dur: 2000 },
  { x: -30, y: 280, size: 5, delay: 1300, dur: 2200 },
];

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
    transform: [{ scale: interpolate(fade.get(), [0, 1], [1.04, 1]) }],
  }));

  if (!visible) return null;

  const watermark = (
    <Image
      source={require('@/assets/images/company-mark.png')}
      style={styles.watermark}
      contentFit="contain"
    />
  );

  if (phase === 'boot') {
    // 静帧与原生启动图一致:水印 + 常亮文字
    return (
      <View
        onLayout={() => {
          SplashScreen.hideAsync().finally(() => setPhase('anim'));
        }}
        style={styles.overlay}>
        {watermark}
        <View style={styles.textBlock}>
          <View style={styles.row}>
            {WORD.map((ch, i) => (
              <Text key={i} style={[styles.en, { opacity: 0.4 }]}>
                {ch}
              </Text>
            ))}
          </View>
        </View>
      </View>
    );
  }

  return (
    <Animated.View style={[styles.overlay, overlayStyle]}>
      {STARS.map((s, i) => (
        <Star key={i} {...s} />
      ))}
      {watermark}
      <View style={styles.textBlock}>
        <View style={styles.row}>
          {WORD.map((ch, i) => (
            <ShineLetter key={i} ch={ch} delay={i * SWEEP_STEP} />
          ))}
        </View>
        <Animated.Text
          entering={FadeIn.duration(600).delay(SWEEP_TOTAL - 200)}
          style={styles.zh}>
          零一唯创
        </Animated.Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    backgroundColor: BG,
    experimental_backgroundImage:
      'radial-gradient(120% 100% at 70% 0%, #142A73 0%, #0A1024 55%, #070A18 100%)',
  },
  watermark: {
    position: 'absolute',
    width: 300,
    height: 300,
    opacity: 0.14,
  },
  textBlock: { alignItems: 'center', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center' },
  en: {
    color: '#F0F6FF',
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 2,
    textShadowOffset: { width: 0, height: 0 },
  },
  zh: {
    color: '#9DB8FF',
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 6,
    opacity: 0.85,
  },
  star: { position: 'absolute', backgroundColor: CYAN },
});
