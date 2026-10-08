// 开屏收尾 · 已绑定头盔：商标收一点，电量环绕着它亮起来（一个光点从环的起点滑到电量处），
// 一圈扫描从中心显出头盔、同时把商标擦掉，然后整个表盘滑到设备页上它该在的位置，交还给页面。
// 这里画的是页面上那块大图的「替身」：颜色、电量、图片都由页面给（SplashAnchor name="hero" 的 data），
// 位置从页面量出来，所以交还时两边重合。环和刻度的尺寸照 components/battery-arc.tsx（240 的画布）。
import {
  BlendMode,
  BlurStyle,
  Canvas,
  FilterMode,
  MipmapMode,
  PaintStyle,
  Picture,
  Skia,
  StrokeCap,
  TileMode,
  createPicture,
  type SkCanvas,
  type SkImage,
  type SkPaint,
  type SkPath,
  type SkRect,
} from "@shopify/react-native-skia";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  type SharedValue,
} from "react-native-reanimated";

import { ThemedText } from "@/components/themed-text";

import { anchorRect, pillFrom, splashOn, splashStory } from "./bus";
import { steady } from "./steady-style";
import type { HeroSplash } from "./hero-splash";
import {
  DEVICE,
  deviceGlide,
  deviceWipe,
  slide,
  sparkDuration,
} from "./landings";
import { MARK_LIFT, SCENE_W, easeOut, lerp, smooth } from "./route-scene";

const GRID = 240;
const RING_R = 104;
const RING_W = 6;
const TICK_R = 114;
const TICK_LEN = 5;
const TICK_W = 1.6;
/** 扫描那一圈的软边有多宽（240 画布上） */
const SCAN_EDGE = 26;
/** 还不知道连没连上时，光点和环先用一种素白 */
const WAIT = "#D6DBE4";

type Dial = {
  oval: SkRect;
  box: SkRect;
  ticks: SkPath;
  stroke: SkPaint;
  fill: SkPaint;
  layer: SkPaint;
  cut: SkPaint;
  soft: SkPaint;
  image: SkPaint;
};
type DialGlobals = { __splashDial?: Dial };

function makeDial(): Dial {
  "worklet";
  const ticks = Skia.PathBuilder.Make();
  for (let deg = -135; deg <= 135; deg += 10) {
    const a = (deg * Math.PI) / 180;
    const s = Math.sin(a);
    const c = Math.cos(a);
    ticks.moveTo(
      GRID / 2 + (TICK_R - TICK_LEN / 2) * s,
      GRID / 2 - (TICK_R - TICK_LEN / 2) * c,
    );
    ticks.lineTo(
      GRID / 2 + (TICK_R + TICK_LEN / 2) * s,
      GRID / 2 - (TICK_R + TICK_LEN / 2) * c,
    );
  }
  const stroke = Skia.Paint();
  stroke.setAntiAlias(true);
  stroke.setStyle(PaintStyle.Stroke);
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  const cut = Skia.Paint();
  cut.setAntiAlias(true);
  cut.setBlendMode(BlendMode.DstIn);
  const soft = Skia.Paint();
  soft.setAntiAlias(true);
  soft.setStyle(PaintStyle.Stroke);
  const image = Skia.Paint();
  image.setAntiAlias(true);
  return {
    oval: Skia.XYWHRect(
      GRID / 2 - RING_R,
      GRID / 2 - RING_R,
      RING_R * 2,
      RING_R * 2,
    ),
    box: Skia.XYWHRect(-GRID, -GRID, GRID * 3, GRID * 3),
    ticks: ticks.detach(),
    stroke,
    fill,
    layer: Skia.Paint(),
    cut,
    soft,
    image,
  };
}

/** 颜色加上透明度 */
function tint(color: string, alpha: number): Float32Array {
  "worklet";
  const c = Skia.Color(color);
  return Float32Array.of(c[0], c[1], c[2], c[3] * alpha);
}
function mix(a: string, b: string, u: number): Float32Array {
  "worklet";
  const x = Skia.Color(a);
  const y = Skia.Color(b);
  return Float32Array.of(
    lerp(x[0], y[0], u),
    lerp(x[1], y[1], u),
    lerp(x[2], y[2], u),
    1,
  );
}
/** 环上的一点：角度从正上方起顺时针 */
function ringAt(deg: number): { x: number; y: number } {
  "worklet";
  const a = (deg * Math.PI) / 180;
  return {
    x: GRID / 2 + RING_R * Math.sin(a),
    y: GRID / 2 - RING_R * Math.cos(a),
  };
}
/** 把图按比例放进一个方框（contain） */
function fitInto(img: SkImage, x: number, y: number, size: number): SkRect {
  "worklet";
  const w = img.width();
  const h = img.height();
  const k = size / Math.max(w, h);
  return Skia.XYWHRect(
    x + (size - w * k) / 2,
    y + (size - h * k) / 2,
    w * k,
    h * k,
  );
}

