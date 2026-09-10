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
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const BG = '#0E0F12';   // App 暗色底,与页面无缝
const BRAND = '#5CF0FF';
const SWEEP_STEP = 55;      // 每字流光间隔
const SWEEP_DUR = 650;      // 单字提亮-回落
const WORD = 'ZERO-ONE INNOVATION'.split('');
const SWEEP_TOTAL = SWEEP_STEP * WORD.length + SWEEP_DUR;
/** 环形扫光:一圈时长与起始延迟(从正上方顺时针一周) */
const REV_MS = 1600;
const REV_DELAY = 250;
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
    <Animated.Text style={[styles.en, { textShadowColor: BRAND }, st]}>{ch}</Animated.Text>
  );
}

/** 背景光点:被 360° 环形扫光依次点亮——延迟按方位角对齐光束经过时刻,
 *  亮起后渐暗为余晖,一次性(不循环) */
function Star({ x, y, size }: { x: number; y: number; size: number }) {
  const p = useSharedValue(0);
  useEffect(() => {
    // 屏幕坐标 atan2(y,x):270°=正上;光束自正上方顺时针一周
    const theta = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const frac = ((theta - 270 + 360) % 360) / 360;
    p.set(
      withDelay(
        REV_DELAY + frac * REV_MS,
        withTiming(1, { duration: 950, easing: Easing.out(Easing.quad) }),
      ),
    );
  }, [p, x, y]);
  const st = useAnimatedStyle(() => ({
    opacity: interpolate(p.get(), [0, 0.3, 1], [0, 0.65, 0.12]),
    transform: [
      { translateX: x },
      { translateY: y },
      { scale: interpolate(p.get(), [0, 0.3, 1], [0.7, 1.2, 0.95]) },
    ],
  }));
  return (
    <Animated.View
      style={[styles.star, { width: size, height: size, borderRadius: size / 2 }, st]}
    />
  );
}

// 不规则散布在构图四周(半径/角度/大小都打乱,视觉上像随机落点);
// 避让区:商标(|x|<100 且 |y|<100)与文字带(|y|<34 且 |x|<130)
const STARS = [
  { x: -148, y: -96, size: 5 },
  { x: -58, y: -152, size: 6 },
  { x: 52, y: -118, size: 7 },
  { x: 152, y: -58, size: 5 },
  { x: 170, y: 66, size: 6 },
  { x: 96, y: 158, size: 7 },
  { x: 10, y: 122, size: 5 },
  { x: -104, y: 108, size: 6 },
  { x: -172, y: 20, size: 5 },
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
      {STARS.map((st, i) => (
        <Star key={i} {...st} />
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
      'radial-gradient(120% 100% at 70% 0%, #232A0E 0%, #15170C 55%, #0E0F12 100%)',
  },
  watermark: {
    position: 'absolute',
    width: 188,
    height: 188,
    opacity: 0.14,
  },
  textBlock: { alignItems: 'center', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center' },
  en: {
    color: '#F0F6FF',
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 1.2,
    textShadowOffset: { width: 0, height: 0 },
  },
  zh: {
    color: '#AEB4C0',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 4,
    opacity: 0.85,
  },
  star: {
    position: 'absolute',
    backgroundColor: '#D9F24A',
    shadowColor: '#D9F24A',
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
});
