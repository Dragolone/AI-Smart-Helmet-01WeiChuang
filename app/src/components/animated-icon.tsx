// 开屏动画(品牌版):与原生启动图(暗底+荧光环+头盔)无缝衔接——
// 静帧一致 → 荧光弧环旋转 + 头盔呼吸 + 波纹扩散 → 整体淡出。
// 参考 uiverse 环形加载动效的节奏,视觉全部按本项目暗色/荧光语言重绘。
import * as SplashScreen from 'expo-splash-screen';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const BG = '#0E0F12';
const BRAND = '#D4FF00';
const TOTAL = 1400;

/** 整层:停留后淡出并轻微放大(镜头推进感) */
const overlayKeyframe = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  72: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 1.06 }], easing: Easing.out(Easing.quad) },
});

/** 荧光弧:三圈快转(borderTop 留色即成弧) */
const arcKeyframe = new Keyframe({
  0: { transform: [{ rotateZ: '0deg' }] },
  100: { transform: [{ rotateZ: '1080deg' }], easing: Easing.out(Easing.cubic) },
});

/** 字标:弹性落位 + 微呼吸 */
const markKeyframe = new Keyframe({
  0: { transform: [{ scale: 1.12 }], opacity: 0.6 },
  45: { transform: [{ scale: 0.98 }], opacity: 1, easing: Easing.out(Easing.quad) },
  70: { transform: [{ scale: 1.02 }], easing: Easing.inOut(Easing.quad) },
  100: { transform: [{ scale: 1 }], easing: Easing.inOut(Easing.quad) },
});

/** 波纹:一圈荧光环向外扩散消失 */
const rippleKeyframe = new Keyframe({
  0: { transform: [{ scale: 1 }], opacity: 0 },
  35: { transform: [{ scale: 1 }], opacity: 0.55 },
  100: { transform: [{ scale: 1.7 }], opacity: 0, easing: Easing.out(Easing.quad) },
});

export function AnimatedSplashOverlay() {
  const [animate, setAnimate] = useState(false);
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  const mark = (
    <View style={styles.markRow}>
      <Text style={styles.markText}>AI</Text>
      <View style={styles.markDot} />
    </View>
  );

  return animate ? (
    <Animated.View
      entering={overlayKeyframe.duration(TOTAL).withCallback((finished) => {
        'worklet';
        if (finished) scheduleOnRN(setVisible, false);
      })}
      style={styles.overlay}>
      <Animated.View entering={rippleKeyframe.duration(TOTAL * 0.8)} style={styles.ripple} />
      <Animated.View entering={arcKeyframe.duration(TOTAL)} style={styles.arc} />
      <View style={styles.ring} />
      <Animated.View entering={markKeyframe.duration(TOTAL * 0.8)}>
        <View style={styles.markRow}>
          <Text style={styles.markText}>AI</Text>
          <View style={styles.markDot} />
        </View>
      </Animated.View>
    </Animated.View>
  ) : (
    // 首帧静态复刻原生启动图,onLayout 后隐藏原生层再起动画——避免闪变
    <View
      onLayout={() => {
        SplashScreen.hideAsync().finally(() => setAnimate(true));
      }}
      style={styles.overlay}>
      <View style={styles.ring} />
      {mark}
    </View>
  );
}

const RING = 232;
const ARC = 260;

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: BG,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  ring: {
    position: 'absolute',
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 3,
    borderColor: BRAND,
    opacity: 0.9,
  },
  arc: {
    position: 'absolute',
    width: ARC,
    height: ARC,
    borderRadius: ARC / 2,
    borderWidth: 3,
    borderColor: 'transparent',
    borderTopColor: BRAND,
    opacity: 0.8,
  },
  ripple: {
    position: 'absolute',
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 2,
    borderColor: BRAND,
  },
  markRow: { flexDirection: 'row', alignItems: 'flex-start' },
  markText: {
    color: '#F5F6F8',
    fontSize: 76,
    fontWeight: '800',
    letterSpacing: 2,
    lineHeight: 84,
  },
  markDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: BRAND,
    marginTop: 10,
    marginLeft: 8,
  },
});
