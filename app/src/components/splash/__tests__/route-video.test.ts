// 预渲染成视频的路线段（assets/splash/route-video.mp4，安卓播它）：文件和代码里的约定对得上、
// 和矢量的预录帧是同一批（两个要一起重录：npx tsx scripts/build-splash-frames.ts、build-splash-video.ts）
import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

import {
  VIDEO_FPS,
  VIDEO_H,
  VIDEO_POST,
  VIDEO_PRE,
  VIDEO_PRE_MS,
  VIDEO_W,
} from "../route-video-format";
import { MARK_DONE, buildWarp } from "../timeline";

const dir = path.join(__dirname, "..", "..", "..", "..", "assets", "splash");
const file = fs.readFileSync(path.join(dir, "route-video.mp4"));
const meta = JSON.parse(
  fs.readFileSync(path.join(dir, "route-video.json"), "utf8"),
) as {
  frames: number;
  pre: number;
  post: number;
  fps: number;
  width: number;
  height: number;
  bytes: number;
};
const pictures = JSON.parse(
  fs.readFileSync(path.join(dir, "route-frames.json"), "utf8"),
) as { frames: number; fps: number };

/** MP4 里某种盒子的内容从哪开始（盒子类型那四个字母之后）；这个文件的索引在开头，直接找就行 */
function boxBody(type: string, from = 0): number {
  const at = file.indexOf(Buffer.from(type, "latin1"), from);
  if (at < 0) throw new Error(`no ${type} box`);
  return at + 4;
}

describe("预渲染成视频的路线段", () => {
  it("和代码里的约定一致", () => {
    expect(file.byteLength).toBe(meta.bytes);
    expect(meta.fps).toBe(VIDEO_FPS);
    expect(meta.pre).toBe(VIDEO_PRE);
    expect(meta.post).toBe(VIDEO_POST);
    expect(meta.width).toBe(VIDEO_W);
    expect(meta.height).toBe(VIDEO_H);
    expect(VIDEO_PRE_MS).toBeCloseTo((VIDEO_PRE * 1000) / VIDEO_FPS, 6);
  });

  it("文件本身是这么大的 H.264、这么多帧", () => {
    // 采样表：版本和标志 4 字节、统一大小 4 字节，然后是采样数
    expect(file.readUInt32BE(boxBody("stsz") + 8)).toBe(
      meta.pre + meta.frames + meta.post,
    );
    // H.264 的采样描述（在 stsd 里；文件开头的兼容列表里也有 avc1 这四个字母，要跳过）：
    // 前面 24 字节是保留字段，然后是宽和高
    const entry = boxBody("avc1", boxBody("stsd"));
    expect(file.readUInt16BE(entry + 24)).toBe(VIDEO_W);
    expect(file.readUInt16BE(entry + 26)).toBe(VIDEO_H);
  });

  it("和矢量的预录帧是同一批：一样多帧、一样的帧率", () => {
    expect(meta.frames).toBe(pictures.frames);
    expect(meta.fps).toBe(pictures.fps);
  });

  it("商标完成时正片刚好放完，后面只垫几帧就结束（放完解码器自己停）", () => {
    const done = buildWarp()[MARK_DONE];
    // 正片的最后一帧就是商标完成前的最后一个 1/60 秒
    expect(Math.ceil((done * VIDEO_FPS) / 1000)).toBe(meta.frames);
    expect(VIDEO_POST).toBeGreaterThanOrEqual(2);
    expect((VIDEO_POST * 1000) / VIDEO_FPS).toBeLessThanOrEqual(200);
  });
});
