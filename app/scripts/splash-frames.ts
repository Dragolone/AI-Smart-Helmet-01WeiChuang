// 在电脑上把开屏的路线段画成图片（不用起 App）：同一份画法代码，换成 CanvasKit 来跑。
// 用来和设计原型逐帧对比，或者改了画法之后看效果。
//
//   npx tsx scripts/splash-frames.ts <输出目录> <故事时间,逗号分隔> [屏幕高度(按宽 282 算)=610] [倍率=2]
//
// 输出 f0000.png 这样的文件，尺寸是 282×倍率 宽。时间是故事时间（毫秒），0–1600 是路线成标。
import fs from "node:fs";
import path from "node:path";

import {
  MARK_LIFT,
  SCENE_TUNING,
  SCENE_W,
  buildSceneTables,
  drawRouteScene,
  makeSceneState,
  type MarkGlow,
  type SkiaApi,
} from "../src/components/splash/route-scene";

async function main() {
  const [outDir, timesArg = "0", hArg = "610", scaleArg = "2"] =
    process.argv.slice(2);
  if (!outDir)
    throw new Error("usage: splash-frames.ts <outDir> <t1,t2,...> [H] [scale]");
  const H = Number(hArg);
  const scale = Number(scaleArg);
  const kitDir = path.dirname(
    require.resolve("canvaskit-wasm/bin/full/canvaskit.js"),
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const CanvasKitInit = require("canvaskit-wasm/bin/full/canvaskit.js");
  const CanvasKit = await CanvasKitInit({
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

  // 试参数用：TUNE='{"classSigma":[...],"bloom":[[半径,强度],...]}'
  if (process.env.TUNE)
    Object.assign(SCENE_TUNING, JSON.parse(process.env.TUNE));
  const tables = buildSceneTables();
  const state = makeSceneState(Skia, tables, H);
  const surface = Skia.Surface.Make(
    Math.round(SCENE_W * scale),
    Math.round(H * scale),
  );
  if (!surface) throw new Error("no surface");
  const canvas = surface.getCanvas();
  fs.mkdirSync(outDir, { recursive: true });
  const glow: MarkGlow = {
    cx: SCENE_W / 2,
    cy: H / 2 - MARK_LIFT,
    scale: 1,
    dock: 0,
    breath: 0,
    pulse: -1,
  };
  let worst = 0;
  for (const t of timesArg.split(",").filter(Boolean).map(Number)) {
    const started = performance.now();
    canvas.save();
    canvas.scale(scale, scale);
    drawRouteScene(Skia, canvas, state, tables, t, glow);
    canvas.restore();
    surface.flush();
    worst = Math.max(worst, performance.now() - started);
    const bytes = surface.makeImageSnapshot().encodeToBytes();
    fs.writeFileSync(
      path.join(outDir, `f${String(t).padStart(4, "0")}.png`),
      Buffer.from(bytes),
    );
  }
  console.log(
    "done; slowest frame here",
    worst.toFixed(1),
    "ms (CPU rasteriser, not the phone)",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