function warmUp(
  canvas: SkCanvas,
  D: Dial,
  helmet: SkImage | null,
  mark: SkImage | null,
): void {
  "worklet";
  const dot = Skia.XYWHRect(0, 0, 1, 1);
  D.image.setAlphaf(0.01);
  D.image.setColorFilter(null);
  canvas.saveLayer(D.layer);
  for (const img of [helmet, mark]) {
    if (img)
      canvas.drawImageRectOptions(
        img,
        Skia.XYWHRect(0, 0, img.width(), img.height()),
        dot,
        FilterMode.Linear,
        MipmapMode.Linear,
        D.image,
      );
  }
  canvas.restore();
}

/**
 * 在环自己的 240 画布上画这一刻的表盘。
 * @param markOn 商标由这里画（扫描时要从中心把它擦掉）；false 时商标还是遮罩上那张图
 */
function drawDial(
  canvas: SkCanvas,
  D: Dial,
  hero: HeroSplash,
  t: number,
  helmet: SkImage | null,
  mark: SkImage | null,
  glowRadius: number,
): void {
  "worklet";
  const c = GRID / 2;
  const wipe = deviceWipe(t);
  const mid = wipe > 0 && wipe < 1;
  // 扫描的那一圈：最后刚好越过环
  const r = wipe * RING_R * 1.14;

  // 环外的光晕（连着才有）：扫描结束后慢慢亮起来
  if (hero.glow && glowRadius > 0) {
    const on = smooth((t - DEVICE.scan[1] + 60) / 560) * 0.9;
    if (on > 0.003) {
      D.fill.setShader(
        Skia.Shader.MakeRadialGradient(
          { x: c, y: c },
          glowRadius,
          [
            tint(hero.arc, hero.glow.alpha * on),
            tint(hero.arc, hero.glow.mid * on),
            tint(hero.arc, 0),
          ],
          [0, 0.46, 1],
          TileMode.Clamp,
        ),
      );
      canvas.drawCircle(c, c, glowRadius, D.fill);
      D.fill.setShader(null);
    }
  }
  // 头盔背后的柔光底：跟着扫描出现
  if (wipe > 0) {
    const sr = GRID * 0.42;
    D.fill.setShader(
      Skia.Shader.MakeRadialGradient(
        { x: c, y: c },
        sr,
        [
          tint(hero.spot, wipe),
          tint(hero.spot, 0.6 * wipe),
          tint(hero.spot, 0),
        ],
        [0, 0.62, 1],
        TileMode.Clamp,
      ),
    );
    canvas.drawCircle(c, c, sr, D.fill);
    D.fill.setShader(null);
  }

  // 底环先悄悄出来，刻度跟着头盔出来
  D.stroke.setStrokeCap(StrokeCap.Butt);
  const ticksOn = smooth((t - DEVICE.scan[0] - 60) / 380);
  if (ticksOn > 0) {
    D.stroke.setStrokeWidth(TICK_W);
    D.stroke.setColor(tint(hero.tick, ticksOn));
    canvas.drawPath(D.ticks, D.stroke);
  }
  D.stroke.setStrokeCap(StrokeCap.Round);
  const trackOn = smooth((t - DEVICE.tuck[0] - 60) / 300);
  if (trackOn > 0) {
    D.stroke.setStrokeWidth(RING_W);
    D.stroke.setColor(tint(hero.track, trackOn));
    canvas.drawArc(D.oval, 135, 270, false, D.stroke);
  }

  // 电量：一个光点从环的起点出现，沿环滑到电量处
  let level = 0;
  if (hero.battery !== null) {
    const full = Math.max(0, Math.min(100, hero.battery)) / 100;
    level = slide((t - DEVICE.line) / DEVICE.lineDur) * full;
    // 没连上：先是素白，扫描开始后定成页面上的灰
    const settle = smooth((t - DEVICE.scan[0] - 40) / 300);
    const color = hero.linked ? tint(hero.arc, 1) : mix(WAIT, hero.arc, settle);
    if (level * DEVICE.arc > 0.2) {
      const glow =
        0.24 * (1 - smooth((t - DEVICE.line - DEVICE.lineDur) / 320));
      if (glow > 0.003) {
        D.stroke.setStrokeWidth(15);
        D.stroke.setColor(Float32Array.of(color[0], color[1], color[2], glow));
        canvas.drawArc(D.oval, 135, 270 * level, false, D.stroke);
      }
      D.stroke.setStrokeWidth(RING_W);
      D.stroke.setColor(
        Float32Array.of(
          color[0],
          color[1],
          color[2],
          hero.linked ? 1 : lerp(0.9, 0.45, settle),
        ),
      );
      canvas.drawArc(D.oval, 135, 270 * level, false, D.stroke);
    }
    // 它最亮的那个头：动之前出现，停下不久就没了
    const head =
      smooth((t - DEVICE.line + 40) / 110) *
      (1 - smooth((t - DEVICE.line - DEVICE.lineDur) / 240));
    if (head > 0.003) {
      const p = ringAt(225 + level * 270);
      D.fill.setShader(
        Skia.Shader.MakeRadialGradient(
          p,
          15,
          [
            Float32Array.of(1, 1, 1, 0.95 * head),
            Float32Array.of(color[0], color[1], color[2], 0.6 * head),
            Float32Array.of(color[0], color[1], color[2], 0),
          ],
          [0, 0.35, 1],
          TileMode.Clamp,
        ),
      );
      canvas.drawCircle(p.x, p.y, 15, D.fill);
      D.fill.setShader(null);
      D.fill.setColor(Float32Array.of(1, 1, 1, head));
      canvas.drawCircle(p.x, p.y, 4.4, D.fill);
    }
  }

  // 头盔从中心扫出来：先暗着露出来，再亮起来
  if (wipe > 0 && helmet) {
    const size = hero.imageBox.size * GRID;
    const x = hero.imageBox.left * GRID;
    const y = hero.imageBox.top * GRID;
    const grow = lerp(0.955, 1, easeOut(wipe));
    const dest = fitInto(helmet, x, y, size);
    const lit = mid ? lerp(0.6, 1, smooth((wipe - 0.25) / 0.75)) : 1;
    D.image.setAlphaf(hero.linked ? 1 : 0.45);
    D.image.setColorFilter(
      lit < 1
        ? Skia.ColorFilter.MakeMatrix([
            lit,
            0,
            0,
            0,
            0,
            0,
            lit,
            0,
            0,
            0,
            0,
            0,
            lit,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
          ])
        : null,
    );
    canvas.saveLayer(D.layer);
    canvas.save();
    canvas.translate(x + size / 2, y + size / 2);
    canvas.scale(grow, grow);
    canvas.translate(-(x + size / 2), -(y + size / 2));
    canvas.drawImageRectOptions(
      helmet,
      Skia.XYWHRect(0, 0, helmet.width(), helmet.height()),
      dest,
      FilterMode.Linear,
      MipmapMode.Linear,
      D.image,
    );
    canvas.restore();
    if (mid) {
      D.cut.setShader(
        Skia.Shader.MakeRadialGradient(
          { x: c, y: c },
          GRID,
          [
            Float32Array.of(0, 0, 0, 1),
            Float32Array.of(0, 0, 0, 1),
            Float32Array.of(0, 0, 0, 0),
            Float32Array.of(0, 0, 0, 0),
          ],
          [0, Math.max(0, r - SCAN_EDGE) / GRID, r / GRID, 1],
          TileMode.Clamp,
        ),
      );
      canvas.drawRect(D.box, D.cut);
    }
    canvas.restore();
  }

  // 商标从中心被擦掉（扫描前后都不归这里画：之前是遮罩上那张图，之后就没有了）
  if (mid && mark) {
    const size = DEVICE.markInDial;
    canvas.saveLayer(D.layer);
    D.image.setAlphaf(1);
    D.image.setColorFilter(null);
    canvas.drawImageRectOptions(
      mark,
      Skia.XYWHRect(0, 0, mark.width(), mark.height()),
      Skia.XYWHRect(c - size / 2, c - size / 2, size, size),
      FilterMode.Linear,
      MipmapMode.Linear,
      D.image,
    );
    D.cut.setShader(
      Skia.Shader.MakeRadialGradient(
        { x: c, y: c },
        GRID,
        [
          Float32Array.of(0, 0, 0, 0),
          Float32Array.of(0, 0, 0, 0),
          Float32Array.of(0, 0, 0, 1),
          Float32Array.of(0, 0, 0, 1),
        ],
        [0, Math.max(0, r - SCAN_EDGE) / GRID, r / GRID, 1],
        TileMode.Clamp,
      ),
    );
    canvas.drawRect(D.box, D.cut);
    canvas.restore();
  }

  // 扫描的那一圈亮边
  if (mid) {
    const on = 0.7 * Math.pow(Math.sin(Math.PI * wipe), 0.7);
    D.soft.setStrokeWidth(7);
    D.soft.setColor(tint(hero.linked ? hero.arc : WAIT, 0.45 * on));
    D.soft.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 6, true));
    canvas.drawCircle(c, c, r, D.soft);
    D.soft.setMaskFilter(null);
    D.soft.setStrokeWidth(0.9);
    D.soft.setColor(Float32Array.of(0.94, 0.98, 0.96, 0.85 * on));
    canvas.drawCircle(c, c, r, D.soft);
  }
}

