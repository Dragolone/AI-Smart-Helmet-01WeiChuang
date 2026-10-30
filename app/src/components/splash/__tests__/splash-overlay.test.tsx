// 开屏遮罩（splash-overlay）的编排：什么时候不播 / 立刻让开（通知拉起、求救页、看门狗）、开播前等什么、
// 时钟怎么走（起步前等画面稳、卡顿时一帧最多走 50ms、没定落位时停在商标上）、按登录态和设备列表落到哪种页面、
// 页面上被代画的东西何时藏起 / 交还、播完整层卸掉；安卓的视频路线段（等第一帧、跟着视频对表、重试与退回逐帧画）。
// 只测不改：遮罩挡着整个 App，和求救页的让位直接相关。
// 逐帧回调和动画反应换成「会反应」的替身：测试自己走帧，每帧后像 UI 线程那样过一遍反应；画布 / 落位 / 视频层换成占位。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import type { DevicePublic } from "@helmet/shared";
import * as SplashScreen from "expo-splash-screen";
import { AccessibilityInfo, Dimensions } from "react-native";
import { act } from "react-test-renderer";
import { frameClock, pumpReactions } from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  makeQueryClient,
  render,
  type Rendered,
} from "@/__tests__/helpers/render";
import { devicesApi } from "@/api/devices";
import { translate, useLocaleStore } from "@/i18n";
import { launchedByNotification } from "@/services/launch-intent";
import { SECURE_KEYS } from "@/services/secure-keys";
import { useAuthStore } from "@/stores/auth-store";
import { useLaunchMemoryStore } from "@/stores/launch-memory-store";
import { useThemeStore } from "@/stores/theme-store";
import {
  anchorOwned,
  anchorRect,
  arriveFrom,
  guideFrom,
  headerFrom,
  releaseSplashHold,
  releaseSplashPage,
  splashOn,
  splashStory,
  whenPageReady,
} from "../bus";
import { isSplashCovering } from "../covering";
import { releaseDeviceLanding } from "../landing-device";
import { DEVICE, LOGIN, UNBOUND, loginReveal } from "../landings";
import { loadRouteFrames } from "../route-frames";
import { LOGIN_BRAND } from "../login-brand";
import {
  MARK_LIFT,
  MARK_SIZE,
  SCENE_BG,
  SCENE_T,
  SCENE_W,
  type MarkGlow,
} from "../route-scene";
import { releaseRouteScene } from "../route-scene-view";
import { VIDEO_HANDOVER, VIDEO_PRE_MS } from "../route-video-format";
import { SplashOverlay } from "../splash-overlay";
import { MARK_DONE, STORY_TOTAL, buildWarp, storyAt } from "../timeline";

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
/** 当前路径：可订阅的小仓库，改了会让用到它的组件重渲染（和真的路由一样） */
const mockPath = {
  value: "/",
  subs: new Set<() => void>(),
  set(v: string) {
    this.value = v;
    this.subs.forEach((f) => f());
  },
};
jest.mock("expo-router", () => {
  const { useSyncExternalStore } =
    jest.requireActual<typeof import("react")>("react");
  return {
    usePathname: () =>
      useSyncExternalStore(
        (f: () => void) => {
          mockPath.subs.add(f);
          return () => mockPath.subs.delete(f);
        },
        () => mockPath.value,
      ),
  };
});
jest.mock("expo-splash-screen", () => ({
  hide: jest.fn(),
  hideAsync: jest.fn(() => Promise.resolve()),
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-status-bar", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return {
    StatusBar: (props: Record<string, unknown>) => h("StatusBar", props),
  };
});
const mockKv = new Map<string, string>();
/** 钥匙串读得慢：wait 不为空时读要等它 */
const mockKvGate: { wait: Promise<void> | null } = { wait: null };
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => {
    if (mockKvGate.wait) await mockKvGate.wait;
    return mockKv.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => {
    mockKv.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    mockKv.delete(k);
  },
  AFTER_FIRST_UNLOCK: 0,
}));
// 重装检查（iOS 重装后清钥匙串）当作已经做完：这里只看开屏本身
jest.mock("@/services/fresh-install", () => ({
  clearIfFreshInstall: () => Promise.resolve(),
}));
jest.mock("@/api/devices", () => ({ devicesApi: { list: jest.fn() } }));
jest.mock("@/services/launch-intent", () => ({
  launchedByNotification: jest.fn(() => false),
}));
const mockHero = { value: undefined as unknown, boom: false };
jest.mock("../use-hero-splash", () => ({
  useHeroSplash: () => {
    if (mockHero.boom) throw new Error("hero boom");
    return mockHero.value;
  },
}));
jest.mock("../landing-device", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return {
    DeviceLanding: (props: Record<string, unknown>) =>
      h("DeviceLanding", props),
    releaseDeviceLanding: jest.fn(),
  };
});
jest.mock("../route-frames", () => ({
  loadRouteFrames: jest.fn(() => Promise.resolve(true)),
}));
jest.mock("../route-scene-view", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return {
    RouteSceneView: (props: Record<string, unknown>) =>
      h("RouteSceneView", props),
    releaseRouteScene: jest.fn(),
  };
});
/** 安卓的视频层：可控的替身。ROUTE_VIDEO 由测试切；记下挂了几次、最后一次的回调；句柄由测试控制位置 */
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
/** 页面搭好没有：默认已经搭好；要「一直没搭好」的用例换成不回的 Promise */
const mockPage = { ready: () => Promise.resolve() };
jest.mock("../bus", () => {
  const actual = jest.requireActual<typeof import("../bus")>("../bus");
  return {
    ...actual,
    releaseSplashHold: jest.fn(),
    whenPageReady: jest.fn(() => mockPage.ready()),
    releaseSplashPage: jest.fn(() => actual.releaseSplashPage()),
    endSplashStory: jest.fn(() => actual.endSplashStory()),
  };
});

