// 正式包里的开屏（__DEV__ 为假、也没设 EXPO_PUBLIC_SPLASH_LOG）：流程和开发包一样走完，但一行 [splash] 日志都不打——
// 帧数统计、视频备好 / 起步 / 报错 / 退回逐帧画这些只在开发包、或起 Metro 时专门打开量的时候才打。
// 打不打日志在模块加载时就定了，所以这里先把 __DEV__ 置假再加载 splash-overlay，加载完立刻放回。
// 替身和 splash-overlay.test.tsx 是同一套（只留这里用得到的）。
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { AccessibilityInfo, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { frameClock, pumpReactions } from "@/__tests__/helpers/native-mocks";
import {
  isHost,
  makeQueryClient,
  render,
  type Rendered,
} from "@/__tests__/helpers/render";
import { devicesApi } from "@/api/devices";
import { useLocaleStore } from "@/i18n";
import { launchedByNotification } from "@/services/launch-intent";
import { useAuthStore } from "@/stores/auth-store";
import { useLaunchMemoryStore } from "@/stores/launch-memory-store";
import { useThemeStore } from "@/stores/theme-store";
import { releaseSplashPage, splashStory } from "../bus";
import { loadRouteFrames } from "../route-frames";

jest.mock("react-native-reanimated", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reactiveReanimatedMock(),
);
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
jest.mock("@shopify/react-native-skia", () => ({ useImage: () => null }));
jest.mock("expo-image", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { Image: (props: Record<string, unknown>) => h("ExpoImage", props) };
});
jest.mock("expo-router", () => ({ usePathname: () => "/" }));
jest.mock("expo-splash-screen", () => ({
  hide: jest.fn(),
  hideAsync: jest.fn(() => Promise.resolve()),
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
jest.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
  AFTER_FIRST_UNLOCK: 0,
}));
jest.mock("@/services/fresh-install", () => ({
  clearIfFreshInstall: () => Promise.resolve(),
}));
jest.mock("@/api/devices", () => ({ devicesApi: { list: jest.fn() } }));
jest.mock("@/services/launch-intent", () => ({
  launchedByNotification: jest.fn(() => false),
}));
jest.mock("../use-hero-splash", () => ({ useHeroSplash: () => undefined }));
jest.mock("../landing-device", () => ({
  DeviceLanding: () => null,
  releaseDeviceLanding: jest.fn(),
}));
jest.mock("../route-frames", () => ({
  loadRouteFrames: jest.fn(() => Promise.resolve(true)),
}));
jest.mock("../route-scene-view", () => ({
  RouteSceneView: () => null,
  releaseRouteScene: jest.fn(),
}));
/** 安卓的视频层：ROUTE_VIDEO 由测试切；记下挂了几次、最后一次的回调；句柄由测试控制位置 */
const mockVideo = {
  on: false,
  mounts: 0,
  props: null as null | {
    onReady: () => void;
    onFail: (why?: string) => void;
  },
  position: 0,
  play: jest.fn(),
};
jest.mock("../route-video-layer", () => {
  const {
    createElement: h,
    useEffect,
    useImperativeHandle,
  } = jest.requireActual<typeof import("react")>("react");
  return {
    get ROUTE_VIDEO() {
      return mockVideo.on;
    },
    RouteVideoLayer: (props: {
      ref?: unknown;
      onReady: () => void;
      onFail: (why?: string) => void;
    }) => {
      mockVideo.props = props;
      useImperativeHandle(props.ref as never, () => ({
        play: () => mockVideo.play(),
        position: () => mockVideo.position,
      }));
      useEffect(() => {
        mockVideo.mounts += 1;
      }, []);
      return h("RouteVideoLayer");
    },
  };
});
jest.mock("../bus", () => {
  const actual = jest.requireActual<typeof import("../bus")>("../bus");
  return {
    ...actual,
    releaseSplashHold: jest.fn(),
    whenPageReady: jest.fn(() => Promise.resolve()),
    releaseSplashPage: jest.fn(() => actual.releaseSplashPage()),
  };
});

