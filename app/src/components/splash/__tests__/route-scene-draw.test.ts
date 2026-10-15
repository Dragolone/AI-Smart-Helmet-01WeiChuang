// 开屏路线段逐帧画出来对不对：用电脑上那套真的 Skia（CanvasKit，scripts/splash-frames.ts 出图用的同一套）
// 画几帧，读像素断言——不替换画布，画法代码原样跑。
// 断言的是画面上看得见的结论：底色、商标实心部分什么时候在、光什么时候收、脉冲环画在哪、
// sceneIsEmpty 说「空了」的时候画面确实只剩底色。
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import path from "node:path";
import { TextDecoder as NodeTextDecoder } from "node:util";

import {
  MARK_LIFT,
  SCENE_T,
  SCENE_W,
  buildSceneTables,
  drawRouteScene,
  makeSceneState,
  sceneIsEmpty,
  type MarkGlow,
  type SceneState,
  type SceneTables,
  type SkiaApi,
} from "../route-scene";

/* eslint-disable @typescript-eslint/no-require-imports -- CanvasKit 和 Skia 的 web 实现只有 CommonJS 入口 */
const H = 610;
// 屏幕上的商标中心
const CX = SCENE_W / 2;
const CY = H / 2 - MARK_LIFT;
const BG = [14, 15, 18]; // SCENE_BG #0E0F12

let Skia: SkiaApi;
let tb: SceneTables;
let S: SceneState;
let surface: NonNullable<ReturnType<SkiaApi["Surface"]["Make"]>>;
const savedDecoder = globalThis.TextDecoder;

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
  tb = buildSceneTables();
  S = makeSceneState(Skia, tb, H);
  const made = Skia.Surface.Make(SCENE_W, H);
  if (!made) throw new Error("no surface");
  surface = made;
}, 30000);

afterAll(() => {
  (globalThis as { TextDecoder: unknown }).TextDecoder = savedDecoder;
});

const glowOf = (over: Partial<MarkGlow> = {}): MarkGlow => ({
  cx: CX,
  cy: CY,
  scale: 1,
  dock: 0,
  breath: 0,
  pulse: -1,
  ...over,
});

/** 画一帧，读回 RGBA（预乘） */
function frame(
  t: number,
  glow: MarkGlow,
  withBackground = true,
  holdMark = false,
): Uint8Array {
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color("transparent"));
  drawRouteScene(Skia, canvas, S, tb, t, glow, withBackground, holdMark);
  surface.flush();
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, {
    width: SCENE_W,
    height: H,
    colorType: 4, // RGBA_8888
    alphaType: 2, // Premul
  });
  if (!px) throw new Error("readPixels failed");
  return px as Uint8Array;
}

const at = (px: Uint8Array, x: number, y: number) => {
  const i = (Math.round(y) * SCENE_W + Math.round(x)) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
};
/** 和底色不一样的像素有多少 */
const notBg = (px: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4)
    if (px[i] !== BG[0] || px[i + 1] !== BG[1] || px[i + 2] !== BG[2]) n++;
  return n;
};
/** 接近商标实心荧光色 rgb(212,241,63) 的像素有多少 */
const solidGreen = (px: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4)
    if (
      Math.abs(px[i] - 212) < 16 &&
      Math.abs(px[i + 1] - 241) < 16 &&
      Math.abs(px[i + 2] - 63) < 24
    )
      n++;
  return n;
};
const lumaSum = (px: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2];
  return s;
};

describe("路线段逐帧（真的 Skia）", () => {
  it("sceneIsEmpty 说空了的那一刻：铺底时整幅都是底色，不铺底时整幅透明", () => {
    const glow = glowOf({ dock: 1 });
    const t = SCENE_T.raster[1] + 200;
    expect(sceneIsEmpty(t, glow)).toBe(true);
    const withBg = frame(t, glow, true);
    expect(notBg(withBg)).toBe(0);
    expect(at(withBg, 0, 0)).toEqual([...BG, 255]);
    const bare = frame(t, glow, false);
    let maxAlpha = 0;
    for (let i = 3; i < bare.length; i += 4)
      maxAlpha = Math.max(maxAlpha, bare[i]);
    expect(maxAlpha).toBe(0);
  });

  it("从全暗起（t=0 只有底色），光沿路跑开、画面越来越亮", () => {
    const f0 = frame(0, glowOf());
    expect(notBg(f0)).toBe(0);
    const seen: number[] = [];
    for (const t of [50, 100, 200, 400]) seen.push(notBg(frame(t, glowOf())));
    // 50 ms 起就有光，之后亮起来的像素只多不少
    expect(seen[0]).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it("成形中（换原图之前）商标的荧光块是实心画出来的", () => {
    expect(solidGreen(frame(1500, glowOf()))).toBeGreaterThan(200);
  });

  it("换成原图之后矢量实心不再画（原图由页面上的图片组件显示），只剩它周围的光", () => {
    const px = frame(SCENE_T.raster[1] + 100, glowOf());
    expect(solidGreen(px)).toBe(0);
    // 光还在：商标附近不是底色
    expect(notBg(px)).toBeGreaterThan(0);
  });

  it("holdMark（录视频用）：换原图之后矢量实心也一直留着", () => {
    expect(
      solidGreen(frame(SCENE_T.raster[1] + 100, glowOf(), true, true)),
    ).toBeGreaterThan(200);
  });

  it("商标离开原位（dock=1）后周围的光收掉；呼吸让光更亮", () => {
    const t = SCENE_T.raster[1] + 100;
    expect(notBg(frame(t, glowOf({ dock: 1 })))).toBe(0);
    const calm = lumaSum(frame(t, glowOf({ breath: 0 })));
    const breathing = lumaSum(frame(t, glowOf({ breath: 1 })));
    expect(breathing).toBeGreaterThan(calm);
  });

  it("脉冲环画在商标外一圈（半径约 84→110），走完就不画", () => {
    const t = SCENE_T.raster[1] + 100;
    const pulse = 0.5;
    // 第一圈此刻的半径：lerp(84, 110, easeOut(0.5))
    const r = 84 + (110 - 84) * 0.875;
    const ring = frame(t, glowOf({ dock: 1, pulse }));
    const onRing = at(ring, CX + r, CY);
    expect(onRing.slice(0, 3)).not.toEqual(BG);
    // 环里面、环外面远处仍是底色
    expect(at(ring, CX + r - 12, CY).slice(0, 3)).toEqual(BG);
    expect(at(ring, CX + r + 20, CY).slice(0, 3)).toEqual(BG);
    expect(notBg(frame(t, glowOf({ dock: 1, pulse: 1.3 })))).toBe(0);
    expect(notBg(frame(t, glowOf({ dock: 1, pulse: 0 })))).toBe(0);
  });

  it("商标缩放、挪位置之后，光跟着挪", () => {
    const t = SCENE_T.raster[1] + 100;
    const px = frame(t, glowOf({ cx: 60, cy: 120, scale: 0.4 }));
    // 原来的商标中心那一片现在是底色，新位置附近有光
    expect(at(px, CX, CY).slice(0, 3)).toEqual(BG);
    let near = 0;
    for (let y = 80; y < 160; y++)
      for (let x = 20; x < 100; x++)
        if (at(px, x, y).slice(0, 3).join() !== BG.join()) near++;
    expect(near).toBeGreaterThan(0);
  });
});