const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const warp = buildWarp();
const dev = (id: string) => ({ deviceId: id, name: null }) as DevicePublic;

const mount = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <SplashOverlay />
    </QueryClientProvider>,
  );
/** 遮罩最外层（挡触摸、排版完开播的那块） */
const overlays = (r: Rendered) =>
  r.root.findAll(
    (n) =>
      typeof n.type === "string" &&
      typeof n.props.onStartShouldSetResponder === "function",
  );
const shown = (r: Rendered) => overlays(r).length > 0;
const hosts = (r: Rendered, name: string) =>
  r.root.findAll((n) => isHost(n, name));
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
/** 走一帧：喊逐帧回调，然后像 UI 线程那样过一遍反应 */
const frame = (dt: number | null = 16) => {
  act(() => {
    frameClock.cb!({ timestamp: 0, timeSincePreviousFrame: dt });
    pumpReactions();
  });
};
/** 一帧帧走，直到 stop(故事时间) 成立（最多 max 帧） */
const runUntil = (stop: (s: number) => boolean, dt = 16, max = 800) => {
  for (let i = 0; i < max && !stop(splashStory.get()); i++) frame(dt);
  if (!stop(splashStory.get()))
    throw new Error(`走了 ${max} 帧还没到（故事时间 ${splashStory.get()}）`);
};
/** 开播：排版 → 等完开播前的那些 → 起步前那几帧稳定帧 */
const start = async (r: Rendered) => {
  layout(r);
  await advance(1200);
  expect(frameClock.active).toBe(true);
  frame();
  frame();
  frame();
};
/** 播到收场（页面上的东西放回），再过两帧这一层自己卸掉 */
const playToEnd = async () => {
  runUntil(() => m(releaseSplashPage).mock.calls.length > 0, 16, 600);
  await advance(50);
};
/** 这一层里写着的字（含此刻透明的：品牌名开头是淡入前的样子） */
const words = (r: Rendered) =>
  r.root.findAll((n) => isHost(n, "Text")).map((n) => n.children.join(""));
/**
 * 挂上并留着同一个查询客户端。逐帧的样式在渲染时求值（替身里没有 UI 线程），
 * 走完几帧之后 refresh() 再渲染一次，看到的就是这一刻的样子
 */
const mountKeep = () => {
  const qc = makeQueryClient();
  const el = () => (
    <QueryClientProvider client={qc}>
      <SplashOverlay />
    </QueryClientProvider>
  );
  const r = render(el());
  return { r, refresh: () => r.rerender(el()) };
};
/** 屏幕上的几个基准：k = 屏宽 / 282，商标中心 (cx, cy)，商标边长 size */
const geometry = () => {
  const { width, height } = Dimensions.get("window");
  const k = width / SCENE_W;
  return {
    width,
    k,
    cx: width / 2,
    cy: height / 2 - MARK_LIFT * k,
    size: MARK_SIZE * k,
  };
};
/** 商标那张原图所在的方块（宽 = 商标边长）的样式 */
const markStyle = (r: Rendered) =>
  flat(
    r.root.find(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).width === geometry().size &&
        n.findAll((c) => isHost(c, "ExpoImage")).length > 0,
    ).props.style,
  );
/** 写着 text 的那一行字的样式 */
const textStyle = (r: Rendered, text: string) =>
  flat(
    r.root.find((n) => isHost(n, "Text") && n.children.join("") === text).props
      .style,
  );
/** 画布这一刻拿到的光的位置（渲染时求的值） */
const glowNow = (r: Rendered) =>
  (hosts(r, "RouteSceneView")[0].props.glow as { get: () => MarkGlow }).get();

let log: ReturnType<typeof jest.spyOn>;
/** 开发包里打过一行这样的日志 */
const logged = (pattern: RegExp) =>
  (log.mock.calls as unknown[][]).some((c) => pattern.test(String(c[0])));
let reduce: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  jest.useFakeTimers();
  mockPath.value = "/";
  mockPage.ready = () => Promise.resolve();
  mockVideo.on = false;
  mockVideo.mounts = 0;
  mockVideo.props = null;
  mockVideo.position = 0;
  mockHero.value = undefined;
  mockKv.clear();
  mockKvGate.wait = null;
  m(loadRouteFrames).mockImplementation(() => Promise.resolve(true));
  frameClock.cb = null;
  frameClock.active = false;
  // 上一个用例留下的公共值放回「不参与」
  jest.requireActual<typeof import("../bus")>("../bus").releaseSplashPage();
  splashStory.set(-1);
  // 页面量到的位置也是公共的：每条用例从「还没量到」起
  for (const a of Object.values(anchorRect)) a.set(null);
  useLocaleStore.setState({ locale: "zh-CN" });
  useThemeStore.setState({ mode: "dark", hydrated: true });
  useAuthStore.setState({
    hydrated: true,
    tokens: null,
    user: null,
  } as never);
  useLaunchMemoryStore.setState({ hydrated: false, record: null });
  m(devicesApi.list).mockImplementation(() => new Promise(() => undefined));
  m(launchedByNotification).mockReturnValue(false);
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
const signIn = () =>
  useAuthStore.setState({
    tokens: { accessToken: "a", refreshToken: "r" },
    user: { id: "u1" },
  } as never);

