// 开屏路线段的画布（route-scene-view）每帧交出哪张图：用电脑上那套真的 Skia（CanvasKit）把交出的图画出来、读像素。
// - iOS（不走视频）：商标完成前有预录帧就播预录帧（铺底色、竖直居中对齐），没有就实时画；之后实时画；预热时画指定那帧
// - 安卓（视频模式）：商标完成前交同一张空图（画布不重画），开头一小段几乎全透明地预画一次；商标完成时淡入接过视频
// - 页面从下往上露出来时把波浪线以下清成透明；画布大小按像素密度封顶 2 倍再放大铺满；卸掉时放掉 UI 线程上的状态
// 预录帧模块换成可控的替身（读文件那一层另有测试），画法代码原样跑。
/* eslint-disable @typescript-eslint/no-require-imports -- CanvasKit 和 Skia 的 web 实现只有 CommonJS 入口 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { SkPicture } from "@shopify/react-native-skia";
import path from "node:path";
import { TextDecoder as NodeTextDecoder } from "node:util";
import { PixelRatio } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import { flat, isHost, render } from "@/__tests__/helpers/render";
import {
  releaseRouteFrames,
  routeFrame,
  routeFrameAt,
  routeFramesHeight,
} from "../route-frames";
import {
  MARK_LIFT,
  SCENE_W,
  buildSceneTables,
  drawRouteScene,
  makeSceneState,
  type MarkGlow,
  type SkiaApi,
} from "../route-scene";
import { RouteSceneView, releaseRouteScene } from "../route-scene-view";
import { VIDEO_HANDOVER } from "../route-video-format";
import { MARK_DONE, buildWarp, realAt } from "../timeline";

/** 真的 Skia 在 beforeAll 里异步起好，替身模块通过它拿 */
const mockKit: { Skia: SkiaApi | null } = { Skia: null };
jest.mock("@shopify/react-native-skia", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return {
    Canvas: (p: Record<string, unknown>) =>
      h("SkCanvas", p, p.children as never),
    Picture: (p: Record<string, unknown>) => h("SkPictureNode", p),
    get Skia() {
      return mockKit.Skia;
    },
    // 和库里的 createPicture 一样：按给定大小录一张图
    createPicture: (
      cb: (canvas: unknown) => void,
      size: { width: number; height: number },
    ) => {
      const S = mockKit.Skia!;
      const rec = S.PictureRecorder();
      const canvas = rec.beginRecording(
        S.XYWHRect(0, 0, size.width, size.height),
      );
      cb(canvas);
      return rec.finishRecordingAsPicture();
    },
  };
});
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
jest.mock("react-native-reanimated", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock(),
);
jest.mock("../route-frames", () => ({
  routeFrame: jest.fn(() => null),
  routeFrameAt: jest.fn(() => null),
  routeFramesHeight: jest.fn(() => 0),
  releaseRouteFrames: jest.fn(),
}));

const W = SCENE_W; // 画布宽 282 dp：场景单位和 dp 一比一，像素好对
const HT = 610;
const BG = [14, 15, 18];
let Skia: SkiaApi;
let surface: NonNullable<ReturnType<SkiaApi["Surface"]["Make"]>>;
const savedDecoder = globalThis.TextDecoder;
let ratio: ReturnType<typeof jest.spyOn>;

beforeAll(async () => {
  // jest-expo 环境里的 TextDecoder 不认 utf-16le，CanvasKit 初始化要用：换成 Node 自带的
  (globalThis as { TextDecoder: unknown }).TextDecoder = NodeTextDecoder;
  const kitDir = path.dirname(
    require.resolve("canvaskit-wasm/bin/full/canvaskit.js"),
  );
  const CanvasKitInit = require("canvaskit-wasm/bin/full/canvaskit.js");
  const CanvasKit = await CanvasKitInit({
    locateFile: (f: string) => path.join(kitDir, f),
  });
  (globalThis as { CanvasKit?: unknown }).CanvasKit = CanvasKit;
  const {
    JsiSkApi,
  } = require("@shopify/react-native-skia/lib/commonjs/skia/web/JsiSkia");
  Skia = JsiSkApi(CanvasKit) as SkiaApi;
  mockKit.Skia = Skia;
  const made = Skia.Surface.Make(W, HT);
  if (!made) throw new Error("no surface");
  surface = made;
}, 30000);
afterAll(() => {
  (globalThis as { TextDecoder: unknown }).TextDecoder = savedDecoder;
});
beforeEach(() => {
  // jest 里 RN 的像素密度是 2：正好不缩，画布大小 = 屏幕大小
  ratio = jest.spyOn(PixelRatio, "get").mockReturnValue(2);
  releaseRouteScene();
});
afterEach(() => {
  ratio.mockRestore();
  jest.clearAllMocks();
});

