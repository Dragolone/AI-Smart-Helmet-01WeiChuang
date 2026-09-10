// 蜂鸣音量滑杆：拖动时只改本地值，松手才下发（避免每个像素都发一条设置命令）。
// 不引原生 slider 库——View 的 responder 事件足够，且免去一次原生重建。
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import {
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";

import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";

const MIN = 10;
const MAX = 100;
const STEP = 5;
/** 超过这条线视为高音量（滑杆变红 + 松手要确认） */
export const VOLUME_LOUD_THRESHOLD = 90;
/** 推荐上限刻度（硬件给分贝上限后再调） */
const RECOMMENDED = 80;
const THUMB = 26;

function clampStep(v: number) {
  const stepped = Math.round(v / STEP) * STEP;
  return Math.min(MAX, Math.max(MIN, stepped));
}

export function VolumeSlider({
  value,
  disabled,
  onChangeEnd,
}: {
  value: number;
  disabled?: boolean;
  onChangeEnd: (v: number) => void;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const [dragValue, setDragValue] = useState<number | null>(null);
  // 只在手势回调里读写：松手时取最后一档下发
  const lastRef = useRef(value);

  const valueAt = (e: GestureResponderEvent) =>
    clampStep((e.nativeEvent.locationX / Math.max(1, width)) * MAX);
  const onGrant = (e: GestureResponderEvent) => {
    const v = valueAt(e);
    lastRef.current = v;
    setDragValue(v);
    Haptics.selectionAsync().catch(() => {});
  };
  const onMove = (e: GestureResponderEvent) => {
    const v = valueAt(e);
    if (v !== lastRef.current) {
      lastRef.current = v;
      setDragValue(v);
      Haptics.selectionAsync().catch(() => {});
    }
  };
  const onRelease = () => {
    setDragValue(null);
    onChangeEnd(lastRef.current);
  };

  const shown = dragValue ?? clampStep(value);
  const loud = shown > VOLUME_LOUD_THRESHOLD;
  const fillColor = loud ? theme.sos : theme.brand;
  const ratio = shown / MAX;

  return (
    <View style={styles.wrap}>
      <View style={styles.labelRow}>
        <ThemedText type="small" themeColor="textSecondary">
          蜂鸣音量
        </ThemedText>
        <ThemedText
          type="smallBold"
          style={{ color: loud ? theme.sos : theme.text }}
        >
          {shown}%{loud ? " · 高音量" : ""}
        </ThemedText>
      </View>
      <View
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        onResponderGrant={onGrant}
        onResponderMove={onMove}
        onResponderRelease={onRelease}
        onResponderTerminate={() => setDragValue(null)}
        onLayout={(e: LayoutChangeEvent) =>
          setWidth(e.nativeEvent.layout.width)
        }
        style={[styles.trackHit, disabled && { opacity: 0.5 }]}
      >
        <View
          style={[styles.track, { backgroundColor: theme.backgroundSelected }]}
        >
          <View
            style={[
              styles.fill,
              { width: `${ratio * 100}%`, backgroundColor: fillColor },
            ]}
          />
          {/* 推荐上限刻度 */}
          <View
            style={[
              styles.tick,
              {
                left: `${(RECOMMENDED / MAX) * 100}%`,
                backgroundColor: theme.textSecondary,
              },
            ]}
          />
        </View>
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            {
              left: Math.max(0, ratio * width - THUMB / 2),
              backgroundColor: theme.backgroundElement,
              borderColor: fillColor,
            },
          ]}
        />
      </View>
      <View style={styles.labelRow}>
        <ThemedText type="label" themeColor="textSecondary">
          {MIN}%
        </ThemedText>
        <ThemedText type="label" themeColor="textSecondary">
          建议 ≤ {RECOMMENDED}%
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
  trackHit: { height: THUMB + 8, justifyContent: "center" },
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