describe("不播 / 立刻让开", () => {
  it("由通知拉起（多半是求救提醒）：排版后收掉原生启动图、直接收场，不播路线、也不建视频播放器", async () => {
    mockVideo.on = true;
    m(launchedByNotification).mockReturnValue(true);
    const r = mount();
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(0);
    expect(overlays(r)[0].props.onStartShouldSetResponder()).toBe(true);
    layout(r);
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
    expect(releaseSplashHold).toHaveBeenCalled();
    expect(releaseSplashPage).toHaveBeenCalled();
    expect(frameClock.active).toBe(false);
    // 页面上的东西先露出来，隔两帧再卸掉这一层
    expect(shown(r)).toBe(true);
    await advance(50);
    expect(shown(r)).toBe(false);
    expect(releaseRouteScene).toHaveBeenCalled();
    expect(releaseDeviceLanding).toHaveBeenCalled();
    expect(mockVideo.mounts).toBe(0);
    expect(loadRouteFrames).not.toHaveBeenCalled();
    expect(splashStory.get()).toBe(-1);
    // 卸掉了，App 自己的提示框不用再等
    expect(isSplashCovering()).toBe(false);
  });

  it("窗口放不下（横着拿的展开折叠屏 / 平板，O32）：和由通知拉起一样不播，不建视频播放器、直接收场", async () => {
    mockVideo.on = true;
    const real = Dimensions.get("window");
    const dims = jest
      .spyOn(Dimensions, "get")
      .mockReturnValue({ ...real, width: 841, height: 701 });
    try {
      const r = mount();
      expect(hosts(r, "RouteVideoLayer")).toHaveLength(0);
      layout(r);
      expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
      expect(releaseSplashPage).toHaveBeenCalled();
      expect(frameClock.active).toBe(false);
      await advance(50);
      expect(shown(r)).toBe(false);
      expect(loadRouteFrames).not.toHaveBeenCalled();
      expect(splashStory.get()).toBe(-1);
    } finally {
      dims.mockRestore();
    }
  });

  it("竖着拿的展开折叠屏（0.83）照播", async () => {
    const real = Dimensions.get("window");
    const dims = jest
      .spyOn(Dimensions, "get")
      .mockReturnValue({ ...real, width: 701, height: 841 });
    try {
      const r = mount();
      await start(r);
      expect(frameClock.active).toBe(true);
      expect(shown(r)).toBe(true);
    } finally {
      dims.mockRestore();
    }
  });

  it("开屏这一层自己抛错（10-21 夜测：设备列表回了不是数组的东西）：整层让开、放行页面、收掉原生启动图，不往上抛把 App 带崩", () => {
    const err = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockHero.boom = true;
    try {
      const r = mount();
      expect(shown(r)).toBe(false);
      expect(SplashScreen.hide).toHaveBeenCalled();
      expect(releaseSplashHold).toHaveBeenCalled();
      expect(releaseSplashPage).toHaveBeenCalled();
      expect(isSplashCovering()).toBe(false);
      expect(splashStory.get()).toBe(-1);
    } finally {
      mockHero.boom = false;
      err.mockRestore();
    }
  });

  it("以求救页冷启动（第一帧就在 /sos-active）：不等排版，收掉原生启动图并立刻卸掉", () => {
    mockPath.value = "/sos-active";
    const r = mount();
    expect(SplashScreen.hide).toHaveBeenCalled();
    expect(releaseSplashHold).toHaveBeenCalled();
    expect(shown(r)).toBe(false);
  });

  it("播到一半被带进求救页：立刻卸掉，不等收尾那两帧", async () => {
    const r = mount();
    await start(r);
    runUntil((s) => s > 600);
    act(() => mockPath.set("/sos-active?sosId=s1"));
    expect(shown(r)).toBe(false);
    expect(releaseSplashPage).toHaveBeenCalled();
  });

  it("看门狗：哪一步卡住了（这里连排版都没来），从出现算起 9 秒也必须让开", async () => {
    const r = mount();
    await advance(8999);
    expect(shown(r)).toBe(true);
    expect(isSplashCovering()).toBe(true);
    await advance(1);
    expect(releaseSplashHold).toHaveBeenCalled();
    await advance(50);
    expect(shown(r)).toBe(false);
    expect(isSplashCovering()).toBe(false);
  });
});

describe("开播前", () => {
  it("排版后收掉原生启动图，读预录帧并预热（底色盖着）；页面没搭好最多等 0.7 秒；开播时故事时间从 0 起", async () => {
    mockPage.ready = () => new Promise(() => undefined);
    const r = mount();
    // 最上面那层和原生启动画面同色的底：开播前一直盖着（下面在预热）
    const cover = () =>
      flat(
        (
          overlays(r)[0].children.at(-1) as unknown as {
            props: { style: unknown };
          }
        ).props.style,
      );
    expect(cover()).toMatchObject({ opacity: 1, backgroundColor: SCENE_BG });
    layout(r);
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
    expect(loadRouteFrames).toHaveBeenCalledTimes(1);
    expect(whenPageReady).toHaveBeenCalled();
    await advance(600);
    expect(frameClock.active).toBe(false);
    expect(splashOn.get()).toBe(0);
    await advance(600);
    expect(frameClock.active).toBe(true);
    expect(splashOn.get()).toBe(1);
    expect(splashStory.get()).toBe(0);
    // 预热放完，画布回到看故事时间
    const scene = hosts(r, "RouteSceneView")[0];
    expect((scene.props.warm as { get: () => number }).get()).toBe(-1);
    expect((scene.props.videoMode as { get: () => number }).get()).toBe(0);
    // 再排一次版不会再开一次
    layout(r);
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
  });

  it("起步前先等画面稳下来（连续 3 帧按时到）；慢帧、读不到间隔的帧都从头数；最多等 250ms", async () => {
    const r = mount();
    layout(r);
    await advance(1200);
    frame(16);
    frame(40); // 慢帧：重新数
    frame(16);
    frame(16);
    frame(null); // 读不到间隔：也重新数
    expect(splashStory.get()).toBe(0);
    frame(16);
    frame(16);
    frame(16);
    expect(splashStory.get()).toBe(0);
    frame(16);
    expect(splashStory.get()).toBeCloseTo(storyAt(warp, 16));
    r.unmount();

    // 一直不稳：等满 250ms 也起步
    const r2 = mount();
    layout(r2);
    await advance(1200);
    for (let i = 0; i < 5; i++) frame(60);
    expect(splashStory.get()).toBe(0);
    frame(16);
    expect(splashStory.get()).toBeGreaterThan(0);
  });
});

