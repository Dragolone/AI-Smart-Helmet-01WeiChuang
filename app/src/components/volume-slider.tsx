// 蜂鸣音量滑杆。手感优先：拖动全程在 UI 线程（gesture-handler + reanimated），
// 不经过 JS 重渲染；JS 侧只在跨过 5% 档位时收到一次回调（震动 + 节流下发）。
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

const MIN = 10;
const MAX = 100;
const STEP = 5;
/** 推荐上限刻度（硬件给分贝上限后再调） */
export const VOLUME_RECOMMENDED = 80;
/** 超过推荐线即视为高音量（滑杆变红 + 松手要确认)——与刻度提示一致,
 *  此前 90 与推荐线 80 两套阈值不一致(85 不提醒),负责人 2026-09-11 指正 */
export const VOLUME_LOUD_THRESHOLD = VOLUME_RECOMMENDED;
const THUMB = 28;

export function clampVolume(v: number) {
  "worklet";
  const stepped = Math.round(v / STEP) * STEP;
  return Math.min(MAX, Math.max(MIN, stepped));
}

export function VolumeSlider({
  value,
  pending = false,
  onStep,
  onRelease,
  onDraggingChange,
}: {
  /** 展示值(调用方可传乐观值:滑到哪停在哪);拖动中忽略 */
  value: number;
  /** 响应中:灰显 + 禁操作,回执生效后由调用方清除(负责人口径) */
  pending?: boolean;
  /** 拖动中每跨过一档触发（调用方负责节流下发） */
  onStep?: (v: number) => void;
  /** 松手时的最终值 */
  onRelease: (v: number) => void;
  /** 拖动开始/结束（调用方用来暂时关掉返回手势） */
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const theme = useTheme();
  const t = useT();
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragShown, setDragShown] = useState(value);

  const progress = useSharedValue(clampVolume(value) / MAX);
  const lastStep = useSharedValue(clampVolume(value));
  const widthSv = useSharedValue(0);
  const startX = useSharedValue(0);

  // 云端值变化且没在拖动时，把滑杆同步到已生效值（在 UI 线程写 shared value，不走 useEffect）
  const syncTarget = dragging ? -1 : clampVolume(value);
  useAnimatedReaction(
    () => syncTarget,
    (target) => {
      if (target >= 0) {
        progress.set(target / MAX);
        lastStep.set(target);
      }
    },
    [syncTarget],
  );
  useAnimatedReaction(
    () => width,
    (w) => {
      widthSv.set(w);
    },
    [width],
  );

  const stepChanged = (v: number) => {
    setDragShown(v);
    Haptics.selectionAsync().catch(() => {});
    onStep?.(v);
  };
  const begin = () => {
    setDragging(true);
    onDraggingChange?.(true);
  };
  const end = (v: number) => {
    setDragging(false);
    onDraggingChange?.(false);
    onRelease(v);
  };

  const applyX = (x: number) => {
    "worklet";
    const w = Math.max(1, widthSv.get());
    const raw = Math.min(1, Math.max(0, x / w));
    progress.set(raw);
    const v = clampVolume(raw * MAX);
    if (v !== lastStep.get()) {
      lastStep.set(v);
      scheduleOnRN(stepChanged, v);
    }
  };

  // 横向 4px 即激活、纵向 10px 即失败：不抢 ScrollView 的上下滚动
  const pan = Gesture.Pan()
    .enabled(!pending)
    .activeOffsetX([-4, 4])
    .failOffsetY([-10, 10])
    .onBegin((e) => {
      startX.set(e.x);
    })
    .onStart((e) => {
      scheduleOnRN(begin);
      applyX(e.x);
    })
    .onUpdate((e) => {
      applyX(e.x);
    })
    .onFinalize((_e, success) => {
      if (!success) return;
      progress.set(lastStep.get() / MAX);
      scheduleOnRN(end, lastStep.get());
    });
  const tap = Gesture.Tap()
    .enabled(!pending)
    .onEnd((e) => {
    scheduleOnRN(begin);
    applyX(e.x);
    progress.set(lastStep.get() / MAX);
    scheduleOnRN(end, lastStep.get());
  });
  const gesture = Gesture.Exclusive(pan, tap);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${progress.get() * 100}%`,
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: progress.get() * widthSv.get() - THUMB / 2 },
      { scale: dragging ? 1.15 : 1 },
    ],
  }));

  const shown = dragging ? dragShown : clampVolume(value);
  const loud = shown > VOLUME_LOUD_THRESHOLD;
  const fillColor = pending
    ? theme.textSecondary
    : loud
      ? theme.sos
      : theme.brand;

  return (
    <View style={styles.wrap}>
      <View style={styles.labelRow}>
        <ThemedText type="small" themeColor="textSecondary">
          {t("device.volume")}
        </ThemedText>
        <ThemedText
          type="smallBold"
          style={{
            color: pending ? theme.textSecondary : loud ? theme.sos : theme.text,
          }}
        >
          {shown}%
          {pending
            ? ` · ${t("device.applying")}`
            : loud
              ? ` · ${t("device.volumeLoud")}`
              : ""}
        </ThemedText>
      </View>
      <GestureDetector gesture={gesture}>
        <View
          onLayout={(e: LayoutChangeEvent) =>
            setWidth(e.nativeEvent.layout.width)
          }
          style={styles.trackHit}
        >
          <View
            style={[
              styles.track,
              { backgroundColor: theme.backgroundSelected },
            ]}
          >
            <Animated.View
              style={[styles.fill, fillStyle, { backgroundColor: fillColor }]}
            />
            <View
              style={[
                styles.tick,
                {
                  left: `${(VOLUME_RECOMMENDED / MAX) * 100}%`,
                  backgroundColor: theme.textSecondary,
                },
              ]}
            />
          </View>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.thumb,
              thumbStyle,
              {
                backgroundColor: theme.backgroundElement,
                borderColor: fillColor,
              },
            ]}
          />
        </View>
      </GestureDetector>
      <View style={styles.labelRow}>
        <ThemedText type="label" themeColor="textSecondary">
          {MIN}%
        </ThemedText>
        <ThemedText type="label" themeColor="textSecondary">
          {t("device.volumeRecommended", { n: VOLUME_RECOMMENDED })}
        </ThemedText>
        <ThemedText type="label" themeColor="textSecondary">
          {MAX}%
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  trackHit: { height: THUMB + 12, justifyContent: "center" },
  track: { height: 8, borderRadius: 4 },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 4 },
  tick: {
    position: "absolute",
    top: -3,
    width: 2,
    height: 14,
    borderRadius: 1,
    opacity: 0.6,
  },
  thumb: {
    position: "absolute",
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 3,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
});
