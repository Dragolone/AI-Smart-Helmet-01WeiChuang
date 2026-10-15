// 开屏路线段的视频层：安卓用预渲染视频（静音、不抢声音焦点、停在第一帧等时钟起步），iOS 这一层什么都不渲染。
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { createRef } from "react";
import { act } from "react-test-renderer";

import { isHost, render } from "@/__tests__/helpers/render";
import * as AndroidLayer from "../route-video-layer.android";

type Player = {
  muted?: boolean;
  loop?: boolean;
  audioMixingMode?: string;
  keepScreenOnWhilePlaying?: boolean;
  status: string;
  currentTime: number;
  play: jest.Mock;
  pause: jest.Mock;
};
const mockPlayer: { current: Player } = {
  current: {
    status: "idle",
    currentTime: 0,
    play: jest.fn(),
    pause: jest.fn(),
  },
};
const mockListeners: Record<
  string,
  (e: { status: string; error?: { message: string } }) => void
> = {};
jest.mock("expo-video", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return {
    useVideoPlayer: (_src: unknown, setup: (p: Player) => void) => {
      setup(mockPlayer.current);
      return mockPlayer.current;
    },
    VideoView: (props: Record<string, unknown>) =>
      createElement("VideoView", props),
  };
});
jest.mock("expo", () => ({
  useEventListener: (
    _p: unknown,
    name: string,
    l: (e: { status: string }) => void,
  ) => {
    mockListeners[name] = l;
  },
}));

// 非安卓那一份：lint 的解析器会把 "../route-video-layer" 解析到 .android 那个文件、报重复导入，这里用 requireActual 取
const DefaultLayer = jest.requireActual<typeof import("../route-video-layer")>(
  "../route-video-layer",
);

afterEach(() => {
  mockPlayer.current = {
    status: "idle",
    currentTime: 0,
    play: jest.fn(),
    pause: jest.fn(),
  };
});

describe("路线段视频层", () => {
  it("非安卓：不用视频、什么都不渲染", () => {
    expect(DefaultLayer.ROUTE_VIDEO).toBe(false);
    const r = render(
      <DefaultLayer.RouteVideoLayer
        onReady={() => undefined}
        onFail={() => undefined}
      />,
    );
    expect(r.tree.toJSON()).toBeNull();
  });

  it("安卓：静音、不循环、和别的声音混着放（对讲 / 求救提示音不被打断）、不常亮、先停在第一帧", () => {
    expect(AndroidLayer.ROUTE_VIDEO).toBe(true);
    const onReady = jest.fn();
    const r = render(
      <AndroidLayer.RouteVideoLayer
        onReady={onReady}
        onFail={() => undefined}
      />,
    );
    const p = mockPlayer.current;
    expect([
      p.muted,
      p.loop,
      p.audioMixingMode,
      p.keepScreenOnWhilePlaying,
    ]).toEqual([true, false, "mixWithOthers", false]);
    expect(p.pause).toHaveBeenCalled();
    const view = r.root.find((n) => isHost(n, "VideoView")).props;
    expect(view).toMatchObject({
      contentFit: "cover",
      nativeControls: false,
      surfaceType: "surfaceView",
      pointerEvents: "none",
    });
    (view.onFirstFrameRender as () => void)();
    expect(onReady).toHaveBeenCalled();
  });

  it("放不了：播放器报错时带上原因；一搭上就已经是错误状态也要报", () => {
    const onFail = jest.fn();
    render(
      <AndroidLayer.RouteVideoLayer
        onReady={() => undefined}
        onFail={onFail}
      />,
    );
    act(() =>
      mockListeners.statusChange({
        status: "error",
        error: { message: "decoder" },
      }),
    );
    expect(onFail).toHaveBeenCalledWith("decoder");
    act(() => mockListeners.statusChange({ status: "readyToPlay" }));
    expect(onFail).toHaveBeenCalledTimes(1);
    mockPlayer.current = {
      status: "error",
      currentTime: 0,
      play: jest.fn(),
      pause: jest.fn(),
    };
    const onFail2 = jest.fn();
    render(
      <AndroidLayer.RouteVideoLayer
        onReady={() => undefined}
        onFail={onFail2}
      />,
    );
    expect(onFail2).toHaveBeenCalledWith();
  });

  it("句柄：开播、读当前毫秒；播放器已经放掉读不到时给 -1", () => {
    const ref = createRef<AndroidLayer.RouteVideoHandle>();
    render(
      <AndroidLayer.RouteVideoLayer
        ref={ref}
        onReady={() => undefined}
        onFail={() => undefined}
      />,
    );
    mockPlayer.current.currentTime = 1.25;
    ref.current!.play();
    expect(mockPlayer.current.play).toHaveBeenCalled();
    expect(ref.current!.position()).toBe(1250);
    Object.defineProperty(mockPlayer.current, "currentTime", {
      get() {
        throw new Error("released");
      },
    });
    expect(ref.current!.position()).toBe(-1);
  });
});