describe("没登录：落到登录页", () => {
  it("一开播就定落位：页面上的商标 / 标题先由这一层代画，页面内容跟着同一个时钟进场", async () => {
    const r = mount();
    await start(r);
    expect(anchorOwned.loginMark.get()).toBe(1);
    expect(anchorOwned.loginTitle.get()).toBe(1);
    expect(arriveFrom.get()).toBe(LOGIN.arriveFrom);
    // 中文界面：品牌名那一行就是登录页标题，不另叠一行
    expect(words(r)).toEqual(["ZERO-ONE INNOVATION", "零一智行"]);
  });

  it("时钟：卡了一下不把动画跳过去（一帧最多走 50ms）；商标成形那一刻放行页面；页面涌到顶时状态栏交还；播到 3850 整层卸掉", async () => {
    const r = mount();
    await start(r);
    frame(16);
    const s1 = splashStory.get();
    frame(200);
    expect(splashStory.get()).toBeCloseTo(storyAt(warp, 16 + 50));
    expect(splashStory.get()).toBeGreaterThan(s1);

    runUntil((s) => s >= SCENE_T.raster[1] - 20);
    expect(releaseSplashHold).not.toHaveBeenCalled();
    runUntil((s) => s >= SCENE_T.raster[1]);
    expect(releaseSplashHold).toHaveBeenCalledTimes(1);

    expect(hosts(r, "StatusBar")).toHaveLength(1);
    expect(hosts(r, "StatusBar")[0].props.style).toBe("light");
    runUntil((s) => loginReveal(s) > 0.93);
    expect(hosts(r, "StatusBar")).toHaveLength(0);

    runUntil((s) => s >= STORY_TOTAL.login - 40);
    expect(shown(r)).toBe(true);
    expect(releaseSplashPage).not.toHaveBeenCalled();
    // 盖着的整段里 App 自己的提示框 / Toast / Modal 都压着（splash/covering）；这一层卸掉才放
    expect(isSplashCovering()).toBe(true);
    await playToEnd();
    expect(shown(r)).toBe(false);
    expect(isSplashCovering()).toBe(false);
    expect(releaseSplashPage).toHaveBeenCalledTimes(1);
    expect(anchorOwned.loginMark.get()).toBe(0);
    expect(arriveFrom.get()).toBe(-1);
    expect(splashOn.get()).toBe(0);
    // 卸掉之后故事时间才归位
    expect(splashStory.get()).toBe(-1);
    // 开发包里打一行帧数统计
    expect(logged(/^\[splash\] \d+ 帧/)).toBe(true);
    // 画布卸掉
    expect(releaseRouteScene).toHaveBeenCalled();
  });

  it("英文界面：品牌名那行仍写「零一智行」，落位时另叠一行英文的页面标题", async () => {
    useLocaleStore.setState({ locale: "en" });
    const r = mount();
    await start(r);
    const title = translate("auth.appName", undefined, "en");
    expect(/[一-鿿]/.test(title)).toBe(false);
    expect(words(r)).toEqual(["ZERO-ONE INNOVATION", "零一智行", title]);
  });
});

