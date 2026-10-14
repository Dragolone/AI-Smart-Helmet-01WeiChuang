// 预录的路线段（assets/splash/route-frames.skpack）的几个约定，录制脚本和播放两边共用。
//
// 文件格式（小端）："HSF1"，帧数 u32，每秒帧数 u32，录制时画面的高度 f32，最后一帧的故事时间 f32，
// 然后 帧数+1 个 u32（各帧数据相对数据区开头的起止位置），后面是各帧的 Skia 图片数据。

/** 每秒录多少帧 */
export const FRAMES_FPS = 60;
/** 录的时候画面有多高（宽固定 282 个单位）。比哪种手机都高；播放时按竖直中心对齐，上下多出来的裁掉 */
export const FRAMES_HEIGHT = 720;

export type RouteFramesHeader = {
  count: number;
  fps: number;
  height: number;
  /** 最后一帧的故事时间（毫秒） */
  lastStory: number;
  /** 各帧数据在整个文件里的起止位置（count + 1 个） */
  offsets: number[];
};

/** 读文件头；不是这种文件、或者文件不完整就返回 null */
export function parseRouteFrames(file: Uint8Array): RouteFramesHeader | null {
  if (file.byteLength < 24) return null;
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (v.getUint32(0, true) !== 0x31465348) return null; // "HSF1"
  const count = v.getUint32(4, true);
  const base = 20 + 4 * (count + 1);
  if (count === 0 || file.byteLength < base) return null;
  const offsets: number[] = [];
  for (let i = 0; i <= count; i++) {
    const at = base + v.getUint32(20 + 4 * i, true);
    if (i > 0 && at < offsets[i - 1]) return null;
    offsets.push(at);
  }
  if (offsets[count] !== file.byteLength) return null;
  return {
    count,
    fps: v.getUint32(8, true),
    height: v.getFloat32(12, true),
    lastStory: v.getFloat32(16, true),
    offsets,
  };
}
