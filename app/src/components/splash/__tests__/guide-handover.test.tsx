// 引导页变成设备页的那段衔接（guide-handover）：接手前先把页面安排好（prepareGuideHandover）、先搭着时不显示不挡触摸、
// 接手后等页面大图量到位置才走（等不到 0.6 秒就不播）、按自己的时钟推故事时间、表盘到点交还给页面、播完整层卸掉；
// 设备页不在最前面了立刻收掉；保险时限；卸掉时把公共值放回。
// 逐帧回调与动画反应用「会反应」的替身，落位画布换成占位。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactTestInstance } from "react-test-renderer";
import { frameClock, pumpReactions } from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  makeQueryClient,
  render,
  type Rendered,
} from "@/__tests__/helpers/render";
import { devicesApi } from "@/api/devices";
import { Colors } from "@/constants/theme";
import { useGuideStore, type GuideHandoverFrom } from "@/stores/guide-store";
import { useThemeStore } from "@/stores/theme-store";
import {
  anchorOwned,
  anchorRect,
  arriveFrom,
  pillFrom,
  splashOn,
  splashStory,
} from "../bus";
import { GuideHandover, prepareGuideHandover } from "../guide-handover";
import { releaseDeviceLanding } from "../landing-device";

jest.mock("@/global.css", () => ({}));
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
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
  AFTER_FIRST_UNLOCK: 0,
}));
jest.mock("@/api/devices", () => ({ devicesApi: { list: jest.fn() } }));
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

const FROM: GuideHandoverFrom = {
  card: { x: 20, y: 300, w: 350, h: 220 },
  emblem: { x: 40, y: 320, w: 36, h: 36 },
};
const HERO = { x: 75, y: 120, w: 240, h: 240 };

const mount = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <GuideHandover />
    </QueryClientProvider>,
  );
const overlay = (r: Rendered) =>
  r.root.findAll(
    (n) =>
      typeof n.type === "string" &&
      typeof n.props.onStartShouldSetResponder === "function",
  )[0];
