// 预录的路线帧（assets/splash/route-frames.skpack）：文件是完整的、和代码里的约定对得上、
// 录它用的 Skia 版本和现在装的是同一个（图片格式跟着 Skia 走，升级了要重录：
// npx tsx scripts/build-splash-frames.ts）
import { describe, expect, it, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

import {
  FRAMES_FPS,
  FRAMES_HEIGHT,
  parseRouteFrames,
} from "../route-frames-format";
import { SKIA_ENUMS_USED } from "../route-scene";
import { MARK_DONE, buildWarp, storyAt } from "../timeline";

const dir = path.join(__dirname, "..", "..", "..", "..", "assets", "splash");
const pack = new Uint8Array(
  fs.readFileSync(path.join(dir, "route-frames.skpack")),
);
const meta = JSON.parse(
  fs.readFileSync(path.join(dir, "route-frames.json"), "utf8"),
) as { frames: number; skia: string; bytes: number };

describe("预录的路线帧", () => {
  const head = parseRouteFrames(pack);

  it("文件头读得出来，和约定一致", () => {
    expect(head).not.toBeNull();
    expect(head?.fps).toBe(FRAMES_FPS);
    expect(head?.height).toBe(FRAMES_HEIGHT);
    expect(head?.count).toBe(meta.frames);
    expect(pack.byteLength).toBe(meta.bytes);
  });

  it("一帧接一帧录到商标完成为止，中间不缺", () => {
    if (!head) throw new Error("no header");
    const warp = buildWarp();
    // 最后一帧就是商标完成前的最后一个 1/60 秒
    expect(storyAt(warp, ((head.count - 1) * 1000) / head.fps)).toBeCloseTo(
      head.lastStory,
      1,
    );
    expect(head.lastStory).toBeLessThan(MARK_DONE);
    expect(
      storyAt(warp, (head.count * 1000) / head.fps),
    ).toBeGreaterThanOrEqual(MARK_DONE);
  });

  it("每一帧都是一张 Skia 图片", () => {
    if (!head) throw new Error("no header");
    const magic = Buffer.from("skiapict", "latin1");
    for (let i = 0; i < head.count; i++) {
      const from = head.offsets[i];
      expect(head.offsets[i + 1]).toBeGreaterThan(from + 16);
      expect(Buffer.from(pack.subarray(from, from + 8)).equals(magic)).toBe(
        true,
      );
    }
  });

  it("是用现在装的这个版本的 Skia 录的", () => {
    const installed = (
      JSON.parse(
        fs.readFileSync(
          require.resolve("@shopify/react-native-skia/package.json"),
          "utf8",
        ),
      ) as { version: string }
    ).version;
    expect(meta.skia).toBe(installed);
  });

  it("不是这种文件、或者被截断了，就读不出来（App 会退回实时画）", () => {
    expect(parseRouteFrames(new Uint8Array(8))).toBeNull();
    expect(parseRouteFrames(new Uint8Array(4096))).toBeNull();
    expect(parseRouteFrames(pack.subarray(0, pack.byteLength - 1))).toBeNull();
  });
});

describe("画法里写死的几个 Skia 枚举值", () => {
  // route-scene.ts 同时要在手机上（worklet 里）和电脑上（录帧）跑，枚举写成了数字；这里守住它们没被改号
  it("和 Skia 自己的定义一致", () => {
    type Enum = Record<string, number>;
    // 只要枚举表本身：从包的入口引会连原生模块一起拉进来，测试环境里没有
    const types = jest.requireActual<{
      BlendMode: Enum;
      PaintStyle: Enum;
      StrokeJoin: Enum;
      TileMode: Enum;
      ClipOp: Enum;
    }>("@shopify/react-native-skia/lib/commonjs/skia/types");
    expect(SKIA_ENUMS_USED).toEqual({
      BLEND_SRC_OVER: types.BlendMode.SrcOver,
      BLEND_PLUS: types.BlendMode.Plus,
      STYLE_STROKE: types.PaintStyle.Stroke,
      JOIN_ROUND: types.StrokeJoin.Round,
      TILE_CLAMP: types.TileMode.Clamp,
      TILE_DECAL: types.TileMode.Decal,
      CLIP_INTERSECT: types.ClipOp.Intersect,
    });
  });
});