describe("已登录：等到商标快完成再定", () => {
  it("有头盔：1500 之前不定，之后落到设备页；商标成形后搭落位画布，扫描交棒后卸掉路线画布、页面大图渐渐接手；记下这个账号有头盔", async () => {
    signIn();
    mockHero.value = { image: 1, battery: 80 };
    m(devicesApi.list).mockImplementation(() => Promise.resolve([dev("h1")]));
    const r = mount();
    await start(r);
    expect(useLaunchMemoryStore.getState().record).toEqual({
      userId: "u1",
      hasHelmet: true,
    });
    runUntil((s) => s >= 1480);
    expect(anchorOwned.hero.get()).toBe(0);
    expect(arriveFrom.get()).toBe(-1);
    runUntil((s) => s >= 1500);
    frame();
    expect(anchorOwned.hero.get()).toBe(1);
    expect(arriveFrom.get()).toBe(DEVICE.arriveFrom);
    expect(headerFrom.get()).toBe(DEVICE.arriveFrom);
    expect(hosts(r, "DeviceLanding")).toHaveLength(0);
    runUntil((s) => s >= SCENE_T.raster[1]);
    const landing = hosts(r, "DeviceLanding");
    expect(landing).toHaveLength(1);
    expect(landing[0].props.hero).toBe(mockHero.value);

    runUntil((s) => s > DEVICE.hand + 20);
    expect(hosts(r, "StatusBar")).toHaveLength(0);
    expect(hosts(r, "RouteSceneView")).toHaveLength(1);
    runUntil((s) => s > DEVICE.hand + 260);
    expect(hosts(r, "RouteSceneView")).toHaveLength(0);

    runUntil((s) => s > DEVICE.give + 100);
    const mid = anchorOwned.hero.get();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    runUntil((s) => s > DEVICE.give + 200);
    expect(anchorOwned.hero.get()).toBe(0);
    await playToEnd();
    expect(shown(r)).toBe(false);
    expect(splashStory.get()).toBe(-1);
  });

  it("开屏时按了 Home：回前台时看门狗先收场、定落点的反应才到，页面不能再被藏起来（2026-10-30 安卓模拟器：设备页只剩名字和状态）", async () => {
    signIn();
    mockHero.value = { image: 1, battery: 80 };
    m(devicesApi.list).mockImplementation(() => Promise.resolve([dev("h1")]));
    const r = mount();
    await start(r);
    runUntil((s) => s >= 1480);
    // 时钟走过了定落点的时刻，但反应还排着（后台时 UI 线程和 JS 线程都停着）
    act(() => {
      for (let i = 0; i < 4; i++) {
        frameClock.cb!({ timestamp: 0, timeSincePreviousFrame: 16 });
      }
    });
    // 走到看门狗刚收场、卸掉这一层的那两帧还没走完
    await advance(7000);
    for (let i = 0; i < 2100 && !m(releaseSplashPage).mock.calls.length; i++) {
      await advance(1);
    }
    expect(m(releaseSplashPage).mock.calls.length).toBe(1);
    expect(shown(r)).toBe(true);
    // 这时排着的反应才到：定落点不能再把页面藏起来
    act(() => pumpReactions());
    await advance(0);
    expect(arriveFrom.get()).toBe(-1);
    await advance(50);
    expect(shown(r)).toBe(false);
    expect(arriveFrom.get()).toBe(-1);
    expect(headerFrom.get()).toBe(-1);
    expect(anchorOwned.hero.get()).toBe(0);
    expect(hosts(r, "DeviceLanding")).toHaveLength(0);
  });

  it("设备列表还没回来：照本机记住的上次结果（没头盔）落到引导页，卡片从商标的位置立起来", async () => {
    signIn();
    useLaunchMemoryStore.setState({
      hydrated: true,
      record: { userId: "u1", hasHelmet: false },
    });
    const r = mount();
    await start(r);
    runUntil((s) => s >= 1500);
    frame();
    expect(anchorOwned.guideEmblem.get()).toBe(1);
    expect(guideFrom.get()).toBe(UNBOUND.start);
    expect(headerFrom.get()).toBe(UNBOUND.start + UNBOUND.header);
    runUntil((s) => s > UNBOUND.start + 180);
    expect(hosts(r, "RouteSceneView")).toHaveLength(0);
    expect(hosts(r, "StatusBar")).toHaveLength(0);
    // 商标落到卡片左上角之后换成页面上那枚真的徽标
    runUntil((s) => s > UNBOUND.start + UNBOUND.swap + 130);
    expect(anchorOwned.guideEmblem.get()).toBe(0);
    await playToEnd();
    expect(shown(r)).toBe(false);
  });

  it("别的账号的记录不算；没有记录：停在商标上（时钟不过 1600），最多 1 秒，然后直接淡出（不做落位）", async () => {
    signIn();
    useLaunchMemoryStore.setState({
      hydrated: true,
      record: { userId: "someone-else", hasHelmet: true },
    });
    const r = mount();
    await start(r);
    runUntil((s) => s >= MARK_DONE);
    for (let i = 0; i < 30; i++) frame();
    expect(splashStory.get()).toBe(MARK_DONE);
    expect(anchorOwned.hero.get()).toBe(0);
    expect(anchorOwned.guideEmblem.get()).toBe(0);
    await advance(999);
    frame();
    expect(splashStory.get()).toBe(MARK_DONE);
    await advance(1);
    frame();
    frame();
    expect(splashStory.get()).toBeGreaterThan(MARK_DONE);
    runUntil((s) => s > 2000 + 90);
    expect(hosts(r, "StatusBar")).toHaveLength(0);
    runUntil((s) => s >= STORY_TOTAL.plain - 40);
    expect(shown(r)).toBe(true);
    await playToEnd();
    expect(shown(r)).toBe(false);
  });

  it("设备列表回来是空的：落到引导页，并记下这个账号没头盔", async () => {
    signIn();
    m(devicesApi.list).mockImplementation(() => Promise.resolve([]));
    const r = mount();
    await start(r);
    expect(useLaunchMemoryStore.getState().record).toEqual({
      userId: "u1",
      hasHelmet: false,
    });
    runUntil((s) => s >= 1500);
    frame();
    expect(guideFrom.get()).toBe(UNBOUND.start);
  });
});

describe("减弱动态效果", () => {
  it("系统开了减弱动态效果：不播路线，从商标完成那一刻起，停一下就淡出", async () => {
    reduce.mockImplementation(() => Promise.resolve(true));
    const r = mount();
    layout(r);
    await advance(1200);
    expect(splashStory.get()).toBe(MARK_DONE);
    frame();
    frame();
    frame();
    frame();
    expect(splashStory.get()).toBeGreaterThan(MARK_DONE);
    // 没登录也不落到登录页
    expect(anchorOwned.loginMark.get()).toBe(0);
    runUntil((s) => s >= STORY_TOTAL.plain - 40);
    await playToEnd();
    expect(shown(r)).toBe(false);
  });

  it("读不出这项设置按没开处理", async () => {
    reduce.mockImplementation(() => Promise.reject(new Error("no")));
    const r = mount();
    layout(r);
    await advance(1200);
    expect(splashStory.get()).toBe(0);
  });
});

