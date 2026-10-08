// 路线段的视频层：只有安卓有（route-video-layer.android.tsx）。其它平台路线段是画布自己画的，这里什么都不渲染。
// 分成两个文件是为了让 iOS 的代码里根本不出现 expo-video。
import type { Ref } from "react";

/** 这个平台的路线段是不是用视频播 */
export const ROUTE_VIDEO = false;

export type RouteVideoHandle = {
  play: () => void;
  /** 视频此刻放到第几毫秒；读不到是 -1 */
  position: () => number;
};

export function RouteVideoLayer(_props: {
  ref?: Ref<RouteVideoHandle>;
  /** 视频的第一帧已经显示出来（可以开播了） */
  onReady: () => void;
  /** 视频放不了（文件读不到、这台手机解不了）；带上播放器给的原因 */
  onFail: (why?: string) => void;
}) {
  return null;
}