let SplashOverlay: ComponentType;
beforeAll(() => {
  const g = globalThis as { __DEV__?: boolean };
  const dev = g.__DEV__;
  const flag = process.env.EXPO_PUBLIC_SPLASH_LOG;
  // 置假之前先把 RN 的样式表加载好：这一下只该影响 splash-overlay 自己
  StyleSheet.flatten({});
  g.__DEV__ = false;
  delete process.env.EXPO_PUBLIC_SPLASH_LOG;
  try {
    SplashOverlay = (
      require("../splash-overlay") as typeof import("../splash-overlay")
    ).SplashOverlay;
  } finally {
    g.__DEV__ = dev;
    if (flag !== undefined) process.env.EXPO_PUBLIC_SPLASH_LOG = flag;
  }
});

const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const mount = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <SplashOverlay />
    </QueryClientProvider>,
  );
const overlays = (r: Rendered) =>
  r.root.findAll(
    (n) =>
      typeof n.type === "string" &&
      typeof n.props.onStartShouldSetResponder === "function",
  );
const shown = (r: Rendered) => overlays(r).length > 0;
const layout = (r: Rendered) => {
  act(() => {
    overlays(r)[0].props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } },
    });
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
};
const frame = (dt: number | null = 16) => {
  act(() => {
    frameClock.cb!({ timestamp: 0, timeSincePreviousFrame: dt });
    pumpReactions();
  });
};

let log: ReturnType<typeof jest.spyOn>;
let reduce: ReturnType<typeof jest.spyOn>;
/** 打过的 [splash] 日志 */
const splashLogs = () =>
  (log.mock.calls as unknown[][])
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("[splash]"));
beforeEach(() => {
  jest.useFakeTimers();
  mockVideo.on = false;
  mockVideo.mounts = 0;
  mockVideo.props = null;
  mockVideo.position = 0;
  frameClock.cb = null;
  frameClock.active = false;
  jest.requireActual<typeof import("../bus")>("../bus").releaseSplashPage();
  splashStory.set(-1);
  useLocaleStore.setState({ locale: "zh-CN" });
  useThemeStore.setState({ mode: "dark", hydrated: true });
  useAuthStore.setState({ hydrated: true, tokens: null, user: null } as never);
  useLaunchMemoryStore.setState({ hydrated: false, record: null });
  m(devicesApi.list).mockImplementation(() => new Promise(() => undefined));
  m(launchedByNotification).mockReturnValue(false);
  m(loadRouteFrames).mockImplementation(() => Promise.resolve(true));
  log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  reduce = jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockImplementation(() => Promise.resolve(false));
});
afterEach(() => {
  log.mockRestore();
  reduce.mockRestore();
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe("正式包：开屏不打日志", () => {
  it("视频路线段（还没备好时报错、换播放器重试，再备好、起步、对表）一路播到收场：流程照常，一行 [splash] 日志都没有", async () => {
    mockVideo.on = true;
    const r = mount();
    layout(r);
    act(() => mockVideo.props!.onFail("Unexpected runtime error"));
    expect(mockVideo.mounts).toBe(2);
    act(() => mockVideo.props!.onReady());
    await advance(300);
    expect(frameClock.active).toBe(true);
    frame();
    frame();
    frame();
    frame();
    expect(mockVideo.play).toHaveBeenCalledTimes(1);
    mockVideo.position = 400;
    await advance(5);
    frame(); // 对表
    for (let i = 0; i < 800 && !m(releaseSplashPage).mock.calls.length; i++)
      frame(30);
    expect(releaseSplashPage).toHaveBeenCalledTimes(1);
    await advance(50);
    expect(shown(r)).toBe(false);
    expect(splashLogs()).toEqual([]);
  });

  it("视频迟迟备不好、退回逐帧画：照样开播，也不打日志", async () => {
    mockVideo.on = true;
    const r = mount();
    layout(r);
    await advance(2600 + 1200);
    expect(r.root.findAll((n) => isHost(n, "RouteVideoLayer"))).toHaveLength(0);
    expect(frameClock.active).toBe(true);
    for (let i = 0; i < 6; i++) frame();
    expect(splashStory.get()).toBeGreaterThan(0);
    expect(splashLogs()).toEqual([]);
  });
});