const sv = <T,>(v: T) =>
  ({ get: () => v, value: v }) as unknown as SharedValue<T>;
const glowOf = (over: Partial<MarkGlow> = {}): MarkGlow => ({
  cx: W / 2,
  cy: HT / 2 - MARK_LIFT,
  scale: 1,
  dock: 0,
  breath: 0,
  pulse: -1,
  ...over,
});
type Opts = {
  t: number;
  glow?: MarkGlow;
  reveal?: number;
  warm?: number;
  video?: 0 | 1;
  width?: number;
  height?: number;
};
const view = (o: Opts) => (
  <RouteSceneView
    width={o.width ?? W}
    height={o.height ?? HT}
    story={sv(o.t)}
    glow={sv(o.glow ?? glowOf())}
    reveal={sv(o.reveal ?? 0)}
    warm={sv(o.warm ?? -1)}
    videoMode={sv<number>(o.video ?? 0)}
  />
);
/** 画布这一帧交出的图 */
const pictureOf = (o: Opts): SkPicture => {
  const r = render(view(o));
  return r.root.find((n) => isHost(n, "SkPictureNode")).props.picture
    .value as SkPicture;
};
/** 把一张图画到透明的面上，读回 RGBA（预乘） */
const pixels = (pic: SkPicture | ((c: never) => void)): Uint8Array => {
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color("transparent"));
  if (typeof pic === "function") pic(canvas as never);
  else canvas.drawPicture(pic);
  surface.flush();
  const px = surface.makeImageSnapshot().readPixels(0, 0, {
    width: W,
    height: HT,
    colorType: 4,
    alphaType: 2,
  });
  if (!px) throw new Error("readPixels failed");
  return px as Uint8Array;
};
const at = (px: Uint8Array, x: number, y: number) => {
  const i = (Math.round(y) * W + Math.round(x)) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
};
const maxAlpha = (px: Uint8Array, y0 = 0, y1 = HT) => {
  let a = 0;
  for (let y = y0; y < y1; y++)
    for (let x = 0; x < W; x++) a = Math.max(a, px[(y * W + x) * 4 + 3]);
  return a;
};
const diff = (a: Uint8Array, b: Uint8Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
};
/** 直接用画法代码画同一刻（不经画布组件），用来比对 */
const direct = (t: number, glow = glowOf()) => {
  const S = makeSceneState(Skia, buildSceneTables(), HT);
  const tb = buildSceneTables();
  return pixels((c: never) => drawRouteScene(Skia, c, S, tb, t, glow));
};
/** 一张小预录帧：在录制画面（高 720）的 y=55..65 画一条红带 */
const redBandFrame = () => {
  const rec = Skia.PictureRecorder();
  const c = rec.beginRecording(Skia.XYWHRect(0, 0, W, 720));
  const p = Skia.Paint();
  p.setColor(Skia.Color("#FF0000"));
  c.drawRect(Skia.XYWHRect(0, 55, W, 10), p);
  return rec.finishRecordingAsPicture();
};

describe("iOS（不走视频）", () => {
  it("没有预录帧时实时画：交出的图和直接用画法代码画同一刻一模一样", () => {
    const t = 1200;
    const pic = pixels(pictureOf({ t }));
    expect(routeFrameAt).toHaveBeenCalledWith(realAt(buildWarp(), t));
    expect(diff(pic, direct(t))).toBe(0);
    expect(at(pic, 2, 2)).toEqual([...BG, 255]);
  });

  it("有预录帧：铺底色，按录制画面竖直居中对齐着放（720 高放进 610 高：上移 55）", () => {
    const frame = redBandFrame();
    (routeFrameAt as jest.Mock).mockReturnValue(frame);
    (routeFramesHeight as jest.Mock).mockReturnValue(720);
    const px = pixels(pictureOf({ t: 800 }));
    expect(at(px, 100, 5)).toEqual([255, 0, 0, 255]);
    expect(at(px, 100, 12)).toEqual([...BG, 255]);
    expect(at(px, 100, 400)).toEqual([...BG, 255]);
  });

  it("商标完成之后不再看预录帧，实时画；预热时不看故事时间，画指定那一帧", () => {
    (routeFrameAt as jest.Mock).mockReturnValue(redBandFrame());
    (routeFramesHeight as jest.Mock).mockReturnValue(720);
    const after = pixels(pictureOf({ t: MARK_DONE + 300 }));
    expect(routeFrameAt).not.toHaveBeenCalled();
    expect(diff(after, direct(MARK_DONE + 300))).toBe(0);

    (routeFrame as jest.Mock).mockReturnValue(redBandFrame());
    const warm = pixels(pictureOf({ t: MARK_DONE + 300, warm: 42 }));
    expect(routeFrame).toHaveBeenCalledWith(42);
    expect(at(warm, 100, 5)).toEqual([255, 0, 0, 255]);
  });

  it("页面露出来：露到一半时下面清成透明、上面还是开屏；露满时整幅透明", () => {
    const t = MARK_DONE + 300;
    const half = pixels(pictureOf({ t, reveal: 0.5 }));
    expect(at(half, 140, 20)[3]).toBe(255);
    expect(maxAlpha(half, HT - 60, HT)).toBe(0);
    const full = pixels(pictureOf({ t, reveal: 1 }));
    expect(maxAlpha(full, 2, HT)).toBe(0);
  });
});

