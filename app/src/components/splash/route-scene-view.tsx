// 开屏的路线段：一块铺满屏幕的 Skia 画布，每帧在 UI 线程上按故事时间出一张图。
// 路线成标这一段播预录好的帧（route-frames.ts；没读到就退回实时画），之后商标周围的光实时画（很轻）。
// 安卓上路线成标这一段由垫在下面的视频显示（route-video-layer），画布到商标完成才开始画。
// 画法在 route-scene.ts；这里只负责接到画布上，以及登录页收尾时在画布上挖出页面露出来的那块。
import {
  Canvas,
  Picture,
  Skia,
  createPicture,
  type SkPicture,
} from "@shopify/react-native-skia";
import { useMemo } from "react";
import { PixelRatio, StyleSheet } from "react-native";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import {
  releaseRouteFrames,
  routeFrame,
  routeFrameAt,
  routeFramesHeight,
} from "./route-frames";
import {
  SCENE_BG,
  SCENE_W,
  buildSceneTables,
  drawRouteScene,
  makeSceneState,
  smooth,
  type MarkGlow,
  type SceneState,
} from "./route-scene";
import { VIDEO_HANDOVER } from "./route-video-format";
import { MARK_DONE, buildWarp, realAt } from "./timeline";

/**
 * 画布每个 dp 最多用几个像素来画，再放大铺满屏幕。路线带着好几层全屏的模糊，像素越多 GPU 越吃力；
 * 设计原型就是按 2 倍画的，3 倍屏上按 2 倍画、放大 1.5 倍显示，肉眼分不出来（2026-10-08 对比过），
 * 一帧的耗时少四成。最后那张清晰的商标是另一层原图，不受影响。
 */
const MAX_DENSITY = 2;
/** 视频模式下画布提前悄悄画几帧的那一小段（故事时间，毫秒），见下面 */
const PREDRAW = [150, 230] as const;

type SceneGlobals = {
  __splashEmpty?: SkPicture;
  __splashScene?: SceneState;
  __splashClear?: ReturnType<typeof Skia.Paint>;
  __splashFade?: ReturnType<typeof Skia.Paint>;
};

