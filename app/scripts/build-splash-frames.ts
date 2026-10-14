// 把开屏的路线段预先录成一帧帧的 Skia 图片（assets/splash/route-frames.skpack），App 里只管播放。
//
// 为什么要预录：这一段每帧要画几千个点。在手机上逐帧用 JS 把它们算出来再交给 Skia，光是调用的固定开销
// 就占掉大半帧（2026-10-08 实测，中端机会掉帧）；而画面是固定的，所以在电脑上用同一份画法代码
// （route-scene.ts，换成 CanvasKit 来跑）先录好。手机上的 Skia 能直接读这些图片。
//
//   npx tsx scripts/build-splash-frames.ts
//
// 什么时候要重新跑：改了 route-scene.ts 的画法或参数、改了 timeline.ts 里成标之前的节奏、升级了
// @shopify/react-native-skia（图片格式跟着 Skia 版本走；读不出来时 App 会退回实时画，不会黑屏，
// 单测 route-frames.test.ts 会提醒）。
//
// 文件格式见 src/components/splash/route-frames-format.ts。旁边的 route-frames.json 记着这一份是用
// 哪个版本录的。
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
  FRAMES_FPS,
  FRAMES_HEIGHT,
} from "../src/components/splash/route-frames-format";
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

  const H = FRAMES_HEIGHT;
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
  const rec = Skia.PictureRecorder();
  const blobs: Buffer[] = [];
  let lastStory = 0;
  for (let i = 0; ; i++) {
    const t = storyAt(warp, (i * 1000) / FRAMES_FPS);
    // 录到商标完成为止：再往后画布上只剩商标周围的光，它随收尾的方式变，由 App 实时画（很轻）
    if (t >= MARK_DONE) break;
    const cv = rec.beginRecording(Skia.XYWHRect(0, 0, SCENE_W, H));
    drawRouteScene(Skia, cv, state, tables, t, glow, false);
    const bytes = rec.finishRecordingAsPicture().serialize();
    if (!bytes) throw new Error(`frame ${i}: serialize() returned nothing`);
    blobs.push(Buffer.from(bytes));
    lastStory = t;
  }
  const n = blobs.length;
  const head = Buffer.alloc(20 + 4 * (n + 1));
  head.write("HSF1", 0, "latin1");
  head.writeUInt32LE(n, 4);
  head.writeUInt32LE(FRAMES_FPS, 8);
  head.writeFloatLE(H, 12);
  head.writeFloatLE(lastStory, 16);
  let off = 0;
  blobs.forEach((b, i) => {
    head.writeUInt32LE(off, 20 + 4 * i);
    off += b.length;
  });
  head.writeUInt32LE(off, 20 + 4 * n);
  const out = path.join(
    __dirname,
    "..",
    "assets",
    "splash",
    "route-frames.skpack",
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([head, ...blobs]));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const kitVersion = require("canvaskit-wasm/package.json").version as string;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const skiaVersion = require("@shopify/react-native-skia/package.json")
    .version as string;
  fs.writeFileSync(
    out.replace(/\.skpack$/, ".json"),
    JSON.stringify(
      {
        frames: n,
        fps: FRAMES_FPS,
        height: H,
        bytes: head.length + off,
        lastStory: Math.round(lastStory),
        skia: skiaVersion,
        canvaskit: kitVersion,
        pictureVersion: blobs[0].readUInt32LE(8),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `wrote ${path.relative(process.cwd(), out)}: ${n} frames, ${((head.length + off) / 1e6).toFixed(2)} MB (skia ${skiaVersion}, canvaskit ${kitVersion})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
