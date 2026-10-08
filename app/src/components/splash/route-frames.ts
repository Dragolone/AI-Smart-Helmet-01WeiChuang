// 预录的路线段：把 assets/splash/route-frames.skpack 读进来交给 UI 线程，播放时按时间取一帧。
// 为什么预录、什么时候要重录：见 scripts/build-splash-frames.ts。
import { Skia, type SkPicture } from "@shopify/react-native-skia";
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import { scheduleOnUI } from "react-native-worklets";

import {
  parseRouteFrames,
  type RouteFramesHeader,
} from "./route-frames-format";

type FramesState = RouteFramesHeader & {
  file: Uint8Array;
  /** 手上这张图是第几帧 */
  at: number;
  picture: SkPicture | null;
};
type FramesGlobal = { __splashFrames?: FramesState };

let loading: Promise<boolean> | null = null;

/** 读预录帧并交给 UI 线程。读不到回 false：开屏照样能播，只是退回逐帧实时画（慢一些） */
export function loadRouteFrames(): Promise<boolean> {
  loading ??= (async () => {
    try {
      const asset = Asset.fromModule(
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- 资源文件只能这样引（Metro 按扩展名打包，见 metro.config.js）
        require("@/assets/splash/route-frames.skpack"),
      );
      await asset.downloadAsync();
      if (!asset.localUri) return false;
      const file = await new File(asset.localUri).bytes();
      const head = parseRouteFrames(file);
      if (!head) return false;
      scheduleOnUI(installRouteFrames, file, head);
      return true;
    } catch {
      return false;
    }
  })();
  return loading;
}

function installRouteFrames(file: Uint8Array, head: RouteFramesHeader): void {
  "worklet";
  (globalThis as unknown as FramesGlobal).__splashFrames = {
    count: head.count,
    fps: head.fps,
    height: head.height,
    lastStory: head.lastStory,
    offsets: head.offsets,
    file,
    at: -1,
    picture: null,
  };
}

/** 预录帧录的时候画面有多高（282 宽的单位）；还没读进来是 0 */
export function routeFramesHeight(): number {
  "worklet";
  return (globalThis as unknown as FramesGlobal).__splashFrames?.height ?? 0;
}

/** 第 i 帧（开播前预热用：先把几帧有代表性的画一遍，见 route-scene-view） */
export function routeFrame(i: number): SkPicture | null {
  "worklet";
  const g = globalThis as unknown as FramesGlobal;
  const F = g.__splashFrames;
  if (!F) return null;
  if (i < 0 || i >= F.count) return null;
  if (i !== F.at) {
    const base = F.file.byteOffset;
    // MakePicture 读的是整块缓冲区，所以每帧要单独切一份给它
    const picture = Skia.Picture.MakePicture(
      F.file.buffer.slice(
        base + F.offsets[i],
        base + F.offsets[i + 1],
      ) as ArrayBuffer,
    );
    if (!picture) {
      // 图片格式跟着 Skia 版本走：升级了 Skia 没重录就会这样。放掉，后面都实时画
      g.__splashFrames = undefined;
      console.warn(
        "[splash] 预录的路线帧读不出来，已退回实时画；请重跑 scripts/build-splash-frames.ts",
      );
      return null;
    }
    F.at = i;
    F.picture = picture;
  }
  return F.picture;
}

/**
 * 真实时间（毫秒）这一刻该播的那一帧。没有就返回 null（还没读进来、过了最后一帧、或者这台手机读不出来），
 * 调用方改为实时画。
 */
export function routeFrameAt(real: number): SkPicture | null {
  "worklet";
  const F = (globalThis as unknown as FramesGlobal).__splashFrames;
  return F ? routeFrame(Math.round((real * F.fps) / 1000)) : null;
}

export function releaseRouteFrames(): void {
  "worklet";
  (globalThis as unknown as FramesGlobal).__splashFrames = undefined;
}
