// 开屏动画(公司品牌版):深空蓝底(官网径向渐变)+ 公司字标居中呼吸 +
// 荧光彗星绕标扫圈 + 「01WeiChuang」逐字波浪(青色霓虹,官网 #5CF0FF)。
// 节奏参照 uiverse popular-puma;实现为 reanimated 重写,未引用其源码。
import { Image } from 'expo-image';
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

const BG = '#070A18';           // 官网深空底
const CYAN = '#5CF0FF';         // 官网霓虹青
const CYCLE = 2200;
const HOLD = 2600;
const FADE = 420;

const WORD = '01WeiChuang'.split('');

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
      opacity: interpolate(t, [0, 0.16, 0.38, 1], [0.32, 1, 0.45, 0.32]),
      transform: [
        { scale: interpolate(t, [0, 0.16, 0.38, 1], [1, 1.24, 1, 1]) },
        { translateY: interpolate(t, [0, 0.16, 0.38, 1], [0, -4, 0, 0]) },
      ],
      textShadowRadius: interpolate(t, [0, 0.16, 0.38, 1], [0, 14, 3, 0]),
    };
  });
  return (
    <Animated.Text style={[styles.letter, { textShadowColor: CYAN }, st]}>{ch}</Animated.Text>
  );
}

/** 彗星绕公司字标扫圈(青色,双层拖尾) */
function OrbitGlow() {
  const rot = useSharedValue(0);
  useEffect(() => {
    rot.set(withRepeat(withTiming(360, { duration: CYCLE, easing: Easing.linear }), -1, false));
  }, [rot]);
  const st = useAnimatedStyle(() => ({ transform: [{ rotateZ: `${rot.get()}deg` }] }));
  return (
    <Animated.View style={[styles.orbit, st]}>
      <View style={[styles.comet, { opacity: 0.95 }]} />
      <View style={[styles.comet, styles.cometTail1]} />
      <View style={[styles.comet, styles.cometTail2]} />
    </Animated.View>
  );
}

/** 公司字标:轻微呼吸 */
function Mark() {
  const p = useSharedValue(0);
  useEffect(() => {
    p.set(withRepeat(withTiming(1, { duration: CYCLE, easing: Easing.inOut(Easing.quad) }), -1, true));
  }, [p]);
  const st = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(p.get(), [0, 1], [1, 1.05]) }],
  }));
  return (
    <Animated.View style={st}>
      <Image
        source={require('@/assets/images/company-mark.png')}
        style={styles.mark}
        contentFit="contain"
      />
    </Animated.View>
  );
}

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
    opacity: interpolate(p.get(), [0, 0.5, 1], [0.1, 0.55, 0.1]),
    transform: [{ scale: interpolate(p.get(), [0, 0.5, 1], [0.9, 1.2, 0.9]) }],
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

  const staticContent = (
    <>
      <Image
        source={require('@/assets/images/company-mark.png')}
        style={styles.mark}
        contentFit="contain"
      />
      <View style={styles.letterRow}>
        {WORD.map((ch, i) => (
          <Text key={i} style={[styles.letter, { opacity: 0.32 }]}>
            {ch}
          </Text>
        ))}
      </View>
    </>
  );

  if (phase === 'boot') {
    return (
      <View
        onLayout={() => {
          SplashScreen.hideAsync().finally(() => setPhase('anim'));
        }}
        style={styles.overlay}>
        {staticContent}
      </View>
    );
  }

  return (
    <Animated.View style={[styles.overlay, overlayStyle]}>
      <Star x={-104} y={-150} size={6} delay={300} />
      <Star x={120} y={-96} size={5} delay={800} />
      <Star x={-136} y={20} size={6} delay={100} />
      <Star x={96} y={70} size={7} delay={550} />
      <Star x={-44} y={128} size={5} delay={950} />
      <View style={styles.stage}>
        <OrbitGlow />
        <Mark />
      </View>
      <View style={styles.letterRow}>
        {WORD.map((ch, i) => (
          <WaveLetter key={i} ch={ch} delay={i * 90} />
        ))}
      </View>
    </Animated.View>
  );
}

const RING = 196;

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    backgroundColor: BG,
    // 官网主视觉的深蓝径向光(顶部偏右),RN 0.86 实验特性,失效则回落纯色
    experimental_backgroundImage:
      'radial-gradient(120% 100% at 70% 0%, #142A73 0%, #0A1024 55%, #070A18 100%)',
  },
  stage: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 26,
  },
  orbit: { ...StyleSheet.absoluteFill },
  comet: {
    position: 'absolute',
    top: -4,
    left: RING / 2 - 5,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: CYAN,
    shadowColor: CYAN,
    shadowOpacity: 1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  cometTail1: { opacity: 0.4, transform: [{ translateX: -18 }, { translateY: 3 }, { scale: 0.7 }] },
  cometTail2: { opacity: 0.18, transform: [{ translateX: -34 }, { translateY: 8 }, { scale: 0.5 }] },
  mark: { width: 108, height: 108 },
  letterRow: { flexDirection: 'row', alignItems: 'center' },
  letter: {
    color: '#F0F6FF',
    fontSize: 27,
    fontWeight: '800',
    letterSpacing: 1.5,
    textShadowOffset: { width: 0, height: 0 },
  },
  star: { position: 'absolute', backgroundColor: CYAN },
});
