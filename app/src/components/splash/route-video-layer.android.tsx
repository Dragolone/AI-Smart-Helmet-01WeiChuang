// 安卓上的路线段：一段预渲染的视频（assets/splash/route-video.mp4），铺满屏幕，垫在开屏的其它东西下面。
// 为什么安卓用视频、文件怎么来的：见 route-video-format.ts 和 scripts/build-splash-video.ts。
// 这一层一搭上就把视频读好、停在第一帧（一片底色），开屏的时钟起步时才放；放的时候没有声音，
// 也不抢别的声音的焦点（这个 App 里正在响的可能是对讲或求救提示音）。
import { useEventListener } from "expo";
import { VideoView, useVideoPlayer } from "expo-video";
import { useEffect, useImperativeHandle, type Ref } from "react";
import { StyleSheet } from "react-native";

export const ROUTE_VIDEO = true;

export type RouteVideoHandle = {
  play: () => void;
  /** 视频此刻放到第几毫秒；读不到是 -1 */
  position: () => number;
};

export function RouteVideoLayer({
  ref,
  onReady,
  onFail,
}: {
  ref?: Ref<RouteVideoHandle>;
  /** 视频的第一帧已经显示出来（可以开播了） */
  onReady: () => void;
  /** 视频放不了（文件读不到、这台手机解不了）；带上播放器给的原因 */
  onFail: (why?: string) => void;
}) {
  const player = useVideoPlayer(
    require("@/assets/splash/route-video.mp4"),
    (p) => {
      p.muted = true;
      p.loop = false;
      p.audioMixingMode = "mixWithOthers";
      p.keepScreenOnWhilePlaying = false;
      p.pause();
    },
  );
  useEventListener(player, "statusChange", ({ status, error }) => {
    if (status === "error") onFail(error?.message);
  });
  // 文件一上来就读不到时，出错的那一下可能早于上面的监听挂上（模拟器上试过，白等了一个超时）；搭好时再看一眼
  useEffect(() => {
    if (player.status === "error") onFail();
  }, [player, onFail]);
  useImperativeHandle(
    ref,
    () => ({
      play: () => player.play(),
      position: () => {
        try {
          return player.currentTime * 1000;
        } catch {
          // 这一层已经卸掉、播放器放掉了
          return -1;
        }
      },
    }),
    [player],
  );
  return (
    <VideoView
      player={player}
      pointerEvents="none"
      style={styles.fill}
      // 视频比屏幕高：铺满宽度，上下居中裁掉
      contentFit="cover"
      nativeControls={false}
      allowsPictureInPicture={false}
      // 用系统单独合成的那种表面（SurfaceView）：每一帧由系统按它该出现的时刻送上屏幕，App 的主线程忙不忙
      // 都不影响它；它垫在窗口后面，开屏的其它东西（商标、文字、画布）都画在它上面。
      // 另一种（textureView）是 App 自己把视频当一张贴图画，播放器提前送来的帧会被挤掉或重复：
      // 模拟器上 2.4 秒的路线段里有 7–13 帧重复（2026-10-08 逐帧量的），所以不用。
      // 注意：安卓模拟器合成 SurfaceView 的视频时不做色彩范围换算，这一段的底色会偏亮（14,15,18 显示成 27,29,31），
      // 开头和成标那一刻各跳一下——那是模拟器的毛病，看效果以真机为准
      surfaceType="surfaceView"
      onFirstFrameRender={onReady}
    />
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill },
});