describe("安卓：路线段播视频", () => {
  const sceneVideoMode = (r: Rendered) =>
    (
      hosts(r, "RouteSceneView")[0].props.videoMode as {
        get: () => number;
      }
    ).get();

  it("等视频第一帧出来才开播；时钟先叫视频放、等它报回位置再对表，线还在动的那段卡了按实际时间走；画布接手后记为放完", async () => {
    mockVideo.on = true;
    const r = mount();
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(1);
    expect(sceneVideoMode(r)).toBe(1);
    layout(r);
    await advance(2000);
    expect(frameClock.active).toBe(false);
    act(() => mockVideo.props!.onReady());
    await advance(300);
    expect(frameClock.active).toBe(true);
    // 视频模式下不读预录帧
    expect(loadRouteFrames).not.toHaveBeenCalled();
    frame();
    frame();
    frame();
    frame();
    expect(mockVideo.play).toHaveBeenCalledTimes(1);
    // 视频刚起步报的位置不准：到 70ms 才对表
    mockVideo.position = 40;
    await advance(0);
    frame();
    expect(splashStory.get()).toBe(0);
    mockVideo.position = 400;
    await advance(5);
    frame(); // 对表：时钟落到视频此刻的位置减去正片前垫的那段（400 − 200），这一帧不走
    expect(splashStory.get()).toBe(0);
    frame(16);
    const s = splashStory.get();
    expect(s).toBeGreaterThanOrEqual(storyAt(warp, 400 - VIDEO_PRE_MS + 16));
    expect(s).toBeLessThanOrEqual(storyAt(warp, 400 - VIDEO_PRE_MS + 16 + 5));
    // 线还在动：卡 200ms 就走 200ms（视频不等人）
    runUntil((t) => t > 300);
    const before = splashStory.get();
    frame(200);
    expect(splashStory.get()).toBeCloseTo(
      storyAt(warp, warpReal(before) + 200),
      3,
    );
    expect(mockVideo.play).toHaveBeenCalledTimes(1);
    // 商标成形（原图盖满）之后照旧一帧最多 50ms
    runUntil((t) => t >= SCENE_T.raster[1] + 5);
    const after = splashStory.get();
    frame(200);
    expect(splashStory.get()).toBeCloseTo(after + 50, 0);
    runUntil((t) => t > MARK_DONE + VIDEO_HANDOVER + 61);
    await playToEnd();
    expect(logged(/路线段播视频/)).toBe(true);
  });

  it("视频还没备好就报错：换播放器重试两次，第三次退回逐帧画（读预录帧、画布接手、不再叫视频放）", async () => {
    mockVideo.on = true;
    const r = mount();
    layout(r);
    act(() => mockVideo.props!.onFail("Unexpected runtime error"));
    expect(mockVideo.mounts).toBe(2);
    act(() => mockVideo.props!.onFail());
    expect(mockVideo.mounts).toBe(3);
    act(() => mockVideo.props!.onFail("again"));
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(0);
    expect(loadRouteFrames).toHaveBeenCalled();
    await advance(1500);
    expect(sceneVideoMode(r)).toBe(0);
    expect(frameClock.active).toBe(true);
    frame();
    frame();
    frame();
    frame();
    frame();
    expect(mockVideo.play).not.toHaveBeenCalled();
    expect(splashStory.get()).toBeGreaterThan(0);
    // 已经放弃的视频再报错：不理
    act(() => mockVideo.props!.onFail("late"));
    expect(mockVideo.mounts).toBe(3);
  });

  it("视频 2.5 秒还没备好：放弃视频，退回逐帧画", async () => {
    mockVideo.on = true;
    const r = mount();
    layout(r);
    await advance(2400);
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(1);
    await advance(1500);
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(0);
    expect(sceneVideoMode(r)).toBe(0);
    expect(frameClock.active).toBe(true);
    expect(loadRouteFrames).toHaveBeenCalled();
  });

  it("叫视频放了 0.7 秒还没走起来：放弃视频，时钟自己走", async () => {
    mockVideo.on = true;
    const r = mount();
    layout(r);
    act(() => mockVideo.props!.onReady());
    await advance(300);
    frame();
    frame();
    frame();
    frame();
    expect(mockVideo.play).toHaveBeenCalled();
    await advance(650);
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(1);
    await advance(400);
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(0);
    expect(sceneVideoMode(r)).toBe(0);
    frame();
    frame();
    expect(splashStory.get()).toBeGreaterThan(0);
    await playToEnd();
    expect(logged(/视频没放成/)).toBe(true);
  });

  it("开播后才报错：不再换播放器重试，直接退回逐帧画", async () => {
    mockVideo.on = true;
    const r = mount();
    layout(r);
    act(() => mockVideo.props!.onReady());
    await advance(300);
    act(() => mockVideo.props!.onFail("mid-play"));
    expect(mockVideo.mounts).toBe(1);
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(0);
  });

  it("减弱动态效果：不播路线，视频也不用了", async () => {
    mockVideo.on = true;
    reduce.mockImplementation(() => Promise.resolve(true));
    const r = mount();
    layout(r);
    act(() => mockVideo.props!.onReady());
    await advance(300);
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(0);
    expect(sceneVideoMode(r)).toBe(0);
    expect(splashStory.get()).toBe(MARK_DONE);
  });

  it("开播后、时钟还没来得及叫视频放就报错：不再去叫已经卸掉的播放器，退回逐帧画后时钟自己走", async () => {
    mockVideo.on = true;
    const r = mount();
    layout(r);
    act(() => mockVideo.props!.onReady());
    await advance(300);
    expect(frameClock.active).toBe(true);
    // 起步前的三帧稳定帧
    frame();
    frame();
    frame();
    act(() => mockVideo.props!.onFail("decoder lost"));
    expect(hosts(r, "RouteVideoLayer")).toHaveLength(0);
    // 退回逐帧画要等预录帧读完（异步）；这之前来的那一帧还按视频模式走，轮到叫视频放时发现它已经没了
    frame();
    expect(mockVideo.play).not.toHaveBeenCalled();
    expect(splashStory.get()).toBe(0);
    await advance(0);
    expect(sceneVideoMode(r)).toBe(0);
    frame();
    frame();
    expect(splashStory.get()).toBeGreaterThan(0);
    expect(mockVideo.play).not.toHaveBeenCalled();
  });

  it("叫视频放了、还没走起来就被带进求救页：不再盯着视频，事后也不会补报「视频没放成」", async () => {
    mockVideo.on = true;
    const r = mount();
    layout(r);
    act(() => mockVideo.props!.onReady());
    await advance(300);
    frame();
    frame();
    frame();
    frame();
    expect(mockVideo.play).toHaveBeenCalledTimes(1);
    act(() => mockPath.set("/sos-active?sosId=s1"));
    expect(shown(r)).toBe(false);
    // 原来盯着视频的那一圈要盯满 0.7 秒才放弃
    await advance(1000);
    expect(logged(/视频没放成/)).toBe(false);
    expect(logged(/视频起步/)).toBe(false);
  });

  it("视频在画布接手前一刻才报错：记为没放成，走过交接时刻也不会又记成放完", async () => {
    mockVideo.on = true;
    const r = mount();
    layout(r);
    act(() => mockVideo.props!.onReady());
    await advance(300);
    frame();
    frame();
    frame();
    frame();
    mockVideo.position = 400;
    await advance(5);
    frame(); // 对表
    const handover = MARK_DONE + VIDEO_HANDOVER + 60;
    runUntil((t) => t > handover - 40);
    act(() => mockVideo.props!.onFail("late"));
    // 预录帧还没读完（没让出过）、视频模式还没撤：这时走过交接时刻
    runUntil((t) => t > handover + 1);
    expect(sceneVideoMode(r)).toBe(1);
    await playToEnd();
    expect(shown(r)).toBe(false);
    expect(logged(/视频没放成、路线段逐帧画/)).toBe(true);
    expect(logged(/路线段播视频/)).toBe(false);
  });
});