export function DeviceLanding({
  width,
  height,
  hero,
  mark,
  helmet,
  markTaken,
  inPlace = false,
  giveAt = DEVICE.give,
}: {
  width: number;
  height: number;
  /** 大图现在的样子；还不知道（设备列表没回来）就什么都不画 */
  hero: HeroSplash | undefined;
  /** 商标和头盔的图（遮罩早就开始读了，到这里多半已经读好） */
  mark: SkImage | null;
  helmet: SkImage | null;
  /** 置 1 = 商标从扫描那一刻起由这里画（遮罩上那张图到时让开） */
  markTaken: SharedValue<number>;
  /** 表盘一开始就在页面上大图的位置（引导页变成设备页时用），不是先在屏幕中间再滑过去 */
  inPlace?: boolean;
  /** 从哪一刻起交还给页面（故事时间）；默认是冷启动那一套的时刻 */
  giveAt?: number;
}) {
  const k = width / SCENE_W;
  const cx = width / 2;
  const cy = height / 2 - MARK_LIFT * k;
  const size0 = DEVICE.ring0 * width;

  const ready = !!hero && !!mark && !!helmet;
  useEffect(() => {
    markTaken.set(ready ? 1 : 0);
  }, [ready, markTaken]);

  // 表盘这一刻在屏幕上的位置和边长：先在商标那里，再滑到页面上大图的位置
  const frame = useDerivedValue(() => {
    const t = splashStory.get();
    const a = anchorRect.hero.get();
    const g = a ? (inPlace ? 1 : deviceGlide(t)) : 0;
    return {
      t,
      x: a ? lerp(cx, a.x + a.w / 2, g) : cx,
      y: a ? lerp(cy, a.y + a.h / 2, g) : cy,
      size: a ? lerp(size0, a.w, g) : size0,
      rest: a ? a.w : size0,
    };
  });

  // 光点落到连接状态那一粒上的时刻：名字和那一粒跟着它出现
  const battery = hero?.battery ?? null;
  const linked = hero?.linked ?? false;
  useAnimatedReaction(
    () => {
      if (!splashOn.get()) return -1;
      if (!linked || battery === null) return DEVICE.scan[1] + 20;
      const a = anchorRect.hero.get();
      const p = anchorRect.heroPill.get();
      const onRing = (1 - battery / 100) * DEVICE.arc;
      let drop = 140;
      if (a && p) {
        const u = a.w / GRID;
        const end = ringAt(495);
        drop =
          Math.hypot(
            p.x + 13 - (a.x + end.x * u),
            p.y + p.h / 2 - (a.y + end.y * u),
          ) / u;
      }
      return DEVICE.spark + sparkDuration(onRing, drop) - 30;
    },
    (at) => {
      if (at >= 0) pillFrom.set(at);
    },
  );

  const picture = useDerivedValue(() => {
    const f = frame.get();
    const g = globalThis as unknown as DialGlobals;
    const D = g.__splashDial ?? (g.__splashDial = makeDial());
    return createPicture(
      (canvas) => {
        if (!hero) return;
        // 两张图第一次画要先传到显卡上，蒙版那一层也要先开出来，各要十几毫秒。趁商标刚成形、画面不动的
        // 时候先在角上画一个看不见的点把这些事做掉，轮到扫描时就不会卡
        if (f.t < DEVICE.line) warmUp(canvas, D, helmet, mark);
        const u = f.size / GRID;
        canvas.save();
        canvas.translate(f.x - f.size / 2, f.y - f.size / 2);
        canvas.scale(u, u);
        drawDial(
          canvas,
          D,
          hero,
          f.t,
          helmet,
          mark,
          hero.glow ? (hero.glow.radius ?? f.rest * 1.05) / (f.rest / GRID) : 0,
        );
        canvas.restore();

        // 连着的时候：光点从电量停住的地方接着走完剩下的环，从环的末端落下去，成为连接状态那一粒
        const p = anchorRect.heroPill.get();
        if (!hero.linked || hero.battery === null || !p) return;
        const onRing = (1 - hero.battery / 100) * DEVICE.arc;
        const end = ringAt(495);
        const ex = f.x - f.size / 2 + end.x * u;
        const ey = f.y - f.size / 2 + end.y * u;
        const px = p.x + 13;
        const py = p.y + p.h / 2;
        const drop = Math.hypot(px - ex, py - ey) / u;
        const sp = (f.t - DEVICE.spark) / sparkDuration(onRing, drop);
        if (sp <= 0 || sp >= 1) return;
        const d = smooth(sp) * (onRing + drop);
        let x = px;
        let y = py;
        if (d <= onRing) {
          const q = ringAt(225 + (hero.battery / 100 + d / DEVICE.arc) * 270);
          x = f.x - f.size / 2 + q.x * u;
          y = f.y - f.size / 2 + q.y * u;
        } else {
          const w = (d - onRing) / drop;
          x = lerp(ex, px, w);
          y = lerp(ey, py, w);
        }
        const on = Math.min(1, sp * 6);
        const rr = 4 * lerp(1.15, 0.8, sp);
        D.fill.setColor(tint(hero.arc, 0.75 * on));
        D.fill.setMaskFilter(
          Skia.MaskFilter.MakeBlur(BlurStyle.Normal, 5, true),
        );
        canvas.drawCircle(x, y, rr + 4, D.fill);
        D.fill.setMaskFilter(null);
        D.fill.setColor(Float32Array.of(0.86, 1, 0.9, on));
        canvas.drawCircle(x, y, rr, D.fill);
      },
      { width, height },
    );
  });

  // 到位之后交还给页面：页面上真的那一份淡入，这一份随后淡出。页面上还没有大图（列表没回来）时，
  // 没有地方可去，跟着底色一起淡掉
  const fade = useAnimatedStyle(() => {
    const t = splashStory.get();
    return {
      opacity: anchorRect.hero.get()
        ? 1 - smooth((t - giveAt - 100) / 200)
        : 1 - smooth((t - DEVICE.hand + 80) / 320),
    };
  });
  // 电量那一行字：扫描快结束时出现，跟着表盘一起走。按到位后的大小排版，途中整块缩放
  const batteryStyle = useAnimatedStyle(() => {
    const f = frame.get();
    const s = f.size / f.rest;
    return steady("splash.battery", {
      opacity: smooth((f.t - (DEVICE.scan[1] - 130)) / 220),
      width: f.rest,
      transform: [
        { translateX: f.x - f.rest / 2 },
        { translateY: f.y - f.size / 2 + (hero?.batteryTop ?? 0.85) * f.size },
        { scale: s },
      ],
    });
  });

  return (
    <Animated.View pointerEvents="none" style={[styles.fill, fade]}>
      <Canvas style={styles.fill}>
        <Picture picture={picture} />
      </Canvas>
      {hero && (
        <Animated.View style={[styles.battery, batteryStyle]}>
          <View style={styles.batteryRow}>
            <ThemedText
              style={[styles.batteryLabel, { color: hero.labelColor }]}
            >
              {hero.label}
            </ThemedText>
            <ThemedText
              style={[styles.batteryValue, { color: hero.valueColor }]}
            >
              {hero.value}
              {hero.unit !== "" && (
                <ThemedText
                  style={[styles.batteryUnit, { color: hero.valueColor }]}
                >
                  {hero.unit}
                </ThemedText>
              )}
            </ThemedText>
          </View>
        </Animated.View>
      )}
    </Animated.View>
  );
}

/** 表盘用完之后把 UI 线程上那份画具放掉 */
export function releaseDeviceLanding(): void {
  "worklet";
  (globalThis as unknown as DialGlobals).__splashDial = undefined;
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill },
  battery: {
    position: "absolute",
    left: 0,
    top: 0,
    transformOrigin: "center top",
  },
  batteryRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 6,
  },
  // 这三样的字号照设备页（(tabs)/index.tsx 的 batteryLabel / batteryValue / batteryUnit）
  batteryLabel: { fontSize: 11, lineHeight: 14, fontWeight: 600 },
  batteryValue: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: 800,
    fontVariant: ["tabular-nums"],
  },
  batteryUnit: { fontSize: 12, lineHeight: 24, fontWeight: 700 },
});