describe("安卓（视频模式）", () => {
  it("商标完成前交同一张空图（画布不重画），整幅透明，也不去看预录帧", () => {
    const a = pictureOf({ t: 600, video: 1 });
    const b = pictureOf({ t: 1000, video: 1 });
    expect(b).toBe(a);
    expect(maxAlpha(pixels(a))).toBe(0);
    expect(routeFrameAt).not.toHaveBeenCalled();
    expect(routeFrame).not.toHaveBeenCalled();
  });

  it("开头那一小段（150–230ms）几乎全透明地预画一次商标完成之后的画面", () => {
    const empty = pictureOf({ t: 600, video: 1 });
    const early = pictureOf({ t: 200, video: 1 });
    expect(early).not.toBe(empty);
    const px = pixels(early);
    expect(maxAlpha(px)).toBeLessThanOrEqual(1);
    // 边界上不算这一段
    expect(pictureOf({ t: 150, video: 1 })).toBe(empty);
    expect(pictureOf({ t: 230, video: 1 })).toBe(empty);
  });

  it("商标完成时用 50ms 淡入接过视频：一半时半透明，走完就是实时画的样子；预热画的是商标完成那一帧", () => {
    const solid = direct(MARK_DONE + VIDEO_HANDOVER);
    const mid = pixels(
      pictureOf({ t: MARK_DONE + VIDEO_HANDOVER / 2, video: 1 }),
    );
    const a = at(mid, 2, 2)[3];
    expect(a).toBeGreaterThan(110);
    expect(a).toBeLessThan(145);
    const done = pixels(pictureOf({ t: MARK_DONE + VIDEO_HANDOVER, video: 1 }));
    expect(diff(done, solid)).toBe(0);

    const warm = pixels(pictureOf({ t: 0, warm: 3, video: 1 }));
    expect(routeFrame).not.toHaveBeenCalled();
    expect(diff(warm, direct(MARK_DONE))).toBe(0);
  });
});

describe("画布大小与收尾", () => {
  it("像素密度 3 的屏：按 2 倍画、放大 1.5 倍铺满；密度 2 及以下不缩", () => {
    ratio.mockReturnValue(3);
    let r = render(view({ t: 0, width: 390, height: 844 }));
    let s = flat(r.root.find((n) => isHost(n, "SkCanvas")).props.style);
    expect([s.width, s.height]).toEqual([260, Math.round(844 * 2) / 3]);
    expect(s.transform).toEqual([
      { scaleX: 390 / 260 },
      { scaleY: 844 / (Math.round(844 * 2) / 3) },
    ]);
    expect(r.root.find((n) => isHost(n, "SkCanvas")).props.pointerEvents).toBe(
      "none",
    );
    ratio.mockReturnValue(1.5);
    r = render(view({ t: 0, width: 390, height: 844 }));
    s = flat(r.root.find((n) => isHost(n, "SkCanvas")).props.style);
    expect([s.width, s.height]).toEqual([390, 844]);
    expect(s.transform).toEqual([{ scaleX: 1 }, { scaleY: 1 }]);
  });

  it("换了屏幕高度就按新高度重建场景；卸掉时放掉预录帧和 UI 线程上的那几份状态", () => {
    type G = { __splashScene?: { H: number }; __splashEmpty?: unknown };
    const g = globalThis as unknown as G;
    pictureOf({ t: 600 });
    expect(g.__splashScene?.H).toBe(HT);
    const first = g.__splashScene;
    pictureOf({ t: 700 });
    expect(g.__splashScene).toBe(first);
    pictureOf({ t: 600, height: 700 });
    expect(g.__splashScene?.H).toBeCloseTo(700);
    pictureOf({ t: 600, video: 1 });
    expect(g.__splashEmpty).toBeDefined();
    releaseRouteScene();
    expect(releaseRouteFrames).toHaveBeenCalled();
    expect(g.__splashScene).toBeUndefined();
    expect(g.__splashEmpty).toBeUndefined();
  });
});
