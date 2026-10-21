// 求救倒计时的圆环（无 SVG 依赖）。画法和设备页的电量环（battery-arc）是同一套：
// 圆形 View 的四条边框各是一段 90° 的弧，以 45° 斜线为界；同一个 View 上相邻两条边同色时是连着的。
// 从正上方起顺时针画「还剩多少」：满的时候是整圈，随时间从末端往回收。分四层叠着画——
//   ① 走满的整段（每段 90°）：同一个圆上依次给四条边上色，段与段之间没有接缝；
//   ② 只剩第一段时：一段 90° 的弧从起点之前转进来，起点之前的部分用裁剪盒挡掉；
//   ③ 其余时候：一段 90° 的弧，前沿跟着进度走，后半截压在①已经上色的整段上面；
//   ④ 两头的圆角是小圆点：起点固定在正上方，终点跟着进度转。
//   ⑤ 整段与整段相接的地方（正上方、90°、180°、270°）各盖一段以它为中心的 90° 弧：iPhone 上同一个圆的
//      两条边框相接处会缺一个像素（2026-10-08 iPhone 截图：满圈时正上方有个小缺口、右侧有条细缝）；
//      盖上去的弧两头都落在已经上色的整段里，自己不露头。
//   各层是叠着而不是对接的，所以不会在 90° / 180° / 270° 处露缝。
// 进度由调用方给（一个 0–1 的共享值）：怎么走、走多快是页面的事，这里只管画。
// 安卓 8.x 的旧绘制管线画不对这套边框（legacy-renderer），在那上面改用 Skia 画同样尺寸的环。
import type { ReactNode } from "react";
import { PixelRatio, StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";

import { LEGACY_ANDROID_RENDERER } from "@/components/legacy-renderer";
import { SkiaArc } from "@/components/skia-arc";

/** 设计稿画在 252 的画布上：环半径 118、线宽 10 */
const VIEWBOX = 252;
const RING_R = 118;
const RING_W = 10;

/** 进度 p（0–1）在第 i 段（0–3，每段 90°）里走了多少（0–1）。在动画线程里调用 */
function quarter(p: number, i: number): number {
  "worklet";
  return Math.max(0, Math.min(1, p * 4 - i));
}

type CountdownRingProps = {
  size: number;
  /** 还剩多少：1 = 整圈，0 = 没有了 */
  progress: SharedValue<number>;
  color: string;
  track: string;
  children?: ReactNode;
};

export function CountdownRing(props: CountdownRingProps) {
  return LEGACY_ANDROID_RENDERER ? (
    <CountdownRingSkia {...props} />
  ) : (
    <CountdownRingViews {...props} />
  );
}

/** 安卓 8.x：同样的尺寸和线宽，从正上方顺时针画「还剩多少」 */
function CountdownRingSkia({
  size,
  progress,
  color,
  track,
  children,
}: CountdownRingProps) {
  const snap = PixelRatio.roundToNearestPixel;
  const k = size / VIEWBOX;
  const box = snap(size / 2) * 2;
  const w = snap((RING_W * k) / 2) * 2;
  return (
    <View style={{ width: box, height: box }}>
      <SkiaArc
        box={box}
        r={RING_R * k}
        w={w}
        startDeg={-90}
        sweepDeg={359.9}
        track={track}
        color={color}
        progress={progress}
      />
      <View style={[styles.abs, styles.inside, { width: box, height: box }]}>
        {children}
      </View>
    </View>
  );
}

function CountdownRingViews({
  size,
  progress,
  color,
  track,
  children,
}: CountdownRingProps) {
  // 尺寸全部落在整像素上：几层弧是各自排版的，带小数时各取各的整，叠在一起会错开一像素
  const snap = PixelRatio.roundToNearestPixel;
  const k = size / VIEWBOX;
  const half = snap(size / 2);
  const box = half * 2;
  const w = snap((RING_W * k) / 2) * 2;
  const outer = snap(RING_R * k + w / 2);
  const off = half - outer;
  const ring = {
    width: outer * 2,
    height: outer * 2,
    borderRadius: outer,
    borderWidth: w,
    borderColor: "transparent",
  };
  const dot = { width: w, height: w, borderRadius: w / 2 };

  const visible = useAnimatedStyle(() => ({
    opacity: progress.get() > 0 ? 1 : 0,
  }));
  const full = useAnimatedStyle(() => {
    const v = progress.get();
    return {
      borderTopColor: quarter(v, 0) >= 1 ? color : "transparent",
      borderRightColor: quarter(v, 1) >= 1 ? color : "transparent",
      borderBottomColor: quarter(v, 2) >= 1 ? color : "transparent",
      borderLeftColor: quarter(v, 3) >= 1 ? color : "transparent",
    };
  });
  // 起始角退 0.5°：进度很小时这段弧整个在裁剪盒外，边缘不会漏出一条细线
  const first = useAnimatedStyle(() => {
    const a = quarter(progress.get(), 0);
    return {
      opacity: a < 1 ? 1 : 0,
      transform: [{ rotate: `${-45.5 + 90.5 * a}deg` }],
    };
  });
  const rest = useAnimatedStyle(() => {
    const deg = progress.get() * 360;
    return {
      opacity: deg > 90 ? 1 : 0,
      transform: [{ rotate: `${deg - 45}deg` }],
    };
  });
  const end = useAnimatedStyle(() => ({
    transform: [{ rotate: `${progress.get() * 360}deg` }],
  }));
  // 接缝在 j × 90°，盖在上面的弧占 j × 90° ± 45°：进度走过它的远端才显示。
  // 正上方那一处（j = 0）两侧分别是第四段和第一段，只有满圈时才成立
  const seam0 = useAnimatedStyle(() => ({
    opacity: progress.get() >= 1 ? 1 : 0,
  }));
  const seam1 = useAnimatedStyle(() => ({
    opacity: progress.get() >= 0.375 ? 1 : 0,
  }));
  const seam2 = useAnimatedStyle(() => ({
    opacity: progress.get() >= 0.625 ? 1 : 0,
  }));
  const seam3 = useAnimatedStyle(() => ({
    opacity: progress.get() >= 0.875 ? 1 : 0,
  }));
  const seams = [seam0, seam1, seam2, seam3];

  return (
    <View style={{ width: box, height: box }}>
      <View
        pointerEvents="none"
        style={[styles.abs, ring, { left: off, top: off, borderColor: track }]}
      />

      <Animated.View
        pointerEvents="none"
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
            style={[
              styles.abs,
              ring,
              { left: off - half, top: off, borderTopColor: color },
              first,
            ]}
          />
        </View>
        {seams.map((seam, j) => (
          <Animated.View
            key={j}
            style={[
              styles.abs,
              ring,
              {
                left: off,
                top: off,
                borderTopColor: color,
                transform: [{ rotate: `${j * 90}deg` }],
              },
              seam,
            ]}
          />
        ))}
        <Animated.View
          style={[
            styles.abs,
            ring,
            { left: off, top: off, borderTopColor: color },
            rest,
          ]}
        />
        <View
          style={[
            styles.abs,
            dot,
            { left: half - w / 2, top: off, backgroundColor: color },
          ]}
        />
        <Animated.View
          style={[
            styles.abs,
            { left: 0, top: 0, width: box, height: box },
            end,
          ]}
        >
          <View
            style={[
              styles.abs,
              dot,
              { left: half - w / 2, top: off, backgroundColor: color },
            ]}
          />
        </Animated.View>
      </Animated.View>

      <View style={[styles.abs, styles.inside, { width: box, height: box }]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: "absolute" },
  clip: { position: "absolute", overflow: "hidden" },
  frame: { left: 0, top: 0 },
  // 转 45° 后，上 / 右 / 下 / 左四条边正好是第一到第四段
  quarters: { transform: [{ rotate: "45deg" }] },
  inside: { left: 0, top: 0, alignItems: "center", justifyContent: "center" },
});