describe("时钟（补）", () => {
  it("起步之后读不到帧间隔：这一帧按 16ms 算", async () => {
    const r = mount();
    await start(r);
    frame(null);
    expect(splashStory.get()).toBeCloseTo(storyAt(warp, 16));
  });

  it("收场之后、这一层卸掉之前的那两帧里又来的帧：时钟不再往前走", async () => {
    const r = mount();
    await start(r);
    runUntil(() => m(releaseSplashPage).mock.calls.length > 0, 16, 600);
    const end = splashStory.get();
    frame(16);
    frame(200);
    expect(splashStory.get()).toBe(end);
    expect(shown(r)).toBe(true);
    await advance(50);
    expect(shown(r)).toBe(false);
  });

  it("慢帧很多时：日志照数总数，但「出现在哪」只列前 16 个", async () => {
    const r = mount();
    await start(r);
    for (let i = 0; i < 20; i++) frame(30);
    await playToEnd();
    expect(shown(r)).toBe(false);
    const line = (log.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .find((l) => /^\[splash\] \d+ 帧/.test(l))!;
    expect(line).toContain("超过 25 毫秒的 20 帧");
    const where = line.split("出现在（故事时间:毫秒）")[1].split("；")[0];
    expect(where.trim().split(" ")).toHaveLength(16);
  });
});

describe("开播前（补）", () => {
  it("预录帧读到了就先预热几帧；读不出来：一帧都不预热，照样按时开播（实时画）", async () => {
    const warmOf = (r: Rendered) =>
      (hosts(r, "RouteSceneView")[0].props.warm as { get: () => number }).get();
    const ok = mount();
    layout(ok);
    await advance(0);
    expect(warmOf(ok)).toBe(8);
    ok.unmount();

    m(loadRouteFrames).mockImplementation(() => Promise.resolve(false));
    const r = mount();
    layout(r);
    for (const ms of [0, 20, 40, 100]) {
      await advance(ms);
      expect(warmOf(r)).toBe(-1);
    }
    await advance(1200);
    expect(frameClock.active).toBe(true);
    expect(splashStory.get()).toBe(0);
  });

  it("启动时 JS 线程还忙（两次回到定时器之间隔了 40ms 以上）：从忙完那一刻起再等够 160ms 的空闲才开播", async () => {
    const r = mount();
    const fakeNow = performance.now.bind(performance);
    const from = Date.now();
    // 第 60ms 起主线程被别的事占了 100ms：之后读到的时间整体晚 100ms
    const busy = jest
      .spyOn(performance, "now")
      .mockImplementation(
        () => fakeNow() + (Date.now() - from >= 60 ? 100 : 0),
      );
    try {
      layout(r);
      // 一直闲着的话 160ms 就开播了
      await advance(200);
      expect(frameClock.active).toBe(false);
      await advance(100);
      expect(frameClock.active).toBe(true);
    } finally {
      busy.mockRestore();
    }
  });
});

describe("本机记录（补）", () => {
  it("挂上后马上卸掉（重装检查还没回来）：回来之后不再去读启动记录；留着的话会读", async () => {
    const gone = mount();
    gone.unmount();
    await advance(0);
    expect(useLaunchMemoryStore.getState().hydrated).toBe(false);
    mount();
    await advance(0);
    expect(useLaunchMemoryStore.getState().hydrated).toBe(true);
  });

  it("已登录，设备列表没回来、本机记录也还没从钥匙串读出来：按没有记录处理——停在商标上，等满 1 秒直接淡出；之后读出来的记录也不改", async () => {
    signIn();
    mockKv.set(
      SECURE_KEYS.launchMemory,
      JSON.stringify({ userId: "u1", hasHelmet: true }),
    );
    let release!: () => void;
    mockKvGate.wait = new Promise<void>((done) => {
      release = done;
    });
    const r = mount();
    await start(r);
    runUntil((s) => s >= MARK_DONE);
    frame();
    expect(useLaunchMemoryStore.getState().hydrated).toBe(false);
    expect(splashStory.get()).toBe(MARK_DONE);
    await advance(1000);
    frame();
    frame();
    expect(splashStory.get()).toBeGreaterThan(MARK_DONE);
    release();
    await advance(0);
    expect(useLaunchMemoryStore.getState().record).toEqual({
      userId: "u1",
      hasHelmet: true,
    });
    runUntil((s) => s >= STORY_TOTAL.plain - 40);
    expect(anchorOwned.hero.get()).toBe(0);
    await playToEnd();
    expect(shown(r)).toBe(false);
  });
});

describe("收场只做一次", () => {
  it("由通知拉起、收场的那两帧里又被带进求救页：页面只放回一次，这一层立刻卸掉", async () => {
    m(launchedByNotification).mockReturnValue(true);
    const r = mount();
    layout(r);
    expect(releaseSplashPage).toHaveBeenCalledTimes(1);
    act(() => mockPath.set("/sos-active?sosId=s1"));
    expect(shown(r)).toBe(false);
    expect(releaseSplashPage).toHaveBeenCalledTimes(1);
    expect(releaseSplashHold).toHaveBeenCalledTimes(1);
    await advance(50);
    expect(releaseRouteScene).toHaveBeenCalledTimes(1);
  });
});

describe("落位：页面量到了位置", () => {
  it("登录页：光和商标落到页面上那枚商标的位置（中心、大小照它），中文品牌名落到页面标题的中心", async () => {
    const { width, k, cx, cy, size } = geometry();
    const MARK = { x: 40, y: 120, w: 88, h: 88 };
    const TITLE = { x: 0, y: 236, w: width, h: 40 };
    const { r, refresh } = mountKeep();
    act(() => {
      anchorRect.loginMark.set(MARK);
      anchorRect.loginTitle.set(TITLE);
    });
    await start(r);
    runUntil((s) => s >= LOGIN.dockFrom + LOGIN.dockLen + 60);
    refresh();
    const glow = glowNow(r);
    expect(glow.dock).toBe(1);
    expect(glow.cx).toBeCloseTo((MARK.x + MARK.w / 2) / k);
    expect(glow.cy).toBeCloseTo((MARK.y + MARK.h / 2) / k);
    expect(glow.scale).toBeCloseTo(MARK.w / size);
    const [tx, ty, , sc] = markStyle(r).transform as Record<string, number>[];
    expect(tx.translateX).toBeCloseTo(MARK.x + MARK.w / 2 - cx);
    expect(ty.translateY).toBeCloseTo(MARK.y + MARK.h / 2 - cy);
    expect(sc.scale).toBeCloseTo(MARK.w / size);
    const titleSize = LOGIN_BRAND.titleSize(width);
    const [zy, zs] = textStyle(r, "零一智行").transform as Record<
      string,
      number
    >[];
    expect(zy.translateY).toBeCloseTo(TITLE.y + TITLE.h / 2 - titleSize * 0.65);
    expect(zs.scale).toBe(1);
  });

  it("设备页：表盘那块画布接手了商标——扫描开始前商标照常显示，扫描一开始整个藏起来（由表盘去擦）", async () => {
    signIn();
    mockHero.value = { image: 1, battery: 80 };
    m(devicesApi.list).mockImplementation(() => Promise.resolve([dev("h1")]));
    const { r, refresh } = mountKeep();
    await start(r);
    runUntil((s) => s >= SCENE_T.raster[1]);
    const markTaken = hosts(r, "DeviceLanding")[0].props.markTaken as {
      set: (v: number) => void;
    };
    act(() => markTaken.set(1));
    runUntil((s) => s >= DEVICE.scan[0] - 40);
    refresh();
    expect(markStyle(r).opacity).toBe(1);
    runUntil((s) => s >= DEVICE.scan[0] + 40);
    refresh();
    expect(markStyle(r).opacity).toBe(0);
  });

  it("引导页：量到了卡片上那枚徽标的位置——商标沿一道弧（途中带一点转角）落到那里，大小变成徽标那么大", async () => {
    const { cx, cy, size } = geometry();
    const EMBLEM = { x: 30, y: 200, w: 36, h: 36 };
    signIn();
    useLaunchMemoryStore.setState({
      hydrated: true,
      record: { userId: "u1", hasHelmet: false },
    });
    const { r, refresh } = mountKeep();
    act(() => anchorRect.guideEmblem.set(EMBLEM));
    await start(r);
    runUntil((s) => s >= UNBOUND.start + 400);
    refresh();
    const mid = markStyle(r).transform as Record<string, number | string>[];
    expect(parseFloat(String(mid[2].rotate))).toBeLessThan(-1);
    runUntil((s) => s >= UNBOUND.start + 70 + 760 + 20);
    refresh();
    const [tx, ty, rot, sc] = markStyle(r).transform as Record<
      string,
      number | string
    >[];
    expect(tx.translateX).toBeCloseTo(EMBLEM.x + EMBLEM.w / 2 - cx);
    expect(ty.translateY).toBeCloseTo(EMBLEM.y + EMBLEM.h / 2 - cy);
    expect(parseFloat(String(rot.rotate))).toBeCloseTo(0);
    expect(sc.scale).toBeCloseTo(EMBLEM.w / size);
  });
});

/** 故事时间 → 真实时间（只用于上面比对） */
function warpReal(story: number): number {
  if (story >= MARK_DONE) return warp[MARK_DONE] + (story - MARK_DONE);
  const i = Math.floor(story);
  return warp[i] + (warp[i + 1] - warp[i]) * (story - i);
}
