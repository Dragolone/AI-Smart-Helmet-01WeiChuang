// 蜂鸣音量滑杆。手感优先：拖动全程在 UI 线程（gesture-handler + reanimated），
// 不经过 JS 重渲染；JS 侧只在跨过 5% 档位时收到一次回调（震动 + 节流下发）。
import { Ionicons } from "@expo/vector-icons";
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

/** 拖动时的档位：5% 一档、10–100（滑杆能调出来的值） */
export function clampVolume(v: number) {
  "worklet";
  const stepped = Math.round(v / STEP) * STEP;
  return Math.min(MAX, Math.max(MIN, stepped));
}

/** 设置清单里音量的取值范围（shared DEVICE_SETTINGS.volume：1–100） */
export const VOLUME_SETTING_MIN = 1;
export const VOLUME_SETTING_MAX = 100;

/**
 * 没在拖动时显示的值：头盔上实际是多少就显示多少（取整、夹到 1–100）。
 * 原来静止时也过一遍拖动档位 clampVolume——头盔是 1–9 的小音量（设置清单允许，别的端或工程模式能设）
 * 显示成 10%，83 显示成 85%、82 显示成 80%（82 本来超过推荐线，却不标「高音量」）。
 * 认不出的值（NaN）原样交回，和以前一样。
 */
export function restingVolume(v: number) {
  "worklet";
  if (Number.isNaN(v)) return v;
  return Math.min(
    VOLUME_SETTING_MAX,
    Math.max(VOLUME_SETTING_MIN, Math.round(v)),
  );
}

export function VolumeSlider({
  value,
  pending = false,
  unconfirmed = false,
  onStep,
  onRelease,
  onDraggingChange,
  icon,
}: {
  /** 展示值(调用方可传乐观值:滑到哪停在哪);拖动中忽略 */
  value: number;
  /** 响应中:灰显 + 禁操作,回执生效后由调用方清除(负责人口径) */
  pending?: boolean;
  /** 头盔没确认过音量（没上报过 / 设置还没拿到）：value 是出厂默认，数字和填充用次要色，照常可拖 */
  unconfirmed?: boolean;
  /** 拖动中每跨过一档触发（调用方负责节流下发） */
  onStep?: (v: number) => void;
  /** 松手时的最终值 */
  onRelease: (v: number) => void;
  /** 拖动开始/结束（调用方用来暂时关掉返回手势） */
  onDraggingChange?: (dragging: boolean) => void;
  /** 标题前的图标（设备详情首页的常用控制带） */
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const theme = useTheme();
  const t = useT();
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragShown, setDragShown] = useState(value);

  const progress = useSharedValue(restingVolume(value) / MAX);
  const lastStep = useSharedValue(restingVolume(value));
  const widthSv = useSharedValue(0);
  const startX = useSharedValue(0);
  /** 拖动真的开始了（onStart 来过）：收尾时据此决定要不要复位 */
  const active = useSharedValue(false);

  // 云端值变化且没在拖动时，把滑杆同步到已生效值（在 UI 线程写 shared value，不走 useEffect）
  const syncTarget = dragging ? -1 : restingVolume(value);
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
    // 从此刻的值开始显示：不然没跨档之前，标签上是上一次拖动停下的值
    setDragShown(restingVolume(value));
    setDragging(true);
    onDraggingChange?.(true);
  };
  const end = (v: number) => {
    setDragging(false);
    onDraggingChange?.(false);
    onRelease(v);
  };
  // 拖到一半被打断（来电、下拉通知中心、别的手势抢走）：不交出结果，回到头盔确认过的值。
  // 拖动中的状态一定要收回来，不然滑杆不再跟着云端值走、iOS 返回手势一直关着
  const cancel = () => {
    setDragging(false);
    onDraggingChange?.(false);
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
      active.set(true);
      scheduleOnRN(begin);
      applyX(e.x);
    })
    .onUpdate((e) => {
      applyX(e.x);
    })
    .onFinalize((_e, success) => {
      // 没激活过（被上下滚动抢走）：什么都没开始，不用收尾
      if (!active.get()) return;
      active.set(false);
      if (!success) {
        scheduleOnRN(cancel);
        return;
      }
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

  const shown = dragging ? dragShown : restingVolume(value);
  const loud = shown > VOLUME_LOUD_THRESHOLD;
  // 拖动中显示的是手指下的值，不再是「待确认的默认值」
  const dim = pending || (unconfirmed && !dragging);
  const fillColor = dim
    ? theme.textSecondary
    : loud
      ? theme.sos
      : theme.brand;

  return (
    <View style={styles.wrap}>
      <View style={styles.labelRow}>
        <View style={styles.title}>
          {icon && (
            <Ionicons name={icon} size={18} color={theme.textSecondary} />
          )}
          <ThemedText type="small" style={styles.titleText}>
            {t("device.volume")}
          </ThemedText>
        </View>
        <ThemedText
          type="smallBold"
          style={{
            color: dim ? theme.textSecondary : loud ? theme.sos : theme.text,
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
  title: { flexDirection: "row", alignItems: "center", gap: 8 },
  titleText: { fontSize: 15 },
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