/** 壳、壳里的底色、徽标三块的样式（按出现顺序） */
const parts = (r: Rendered) => {
  const o = overlay(r);
  const kids = (n: ReactTestInstance) => n.children as ReactTestInstance[];
  const shell = kids(o)[0];
  // 壳（组件）→ 它渲染的宿主 View → 里面那层底色
  const fill = kids(kids(shell)[0])[0];
  const emblem = kids(o)[2];
  return {
    shell: flat(shell.props.style),
    fill: flat(fill.props.style),
    emblem: flat(emblem.props.style),
  };
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
const handOver = (from: GuideHandoverFrom = FROM) => {
  act(() => {
    prepareGuideHandover(from);
    useGuideStore.setState({ handover: from, armed: true });
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockPath.value = "/";
  mockHero.value = undefined;
  frameClock.cb = null;
  frameClock.active = false;
  jest.requireActual<typeof import("../bus")>("../bus").releaseSplashPage();
  splashStory.set(-1);
  anchorRect.hero.set(null);
  useThemeStore.setState({ mode: "dark" });
  useGuideStore.setState({ handover: null, armed: false });
  (devicesApi.list as unknown as jest.Mock).mockImplementation(
    () => new Promise(() => undefined),
  );
});
afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe("prepareGuideHandover", () => {
  it("接手前把页面安排好：大图由这一层代画、旧的位置作废、内容跟着这里的时钟进场、名字和连接状态先藏着", () => {
    anchorRect.hero.set(HERO);
    prepareGuideHandover(FROM);
    expect(anchorRect.hero.get()).toBeNull();
    expect(splashStory.get()).toBe(900);
    expect(anchorOwned.hero.get()).toBe(1);
    expect(arriveFrom.get()).toBe(2300);
    expect(pillFrom.get()).toBe(900 + 2300 * 4);
    expect(splashOn.get()).toBe(1);
    // 接手后这一层被卸掉（比如整个 App 重载）：公共值都放回「不参与」
    act(() => useGuideStore.setState({ handover: FROM, armed: true }));
    const r = mount();
    r.unmount();
    expect(splashOn.get()).toBe(0);
    expect(anchorOwned.hero.get()).toBe(0);
    expect(arriveFrom.get()).toBe(-1);
    expect(splashStory.get()).toBe(-1);
  });
});

describe("GuideHandover", () => {
  it("没在等也没在播：什么都不渲染", () => {
    const r = mount();
    expect(r.tree.toJSON()).toBeNull();
  });

  it("先搭着（armed、还没接手）：不显示、不挡触摸、时钟不走，徽标占一块 40 的地方好去读图；搭太久也会自己撤掉", async () => {
    act(() => useGuideStore.setState({ armed: true }));
    const r = mount();
    expect(overlay(r).props.pointerEvents).toBe("none");
    const { shell, emblem } = parts(r);
    expect(shell.opacity).toBe(0);
    expect(emblem).toMatchObject({ opacity: 0, width: 40, height: 40 });
    expect(frameClock.active).toBe(false);
    expect(r.root.findAll((n) => isHost(n, "DeviceLanding"))).toHaveLength(1);
    await advance(2300 + 600 + 1500 - 1);
    expect(useGuideStore.getState().armed).toBe(true);
    await advance(1);
    expect(useGuideStore.getState().armed).toBe(false);
    expect(r.tree.toJSON()).toBeNull();
  });

  it("接手：挡住触摸、时钟开走；壳从卡片的位置起步，徽标从卡片左上角起步；深色是渐变底、浅色是元素底色；落位画布原地起、到点交还", () => {
    useThemeStore.setState({ mode: "light" });
    act(() => useGuideStore.setState({ armed: true }));
    const r = mount();
    act(() => anchorRect.hero.set(HERO));
    handOver();
    expect(overlay(r).props.pointerEvents).toBe("box-only");
    expect(overlay(r).props.onStartShouldSetResponder()).toBe(true);
    expect(frameClock.active).toBe(true);
    // prepare 把位置作废了：这一刻量到的才算
    act(() => anchorRect.hero.set(HERO));
    r.rerender(
      <QueryClientProvider client={makeQueryClient()}>
        <GuideHandover />
      </QueryClientProvider>,
    );
    const { shell, fill, emblem } = parts(r);
    expect(shell).toMatchObject({
      left: FROM.card.x,
      top: FROM.card.y,
      width: FROM.card.w,
      height: FROM.card.h,
      borderRadius: 26,
      borderWidth: 1,
      opacity: 1,
      borderColor: Colors.light.border,
    });
    expect(fill.backgroundColor).toBe(Colors.light.backgroundElement);
    expect(emblem.width).toBe(FROM.emblem.w);
    expect(emblem.transform).toEqual([
      { translateX: FROM.emblem.x },
      { translateY: FROM.emblem.y },
    ]);
    const landing = r.root.find((n) => isHost(n, "DeviceLanding")).props;
    expect(landing.inPlace).toBe(true);
    expect(landing.giveAt).toBe(2800);
  });

  it("页面大图还没量到位置：故事时间原地等；等不到 0.6 秒就不播，把页面交还并卸掉", async () => {
    act(() => useGuideStore.setState({ armed: true }));
    const r = mount();
    handOver();
    for (let i = 0; i < 12; i++) frame(50);
    expect(splashStory.get()).toBe(900);
    expect(splashOn.get()).toBe(1);
    // 一帧最多算 50ms：200ms 的卡顿也只算 50
    frame(200);
    expect(splashOn.get()).toBe(0);
    expect(anchorOwned.hero.get()).toBe(0);
    expect(r.tree.toJSON()).not.toBeNull();
    await advance(50);
    expect(releaseDeviceLanding).toHaveBeenCalled();
    expect(useGuideStore.getState().handover).toBeNull();
    expect(r.tree.toJSON()).toBeNull();
  });

  it("量到位置后按自己的时钟推故事时间（故事 = 900 + 过了多久）；表盘过了 2800 渐渐交还给页面；走满 2300 收场卸掉", async () => {
    act(() => useGuideStore.setState({ armed: true }));
    const r = mount();
    handOver();
    act(() => anchorRect.hero.set(HERO));
    frame(16);
    frame(null); // 读不到间隔按 16 算
    expect(splashStory.get()).toBe(900 + 32);
    while (splashStory.get() < 2800 + 100) frame(16);
    const mid = anchorOwned.hero.get();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    while (splashStory.get() < 2800 + 200) frame(16);
    expect(anchorOwned.hero.get()).toBe(0);
    while (splashOn.get() === 1) frame(16);
    expect(splashStory.get()).toBeGreaterThanOrEqual(900 + 2300);
    await advance(50);
    expect(r.tree.toJSON()).toBeNull();
    // 卸掉时故事时间归位
    expect(splashStory.get()).toBe(-1);
  });

  it("播到一半设备页不在最前面了（被带去求救页 / 别的页面）：立刻收掉、把页面交还", async () => {
    act(() => useGuideStore.setState({ armed: true }));
    const r = mount();
    handOver();
    act(() => anchorRect.hero.set(HERO));
    frame(16);
    act(() => mockPath.set("/sos-active"));
    expect(splashOn.get()).toBe(0);
    await advance(50);
    expect(r.tree.toJSON()).toBeNull();
  });

  it("保险：接手后出了岔子（时钟一帧都没走），到时限也收掉", async () => {
    act(() => useGuideStore.setState({ armed: true }));
    const r = mount();
    handOver();
    await advance(2300 + 600 + 1500);
    expect(splashOn.get()).toBe(0);
    await advance(50);
    expect(r.tree.toJSON()).toBeNull();
  });

  it("有头盔的样子时壳用它的环色；徽标交给表盘后随扫描开始就藏起来", () => {
    mockHero.value = { track: "#123456", image: 1 };
    act(() => useGuideStore.setState({ armed: true }));
    const r = mount();
    handOver();
    act(() => anchorRect.hero.set(HERO));
    r.rerender(
      <QueryClientProvider client={makeQueryClient()}>
        <GuideHandover />
      </QueryClientProvider>,
    );
    expect(parts(r).shell.borderColor).toBe("#123456");
    expect(parts(r).fill.experimental_backgroundImage).toContain(
      "linear-gradient",
    );
    const markTaken = r.root.find((n) => isHost(n, "DeviceLanding")).props
      .markTaken as { set: (v: number) => void };
    // 扫描开始（故事 2060）之后：表盘接手了就整个藏起来
    while (splashStory.get() < 2100) frame(16);
    act(() => markTaken.set(1));
    r.rerender(
      <QueryClientProvider client={makeQueryClient()}>
        <GuideHandover />
      </QueryClientProvider>,
    );
    expect(parts(r).emblem.opacity).toBe(0);
  });

  it("表盘接手了徽标、但扫描还没开始：徽标照常显示，等扫描一开始才整个藏起来", () => {
    mockHero.value = { track: "#123456", image: 1 };
    act(() => useGuideStore.setState({ armed: true }));
    const r = mount();
    handOver();
    act(() => anchorRect.hero.set(HERO));
    const markTaken = r.root.find((n) => isHost(n, "DeviceLanding")).props
      .markTaken as { set: (v: number) => void };
    const rerender = () =>
      r.rerender(
        <QueryClientProvider client={makeQueryClient()}>
          <GuideHandover />
        </QueryClientProvider>,
      );
    // 扫描从故事 2060 开始
    while (splashStory.get() < 1900) frame(16);
    act(() => markTaken.set(1));
    rerender();
    expect(parts(r).emblem.opacity).toBe(1);
    while (splashStory.get() < 2080) frame(16);
    rerender();
    expect(parts(r).emblem.opacity).toBe(0);
  });

  it("走满收场后、卸掉之前那两帧：又来的帧不再推故事时间；这时设备页被换掉也不再收第二次", async () => {
    act(() => useGuideStore.setState({ armed: true }));
    const r = mount();
    handOver();
    act(() => anchorRect.hero.set(HERO));
    while (splashOn.get() === 1) frame(16);
    const end = splashStory.get();
    frame(16);
    expect(splashStory.get()).toBe(end);
    act(() => mockPath.set("/sos-active"));
    await advance(50);
    expect(releaseDeviceLanding).toHaveBeenCalledTimes(1);
    expect(r.tree.toJSON()).toBeNull();
  });
});
