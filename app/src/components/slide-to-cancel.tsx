// 求救倒计时页的「滑动取消」：把圆钮从左拖到右才算数，比点一下更不容易在口袋里误碰。
// - 拖过全程的 70% 松手 = 取消；没到就弹回去。
// - 用不了滑动的人（读屏）：双击这个按钮直接取消，不要求做拖动手势。
// - 取消请求在路上（本页发的，或锁屏通知按钮发的）：圆钮停在右端，文字换成「取消中…」，不能再拖；
//   请求失败、这一单还在倒数时，圆钮回到左端可以重来。
// 触觉按设计规范：按下、没到位松手是「轻」，滑到位是「成功」。
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { ThemedText } from "@/components/themed-text";

const HEIGHT = 72;
const THUMB = 64;
const INSET = 3;
/** 拖过全程的这个比例就算取消 */
const COMMIT = 0.7;
const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);

export interface SlideColors {
  track: string;
  trackBorder: string;
  /** 圆钮划过的那一段 */
  fill: string;
  thumb: string;
  thumbIcon: string;
  text: string;
  hint: string;
}

const light = () =>
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
    () => undefined,
  );
const success = () =>
  void Haptics.notificationAsync(
    Haptics.NotificationFeedbackType.Success,
  ).catch(() => undefined);

export function SlideToCancel({
  label,
  busyLabel,
  a11yLabel,
  a11yHint,
  busy,
  disabled,
  colors,
  onCancel,
}: {
  label: string;
  busyLabel: string;
  a11yLabel: string;
  a11yHint: string;
  /** 取消请求在路上 */
  busy: boolean;
  /** 别的操作在路上（立即求救），这会儿不能取消 */
  disabled: boolean;
  colors: SlideColors;
  onCancel: () => void;
}) {
  const [width, setWidth] = useState(0);
  // 轨道有 1 的描边，圆钮四周各留 3
  const travel = Math.max(0, width - 2 - THUMB - INSET * 2);
  const x = useSharedValue(0);
  const max = useSharedValue(0);
  useEffect(() => {
    max.set(travel);
  }, [travel, max]);

  // 圆钮跟着「取消在不在路上」走：在路上停在右端；回到不在路上（请求失败）回左端
  useEffect(() => {
    x.set(withTiming(busy ? travel : 0, { duration: 220, easing: EASE }));
  }, [busy, travel, x]);

  // 箭头只变明暗、不左右晃：Android 上一直在变的 transform 会不停发「内容变了」的无障碍事件
  const pulse = useSharedValue(0.45);
  const idle = !busy && !disabled;
  useEffect(() => {
    if (!idle) {
      pulse.set(0.45);
      return;
    }
    pulse.set(
      withRepeat(
        withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        -1,
        true,
      ),
    );
    return () => cancelAnimation(pulse);
  }, [idle, pulse]);

  const pan = Gesture.Pan()
    .enabled(idle && travel > 0)
    .minDistance(2)
    .onBegin(() => {
      scheduleOnRN(light);
    })
    .onUpdate((e) => {
      x.set(Math.max(0, Math.min(max.get(), e.translationX)));
    })
    .onFinalize((_e, moved) => {
      if (!moved) {
        // 只点了一下没拖：圆钮往右探一下再回来，提示「要滑过去」
        x.set(
          withSequence(
            withTiming(18, { duration: 120, easing: EASE }),
            withTiming(0, { duration: 200, easing: EASE }),
          ),
        );
        return;
      }
      if (x.get() >= max.get() * COMMIT) {
        x.set(withTiming(max.get(), { duration: 160, easing: EASE }));
        scheduleOnRN(success);
        scheduleOnRN(onCancel);
      } else {
        x.set(withTiming(0, { duration: 220, easing: EASE }));
        scheduleOnRN(light);
      }
    });

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }],
  }));
  const fillStyle = useAnimatedStyle(() => ({
    width: x.get() > 0 ? x.get() + THUMB + INSET : 0,
  }));
  const labelStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, 1 - x.get() / 120),
  }));
  const hintStyle = useAnimatedStyle(() => ({ opacity: pulse.get() }));

  return (
    <View
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      style={[
        styles.track,
        {
          backgroundColor: colors.track,
          borderColor: colors.trackBorder,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Animated.View
        style={[styles.fill, { backgroundColor: colors.fill }, fillStyle]}
      />
      {busy ? (
        <View pointerEvents="none" style={styles.label}>
          <ThemedText
            maxFontSizeMultiplier={2}
            style={[styles.labelText, { color: colors.text }]}
          >
            {busyLabel}
          </ThemedText>
        </View>
      ) : (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.label, styles.labelIdle, labelStyle]}
        >
          <ThemedText
            numberOfLines={1}
            adjustsFontSizeToFit
            // 不封顶时行高一超过轨道高，adjustsFontSizeToFit 会把字压到 4 pt 左右
            maxFontSizeMultiplier={2}
            style={[styles.labelText, { color: colors.text }]}
          >
            {label}
          </ThemedText>
          <Animated.View style={hintStyle}>
            <Ionicons name="chevron-forward" size={20} color={colors.hint} />
          </Animated.View>
        </Animated.View>
      )}
      <GestureDetector gesture={pan}>
        <Animated.View
          accessible
          accessibilityRole="button"
          accessibilityLabel={busy ? busyLabel : a11yLabel}
          accessibilityHint={busy ? undefined : a11yHint}
          accessibilityState={{ disabled: !idle, busy }}
          // 不写 label 时 iOS 读屏会把动作名念成英文 activate
          accessibilityActions={[{ name: "activate", label: a11yLabel }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === "activate" && idle) onCancel();
          }}
          // iOS 读屏双击只走这个：不写的话系统改发一次点按，落到上面的 Pan 手势是「没拖」，取消不了。
          // 安卓读屏双击走上面的 activate，安卓不派发这个事件，不会取消两次
          onAccessibilityTap={() => {
            if (idle) onCancel();
          }}
          style={[styles.thumb, { backgroundColor: colors.thumb }, thumbStyle]}
        >
          <Ionicons name="arrow-forward" size={26} color={colors.thumbIcon} />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: HEIGHT,
    borderRadius: HEIGHT / 2,
    borderWidth: 1,
    overflow: "hidden",
    justifyContent: "center",
  },
  fill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: HEIGHT / 2,
  },
  label: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  // 文字让开左端的圆钮：要让开整颗（INSET + THUMB），只让开 THUMB - 8 时字一长（系统字体放大）开头就被圆钮盖住（2026-10-15 边界测试）
  labelIdle: { paddingLeft: INSET + THUMB + 6, paddingRight: 16 },
  labelText: { fontSize: 17, lineHeight: 24, fontWeight: 700, flexShrink: 1 },
  thumb: {
    position: "absolute",
    left: INSET,
    top: INSET,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
