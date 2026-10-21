// 设备页头盔大图外圈的 270° 电量环（无 SVG 依赖），缺口朝下。
// 圆形 View 的四条边框各是一段 90° 的弧，以 45° 斜线为界；同一个 View 上相邻两条边同色时是连着的。
// - 底环：上 / 左 / 右三条边上色、下边透明，正好是缺口朝下的 270°。
// - 进度：把坐标系逆时针转 135°，让弧的起点落在正上方，再分三层叠起来画——
//   ① 走满的整段（每段 90°）：同一个圆上依次给三条边上色，段与段之间没有接缝；
//   ② 第一段还没走满时：一段 90° 的弧从起点之前转进来，起点之前的部分用裁剪盒挡掉；
//   ③ 之后：一段 90° 的弧，前沿跟着进度走，后半截压在①已经上色的整段上面。
//   各层是叠着而不是对接的，所以不会在 90° / 180° 处露缝。
// - 两头的圆角是小圆点：起点固定，终点跟着进度转。
// - 刻度：每 10° 一根。
// 安卓 8.x 的旧绘制管线画不对这套边框（legacy-renderer），在那上面弧改用 Skia 画，刻度照旧。
import type { ReactNode } from "react";
import { useEffect } from "react";
import { PixelRatio, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { LEGACY_ANDROID_RENDERER } from "@/components/legacy-renderer";
import { SkiaArc } from "@/components/skia-arc";
import { arcSegment } from "@/services/device-home";

/** 设计稿画在 240 的画布上：环半径 104、线宽 6；刻度在半径 114 处，长 5、宽 1.6 */
const VIEWBOX = 240;
const RING_R = 104;
const RING_W = 6;
const TICK_R = 114;
const TICK_LEN = 5;
const TICK_W = 1.6;
const SWEEP = 270;

const TICK_ANGLES = Array.from(
  { length: SWEEP / 10 + 1 },
  (_, i) => -SWEEP / 2 + i * 10,
);

type BatteryArcProps = {
  size: number;
  /** 0–100；null = 没有电量数据，只画底环 */
  value: number | null;
  color: string;
  /** 底环颜色，须为实色（端头的圆点与环重叠） */
  track: string;
  tick: string;
  /** 进度弧变淡：没连上时显示的是上次电量 */
  dimmed?: boolean;
  children?: ReactNode;
};

export function BatteryArc({
  value,
  color,
  dimmed = false,
  ...rest
}: BatteryArcProps) {
  const p = useSharedValue(0);
  useEffect(() => {
    const v = value === null ? 0 : Math.max(0, Math.min(100, value)) / 100;
    p.set(withTiming(v, { duration: 700, easing: Easing.out(Easing.cubic) }));
  }, [value, p]);
  // 颜色（连上 / 断开、电量跨档）和淡化都是过渡的，不硬切（负责人 2026-10-15 画板口径）
  const stroke = useSharedValue(color);
  useEffect(() => {
    stroke.set(withTiming(color, { duration: 240 }));
  }, [color, stroke]);
  const dim = useSharedValue(dimmed ? 0.45 : 1);
  useEffect(() => {
    dim.set(withTiming(dimmed ? 0.45 : 1, { duration: 240 }));
  }, [dimmed, dim]);
  const anim = { p, stroke, dim, dimmed };
  return LEGACY_ANDROID_RENDERER ? (
    <BatteryArcSkia {...rest} {...anim} />
  ) : (
    <BatteryArcViews {...rest} {...anim} />
  );
}

type ArcBodyProps = Omit<BatteryArcProps, "value" | "color" | "dimmed"> & {
  p: SharedValue<number>;
  stroke: SharedValue<string>;
  dim: SharedValue<number>;
  dimmed: boolean;
};

/** 每 10° 一根刻度（两种画法共用：旋转的细长方块，旧管线也画得对） */
function Ticks({ size, tick }: { size: number; tick: string }) {
  const snap = PixelRatio.roundToNearestPixel;
  const k = size / VIEWBOX;
  const half = snap(size / 2);
  const box = half * 2;
  const tickW = Math.max(snap(TICK_W * k), 1 / PixelRatio.get());
  return TICK_ANGLES.map((deg) => (
    <View
      key={deg}
      pointerEvents="none"
      style={[
        styles.abs,
        {
          left: half - tickW / 2,
          top: 0,
          width: tickW,
          height: box,
          transform: [{ rotate: `${deg}deg` }],
        },
      ]}
    >
      <View
        style={{
          marginTop: half - (TICK_R + TICK_LEN / 2) * k,
          width: tickW,
          height: TICK_LEN * k,
          backgroundColor: tick,
        }}
      />
    </View>
  ));
}

/** 安卓 8.x：同样尺寸的 270° 底环 + 进度弧，起点在左下（缺口朝下） */
function BatteryArcSkia({
  size,
  track,
  tick,
  children,
  p,
  stroke,
  dim,
}: ArcBodyProps) {
  const snap = PixelRatio.roundToNearestPixel;
  const k = size / VIEWBOX;
  const box = snap(size / 2) * 2;
  const w = snap((RING_W * k) / 2) * 2;
  return (
    <View style={{ width: box, height: box }}>
      <Ticks size={size} tick={tick} />
      <SkiaArc
        box={box}
        r={RING_R * k}
        w={w}
        startDeg={90 + (360 - SWEEP) / 2}
        sweepDeg={SWEEP}
        track={track}
        color={stroke}
        progress={p}
        opacity={dim}
      />
      {children}
    </View>
  );
}

function BatteryArcViews({
  size,
  track,
  tick,
  children,
  p,
  stroke,
  dim,
  dimmed,
}: ArcBodyProps) {
  // 尺寸全部落在整像素上：几层弧是各自排版的，带小数时各取各的整，叠在一起会错开一像素
  const snap = PixelRatio.roundToNearestPixel;
  const k = size / VIEWBOX;
  const half = snap(size / 2);
  const box = half * 2;
  const w = snap((RING_W * k) / 2) * 2;
  const outer = snap(RING_R * k + w / 2);
  const off = half - outer;
  const r = outer - w / 2;
  const ring = {
    width: outer * 2,
    height: outer * 2,
    borderRadius: outer,
    borderWidth: w,
    borderColor: "transparent",
  };
  const dot = { width: w, height: w, borderRadius: w / 2 };
  // 底环两头在 ±135°（自正上方起顺时针）
  const capX = r * Math.SQRT1_2;

  const visible = useAnimatedStyle(() => ({
    opacity: p.get() > 0 ? dim.get() : 0,
  }));
  const full = useAnimatedStyle(() => {
    const v = p.get();
    const c = stroke.get();
    return {
      borderTopColor: arcSegment(v, 0) >= 1 ? c : "transparent",
      borderRightColor: arcSegment(v, 1) >= 1 ? c : "transparent",
      borderBottomColor: arcSegment(v, 2) >= 1 ? c : "transparent",
    };
  });
  // 起始角退 0.5°：进度很小时这段弧整个在裁剪盒外，边缘不会漏出一条细线
  const first = useAnimatedStyle(() => {
    const a = arcSegment(p.get(), 0);
    return {
      opacity: a < 1 ? 1 : 0,
      borderTopColor: stroke.get(),
      transform: [{ rotate: `${-45.5 + 90.5 * a}deg` }],
    };
  });
  const rest = useAnimatedStyle(() => {
    const deg = p.get() * SWEEP;
    return {
      opacity: deg > 90 ? 1 : 0,
      borderTopColor: stroke.get(),
      transform: [{ rotate: `${deg - 45}deg` }],
    };
  });
  const end = useAnimatedStyle(() => ({
    transform: [{ rotate: `${p.get() * SWEEP}deg` }],
  }));
  const capStyle = useAnimatedStyle(() => ({
    backgroundColor: stroke.get(),
  }));

  return (
    <View style={{ width: box, height: box }}>
      <Ticks size={size} tick={tick} />

      <View
        pointerEvents="none"
        style={[
          styles.abs,
          ring,
          {
            left: off,
            top: off,
            borderTopColor: track,
            borderLeftColor: track,
            borderRightColor: track,
          },
        ]}
      />
      {[-1, 1].map((side) => (
        <View
          key={side}
          pointerEvents="none"
          style={[
            styles.abs,
            dot,
            {
              left: half + side * capX - w / 2,
              top: half + capX - w / 2,
              backgroundColor: track,
            },
          ]}
        />
      ))}

      <Animated.View
        pointerEvents="none"
        // 淡化要整组一起算：几层弧各自半透明的话，叠着的地方会更深
        needsOffscreenAlphaCompositing={dimmed}
        style={[styles.abs, styles.frame, { width: box, height: box }, visible]}
      >
        <Animated.View
          style={[
            styles.abs,
            styles.quarters,
            ring,
            { left: off, top: off },
            full,
          ]}
        />
        <View
          style={[
            styles.clip,
            { left: half, top: 0, width: half, height: half },
          ]}
        >
          <Animated.View
            style={[styles.abs, ring, { left: off - half, top: off }, first]}
          />
        </View>
        <Animated.View
          style={[styles.abs, ring, { left: off, top: off }, rest]}
        />
        <Animated.View
          style={[styles.abs, dot, { left: half - w / 2, top: off }, capStyle]}
        />
        <Animated.View
          style={[
            styles.abs,
            { left: 0, top: 0, width: box, height: box },
            end,
          ]}
        >
          <Animated.View
            style={[
              styles.abs,
              dot,
              { left: half - w / 2, top: off },
              capStyle,
            ]}
          />
        </Animated.View>
      </Animated.View>

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: "absolute" },
  clip: { position: "absolute", overflow: "hidden" },
  frame: { left: 0, top: 0, transform: [{ rotate: "-135deg" }] },
  // 转 45° 后，上 / 右 / 下三条边正好是第一、二、三段
  quarters: { transform: [{ rotate: "45deg" }] },
});
