// 把开屏的路线段预先渲染成视频（assets/splash/route-video.mp4），安卓上播它。
// 为什么：见 src/components/splash/route-video-format.ts。画法还是 route-scene.ts 那一份（换成 CanvasKit 跑）。
//
//   npx tsx scripts/build-splash-video.ts          # 要先装好 ffmpeg（brew install ffmpeg），约两分钟
//
// 什么时候要重新跑：和 build-splash-frames.ts 一样（改了画法 / 参数 / 成标之前的节奏）。两个脚本一起跑。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  MARK_LIFT,
  SCENE_W,
  buildSceneTables,
  drawRouteScene,
  makeSceneState,
  type MarkGlow,
  type SkiaApi,
} from "../src/components/splash/route-scene";
import {
  VIDEO_FPS,
  VIDEO_H,
  VIDEO_POST,
  VIDEO_PRE,
  VIDEO_SCENE_H,
  VIDEO_W,
} from "../src/components/splash/route-video-format";
import {
  MARK_DONE,
  buildWarp,
  storyAt,
} from "../src/components/splash/timeline";

async function main() {
  const kitDir = path.dirname(
    require.resolve("canvaskit-wasm/bin/full/canvaskit.js"),
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const CanvasKit = await require("canvaskit-wasm/bin/full/canvaskit.js")({
    locateFile: (f: string) => path.join(kitDir, f),
  });
  (globalThis as unknown as { CanvasKit: unknown }).CanvasKit = CanvasKit;
  const quiet = console.warn;
  console.warn = (...a: unknown[]) =>
    String(a[0]).includes("is deprecated") ? undefined : quiet(...a);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {
    JsiSkApi,
  } = require("@shopify/react-native-skia/lib/commonjs/skia/web/JsiSkia");
  const Skia = JsiSkApi(CanvasKit) as SkiaApi;

  const H = VIDEO_SCENE_H;
  const tables = buildSceneTables();
  const state = makeSceneState(Skia, tables, H);
  const warp = buildWarp();
  const glow: MarkGlow = {
    cx: SCENE_W / 2,
    cy: H / 2 - MARK_LIFT,
    scale: 1,
    dock: 0,
    breath: 0,
    pulse: -1,
  };
  const surface = Skia.Surface.Make(VIDEO_W, VIDEO_H);
  if (!surface) throw new Error("no surface");
  const canvas = surface.getCanvas();
  const k = VIDEO_W / SCENE_W;
  const frame = (t: number): Buffer => {
    canvas.save();
    canvas.scale(k, k);
    // 最后一个参数：矢量的实心商标一直留到片尾。手机上视频走播放器的钟，盖在上面的商标原图走开屏的钟，
    // 两边会差一两帧；矢量商标要是在视频里按时撤掉，原图还没完全显出来的那一两帧商标就会暗一下
    // （2026-10-08 逐帧检查时见到）。留着它，原图是叠在一模一样的形状上显出来的，差几帧都看不出
    drawRouteScene(Skia, canvas, state, tables, t, glow, true, true);
    canvas.restore();
    surface.flush();
    const px = surface.makeImageSnapshot().readPixels(0, 0, {
      width: VIDEO_W,
      height: VIDEO_H,
      colorType: 4, // RGBA_8888
      alphaType: 3, // Unpremul
    });
    if (!px) throw new Error("readPixels failed");
    return Buffer.from(px.buffer, px.byteOffset, px.byteLength);
  };

  const out = path.join(
    __dirname,
    "..",
    "assets",
    "splash",
    "route-video.mp4",
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // 一帧一帧的原始像素从标准输入喂给 ffmpeg。颜色按 BT.709、有限范围标清楚；
  // 720 × 1840、每秒 60 帧在 H.264 的 4.2 级以内，只支持到 1080p 的解码器也放得了（竖着的 1080 × 1920 以内）
  const ff = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${VIDEO_W}x${VIDEO_H}`,
      "-r",
      String(VIDEO_FPS),
      "-i",
      "-",
      "-vf",
      "scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-level",
      "4.2",
      "-preset",
      "slow",
      "-crf",
      process.env.CRF ?? "15",
      "-g",
      "60",
      "-x264-params",
      "aq-mode=3:aq-strength=1.1",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-color_range",
      "tv",
      "-movflags",
      "+faststart",
      "-an",
      out,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const write = (b: Buffer) =>
    new Promise<void>((done, fail) =>
      ff.stdin.write(b, (e) => (e ? fail(e) : done())),
    );

  let frames = 0;
  let last: Buffer | null = null;
  for (let i = 0; ; i++) {
    const t = storyAt(warp, (i * 1000) / VIDEO_FPS);
    if (t >= MARK_DONE) break;
    const px = frame(t);
    if (i === 0) for (let p = 0; p < VIDEO_PRE; p++) await write(px);
    await write(px);
    last = px;
    frames += 1;
  }
  if (!last) throw new Error("no frames");
  for (let p = 0; p < VIDEO_POST; p++) await write(last);
  ff.stdin.end();
  const code: number = await new Promise((done) => ff.on("close", done));
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  fs.writeFileSync(
    out.replace(/\.mp4$/, ".json"),
    JSON.stringify(
      {
        frames,
        pre: VIDEO_PRE,
        post: VIDEO_POST,
        fps: VIDEO_FPS,
        width: VIDEO_W,
        height: VIDEO_H,
        bytes: fs.statSync(out).size,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `wrote ${path.relative(process.cwd(), out)}: ${frames} frames (+${VIDEO_PRE} before, +${VIDEO_POST} after), ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
