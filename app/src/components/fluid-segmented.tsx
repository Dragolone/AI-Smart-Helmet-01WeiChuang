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
  tentativeHint,
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
  /** 读屏念给「待确认」那一段的说明（等待头盔确认之类）；不给就不念 */
  tentativeHint?: string;
}) {
  const reduced = useReducedMotion();
  const idx = options.findIndex((o) => o.value === current);
  // 每一段量到的位置按选项的值记：选项增删（解绑一顶头盔、改名）后下标会挪，按下标记会拿错格子
  const rects = useRef(new Map<string, Rect>());
  const rootW = useRef(0);
  /** 滑块现在停在哪一段（选项的值）；null = 还没放过 */
  const placed = useRef<string | null>(null);
  /** 滑块现在对着的那块矩形：同一段的大小 / 位置变了（字号、换行、改名）要跟着挪 */
  const placedRect = useRef<Rect | null>(null);
  const left = useSharedValue(0);
  const right = useSharedValue(0);
  const top = useSharedValue(0);
  const height = useSharedValue(0);
  const shown = useSharedValue(0);

  /** 把滑块放到第 i 段：dir = 0 直接放，1 / -1 往右 / 往左滑过去 */
  const settle = (i: number, dir: 0 | 1 | -1) => {
    const key = String(options[i].value);
    const r = rects.current.get(key);
    const w = rootW.current;
    if (!r || w <= 0) return;
    const l = r.x;
    const rr = w - (r.x + r.w);
    top.set(r.y);
    height.set(r.h);
    placed.current = key;
    placedRect.current = r;
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

  // current 变了：从现在停的那一段滑到新的一段。第一次（还没放过）、或原来那段已经不在了，直接放；
  // 布局还没量到就等 onLayout 再放
  useEffect(() => {
    if (idx < 0) {
      if (placed.current !== null)
        shown.set(withTiming(0, { duration: TINT_MS }));
      placed.current = null;
      placedRect.current = null;
      return;
    }
    if (String(options[idx].value) === placed.current) return;
    const from =
      placed.current === null
        ? -1
        : options.findIndex((o) => String(o.value) === placed.current);
    settle(idx, from < 0 ? 0 : idx > from ? 1 : -1);
  });

  /** 布局变了（这一段或整条的大小、位置）：滑块直接对到当前那一段的新位置 */
  const realign = () => {
    if (idx < 0) return;
    const key = String(options[idx].value);
    const r = rects.current.get(key);
    const was = placedRect.current;
    if (
      placed.current !== key ||
      !r ||
      !was ||
      r.x !== was.x ||
      r.y !== was.y ||
      r.w !== was.w ||
      r.h !== was.h
    )
      settle(idx, 0);
  };

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
      // 不可点时整条变淡一次就够：每一段不再各自变淡（叠起来只剩 0.2，选中那段的字比滑块还淡）
      style={[styles.row, style, disabled && styles.disabled]}
      onLayout={(e: LayoutChangeEvent) => {
        const w = e.nativeEvent.layout.width;
        if (w === rootW.current && placed.current !== null) return;
        rootW.current = w;
        // 整条宽度变了，右边距跟着变：当前那一段要重新对
        placedRect.current = null;
        realign();
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
          tentativeHint={tentativeHint}
          disabled={disabled}
          equal={equal}
          palette={palette}
          style={segmentStyle}
          textStyle={textStyle}
          onPress={() => onSelect(o.value)}
          onLayout={(e: LayoutChangeEvent) => {
            const { x, y, width, height: h } = e.nativeEvent.layout;
            rects.current.set(String(o.value), { x, y, w: width, h });
            if (i === idx) realign();
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
  tentativeHint,
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
  tentativeHint?: string;
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
      // 不可点由外层整条变淡来表示（见 FluidSegmented），这里不再交给 Tappable 的 disabled 再淡一次
      feedback={disabled ? [] : "opacity"}
      onPress={disabled ? undefined : onPress}
      onLayout={onLayout}
      accessibilityRole="radio"
      accessibilityState={{ checked: active, disabled }}
      accessibilityHint={tentative ? tentativeHint : undefined}
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