export function RouteSceneView({
  width,
  height,
  story,
  glow,
  reveal,
  warm,
  videoMode,
}: {
  /** 画布的大小（dp），就是整块屏幕 */
  width: number;
  height: number;
  /** 故事时间（毫秒） */
  story: SharedValue<number>;
  glow: SharedValue<MarkGlow>;
  /** 0..1：底下的页面从下往上露出来的程度（一道波浪形的边）；0 = 不露 */
  reveal: SharedValue<number>;
  /**
   * 开播前预热：>= 0 时不看故事时间，画预录的第几帧（这时画布被一层底色盖着，看不见）。
   * 模糊这类效果第一次用到时显卡要现编程序，一次十几毫秒；先画几帧有代表性的，开播后就不会在半路卡。
   */
  warm: SharedValue<number>;
  /** 1 = 路线这一段由视频层显示（安卓），画布在商标完成之前不画东西 */
  videoMode: SharedValue<number>;
}) {
  const tables = useMemo(() => buildSceneTables(), []);
  const warp = useMemo(() => buildWarp(), []);
  const H = (height / width) * SCENE_W;
  // 画布实际的大小（dp）：取到整像素，放大回去才不会错开半个像素
  const density = PixelRatio.get();
  const shrink = Math.min(1, MAX_DENSITY / density);
  const cw = Math.round(width * density * shrink) / density;
  const ch = Math.round(height * density * shrink) / density;
  const kx = cw / SCENE_W;
  const ky = ch / H;
  const picture = useDerivedValue(() => {
    const g = globalThis as unknown as SceneGlobals;
    let S = g.__splashScene;
    if (!S || S.H !== H) {
      S = makeSceneState(Skia, tables, H);
      g.__splashScene = S;
    }
    const scene = S;
    const t = story.get();
    const mark = glow.get();
    const rv = reveal.get();
    const w = warm.get();
    // 安卓：路线这一段由下面那层视频显示（route-video-layer），画布这一段空着。
    // 每帧交回同一张空图，画布就不会重画
    const video = videoMode.get() === 1;
    // 视频模式：路线刚开始的一小段里，画布把「商标完成之后的画面」几乎全透明地画几帧。显卡第一次画这幅画面
    // 要现编程序、现开缓冲，在模拟器上是 50–80 毫秒的一帧；开播前盖着底色预热的那一下在已登录时不管用
    // （主线程正忙，那两帧多半没真的画出来）。放在这里画，卡的那一下落在只有视频在动的时候——视频由系统单独
    // 合成，不受影响——到商标完成、画布真要接手时就不卡了
    const early = video && w < 0 && t > PREDRAW[0] && t < PREDRAW[1];
    if (video && t < MARK_DONE && w < 0 && !early) {
      let empty = g.__splashEmpty;
      if (!empty) {
        // 不用 createPicture(() => {})：不捕获任何东西的内联函数会被 React Compiler 提到模块顶层，
        // 在 UI 线程上就成了「另一个线程的函数」，一调用就抛错
        const recorder = Skia.PictureRecorder();
        recorder.beginRecording(Skia.XYWHRect(0, 0, cw, ch));
        empty = recorder.finishRecordingAsPicture();
        g.__splashEmpty = empty;
      }
      return empty;
    }
    // 视频模式下画布只画商标完成之后的画面，预热也就画那一帧
    const at = video && (w >= 0 || early) ? MARK_DONE : t;
    // 商标完成的那一刻画布用几帧淡进来，接过视频的最后一帧。淡入在画布里面做（整幅先画进一层，再按不透明度合上去），
    // 不去调这块视图的透明度：视图透明度是 0 时系统根本不画它，开播前的预热就白做了，头一帧要现编显卡程序
    // （模拟器上已登录时每次都在这一刻卡 50–100 毫秒）
    const fade =
      video && w < 0
        ? early
          ? 1 / 255
          : smooth((t - MARK_DONE) / VIDEO_HANDOVER)
        : 1;
    const frame = video
      ? null
      : w >= 0
        ? routeFrame(w)
        : t < MARK_DONE
          ? routeFrameAt(realAt(warp, t))
          : null;
    const pic = createPicture(
      (canvas) => {
        if (frame) {
          // 预录帧录在一块更高的画面上，竖直中心对齐着放
          canvas.drawColor(Skia.Color(SCENE_BG));
          canvas.translate(0, ((H - routeFramesHeight()) / 2) * ky);
          canvas.scale(kx, ky);
          canvas.drawPicture(frame);
          return;
        }
        if (fade < 1) {
          let paint = g.__splashFade;
          if (!paint) {
            paint = Skia.Paint();
            g.__splashFade = paint;
          }
          paint.setAlphaf(fade);
          canvas.saveLayer(paint);
        }
        canvas.scale(kx, ky);
        drawRouteScene(Skia, canvas, scene, tables, at, mark);
        if (rv > 0) {
          // 页面从下面涌上来：把波浪线以下的画布清成透明，露出底下真正的页面
          let clear = g.__splashClear;
          if (!clear) {
            clear = Skia.Paint();
            clear.setAntiAlias(true);
            clear.setBlendMode(0);
            g.__splashClear = clear;
          }
          const bend = Math.sin(Math.PI * rv) * 0.22;
          const y = 1.05 * (1 - rv);
          const pb = scene.pb;
          pb.moveTo(0, (y + bend * 0.24) * H);
          pb.cubicTo(
            0.25 * SCENE_W,
            (y - bend) * H,
            0.72 * SCENE_W,
            (y + bend * 0.64) * H,
            SCENE_W,
            (y - bend * 0.2) * H,
          );
          pb.lineTo(SCENE_W, H + 2);
          pb.lineTo(0, H + 2);
          pb.close();
          canvas.drawPath(pb.detach(), clear);
        }
        if (fade < 1) canvas.restore();
      },
      { width: cw, height: ch },
    );
    return pic;
  });
  return (
    <Canvas
      style={[
        styles.canvas,
        {
          width: cw,
          height: ch,
          transform: [{ scaleX: width / cw }, { scaleY: height / ch }],
        },
      ]}
      pointerEvents="none"
    >
      <Picture picture={picture} />
    </Canvas>
  );
}

/** 画布卸掉之后把 UI 线程上那份状态也放掉 */
export function releaseRouteScene(): void {
  "worklet";
  const g = globalThis as unknown as SceneGlobals;
  releaseRouteFrames();
  g.__splashEmpty = undefined;
  g.__splashScene = undefined;
  g.__splashClear = undefined;
  g.__splashFade = undefined;
}

const styles = StyleSheet.create({
  canvas: {
    position: "absolute",
    left: 0,
    top: 0,
    transformOrigin: "left top",
  },
});
