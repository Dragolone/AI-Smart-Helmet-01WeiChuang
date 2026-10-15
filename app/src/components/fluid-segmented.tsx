// 分段控件（负责人 2026-10-15 画板口径）：一条圆角底槽，高亮是一颗会流动的滑块——换段时滑过去，
// 前沿先走、后沿晚 90 ms 跟上，中途被拉长再收回；不是这格灭、那格亮。
// 高亮的是 current（头盔确认过的值）；tentative（待确认）只描边不填色——点了之后要等回执，滑块才动，
// 没生效的值绝不显示成已生效（决策 #27③ / #45）。
// 滑块的位置按每一段量出来的布局走，不写死：各段等宽（设置档位）和各段按内容宽（记录页的筛选 chip）都能用。
// 系统开了「减弱动态效果」时滑块直接跳到位。
import { useEffect, useRef } from "react";
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { Tappable } from "@/components/tappable";

/** 滑块滑过去用多久；后沿比前沿晚多少 */
const SLIDE_MS = 340;
const TRAIL_MS = 90;
/** 字和描边的颜色过渡 */
const TINT_MS = 200;
/** 变成高亮的那一段，字晚一点再变深：等滑块盖过来，别在浅底上先出现深字 */
const TEXT_LAG_MS = 120;

export type SegmentOption<T> = { value: T; label: string };

export type SegmentPalette = {
  /** 滑块 */
  thumb: string;
  /** 滑块上的字 */
  activeText: string;
  text: string;
  /** 待确认那一段的字 */
  tentativeText: string;
  /** 待确认那一段的描边 */
  outline: string;
  /** 平时每一段的描边（筛选 chip 那种）；不给 = 透明 */
  border?: string;
};

type Rect = { x: number; y: number; w: number; h: number };

export function FluidSegmented<T extends string | number | boolean>({
  options,
  current,
  tentative = null,
  disabled = false,
  onSelect,
  palette,
  equal = true,
  style,
  segmentStyle,
  textStyle,
  thumbStyle,
  accessibilityLabel,
}: {
  options: readonly SegmentOption<T>[];
  /** 高亮的那一段；null = 没有高亮（还没上报过） */
  current: T | null;
  /** 待确认的那一段：描边、不填色 */
  tentative?: T | null;
  disabled?: boolean;
  onSelect: (value: T) => void;
  palette: SegmentPalette;
  /** true = 各段等宽铺满；false = 各段按内容宽 */
  equal?: boolean;
  /** 底槽（行方向、内边距、圆角、底色） */
  style?: StyleProp<ViewStyle>;
  /** 每一段（高度、圆角、描边宽、内边距） */
  segmentStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  /** 滑块（圆角要和每一段一致） */
  thumbStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const reduced = useReducedMotion();
  const idx = options.findIndex((o) => o.value === current);
  const rects = useRef<(Rect | undefined)[]>([]);
  const rootW = useRef(0);
  /** 滑块现在停在第几段；-1 = 还没放过 */
  const placed = useRef(-1);
  const left = useSharedValue(0);
  const right = useSharedValue(0);
  const top = useSharedValue(0);
  const height = useSharedValue(0);
  const shown = useSharedValue(0);

  /** 把滑块放到第 i 段：dir = 0 直接放，1 / -1 往右 / 往左滑过去 */
  const settle = (i: number, dir: 0 | 1 | -1) => {
    const r = rects.current[i];
    const w = rootW.current;
    if (!r || w <= 0) return;
    const l = r.x;
    const rr = w - (r.x + r.w);
    top.set(r.y);
    height.set(r.h);
    placed.current = i;
    if (dir === 0 || reduced) {
      left.set(l);
      right.set(rr);
      shown.set(1);
      return;
    }
    const cfg = { duration: SLIDE_MS, easing: Easing.bezier(0.3, 0.9, 0.3, 1) };
    if (dir > 0) {
      right.set(withTiming(rr, cfg));
      left.set(withDelay(TRAIL_MS, withTiming(l, cfg)));
    } else {
      left.set(withTiming(l, cfg));
      right.set(withDelay(TRAIL_MS, withTiming(rr, cfg)));
    }
    shown.set(withTiming(1, { duration: TINT_MS }));
  };

  // current 变了：从现在停的那一段滑到新的一段。第一次（还没放过）直接放；布局还没量到就等 onLayout 再放
  useEffect(() => {
    if (idx < 0) {
      if (placed.current >= 0) shown.set(withTiming(0, { duration: TINT_MS }));
      placed.current = -1;
      return;
    }
    if (idx === placed.current) return;
    settle(idx, placed.current < 0 ? 0 : idx > placed.current ? 1 : -1);
  });

  const thumbAnim = useAnimatedStyle(() => ({
    left: left.get(),
    right: right.get(),
    top: top.get(),
    height: height.get(),
    opacity: shown.get(),
  }));

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[styles.row, style, disabled && styles.disabled]}
      onLayout={(e: LayoutChangeEvent) => {
        rootW.current = e.nativeEvent.layout.width;
        if (idx >= 0 && placed.current !== idx) settle(idx, 0);
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.thumb,
          { backgroundColor: palette.thumb },
          thumbStyle,
          thumbAnim,
        ]}
      />
      {options.map((o, i) => (
        <Segment
          key={String(o.value)}
          label={o.label}
          active={i === idx}
          tentative={tentative !== null && o.value === tentative && i !== idx}
          disabled={disabled}
          equal={equal}
          palette={palette}
          style={segmentStyle}
          textStyle={textStyle}
          onPress={() => onSelect(o.value)}
          onLayout={(e: LayoutChangeEvent) => {
            const { x, y, width, height: h } = e.nativeEvent.layout;
            rects.current[i] = { x, y, w: width, h };
            if (i === idx && placed.current !== idx) settle(idx, 0);
          }}
        />
      ))}
    </View>
  );
}

function Segment({
  label,
  active,
  tentative,
  disabled,
  equal,
  palette,
  style,
  textStyle,
  onPress,
  onLayout,
}: {
  label: string;
  active: boolean;
  tentative: boolean;
  disabled: boolean;
  equal: boolean;
  palette: SegmentPalette;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  onPress: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
}) {
  const color = active
    ? palette.activeText
    : tentative
      ? palette.tentativeText
      : palette.text;
  // 平时有描边的（筛选 chip）：高亮那段的描边跟滑块同色，不然滑块上压着一圈灰边
  const border = active
    ? (palette.border !== undefined ? palette.thumb : "transparent")
    : tentative
      ? palette.outline
      : (palette.border ?? "transparent");
  const borderAnim = useAnimatedStyle(
    () => ({ borderColor: withTiming(border, { duration: TINT_MS }) }),
    [border],
  );
  const textAnim = useAnimatedStyle(
    () => ({
      color: withDelay(
        active ? TEXT_LAG_MS : 0,
        withTiming(color, { duration: TINT_MS }),
      ),
    }),
    [active, color],
  );
  return (
    <Tappable
      feedback="opacity"
      disabled={disabled}
      onPress={onPress}
      onLayout={onLayout}
      accessibilityRole="radio"
      accessibilityState={{ checked: active, disabled }}
      style={equal && styles.flex}
    >
      <Animated.View style={[styles.segment, style, borderAnim]}>
        <Animated.Text
          numberOfLines={1}
          style={[styles.text, textStyle, textAnim]}
        >
          {label}
        </Animated.Text>
      </Animated.View>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", position: "relative" },
  disabled: { opacity: 0.45 },
  flex: { flex: 1 },
  thumb: { position: "absolute" },
  segment: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  text: { fontSize: 13, fontWeight: "700" },
});
