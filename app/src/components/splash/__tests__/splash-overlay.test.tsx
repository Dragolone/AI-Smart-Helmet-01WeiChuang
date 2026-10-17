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
import { AccessibilityInfo } from "react-native";
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
import { useAuthStore } from "@/stores/auth-store";
import { useLaunchMemoryStore } from "@/stores/launch-memory-store";
import { useThemeStore } from "@/stores/theme-store";
import {
  anchorOwned,
  arriveFrom,
  guideFrom,
  headerFrom,
  releaseSplashHold,
  releaseSplashPage,
  splashOn,
  splashStory,
  whenPageReady,
} from "../bus";
import { releaseDeviceLanding } from "../landing-device";
import { DEVICE, LOGIN, UNBOUND, loginReveal } from "../landings";
import { loadRouteFrames } from "../route-frames";
import { SCENE_BG, SCENE_T } from "../route-scene";
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
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => mockKv.get(k) ?? null,
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
const mockHero = { value: undefined as unknown };
jest.mock("../use-hero-splash", () => ({
  useHeroSplash: () => mockHero.value,
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
  frameClock.cb = null;
  frameClock.active = false;
  // 上一个用例留下的公共值放回「不参与」
  jest.requireActual<typeof import("../bus")>("../bus").releaseSplashPage();
  splashStory.set(-1);
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
    await advance(1);
    expect(releaseSplashHold).toHaveBeenCalled();
    await advance(50);
    expect(shown(r)).toBe(false);
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
    await playToEnd();
    expect(shown(r)).toBe(false);
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
});

/** 故事时间 → 真实时间（只用于上面比对） */
function warpReal(story: number): number {
  if (story >= MARK_DONE) return warp[MARK_DONE] + (story - MARK_DONE);
  const i = Math.floor(story);
  return warp[i] + (warp[i + 1] - warp[i]) * (story - i);
}
