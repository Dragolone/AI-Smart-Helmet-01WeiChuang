// 开屏遮罩和页面之间传话的几样东西：bus（页面数据、页面就绪、先画骨架、收场归位）、SplashArrive 依次进场、
// SplashAnchor 报位置与被遮罩接管时藏起来、useHeroSplash 拿设备页大图的样子、useSteadyId 卸载时清缓存。
// bus 里有进程级的状态（页面就绪、先画骨架），涉及它的用例用 jest.isolateModules 各拿一份新的。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { DevicePublic } from "@helmet/shared";
import type { ReactElement } from "react";
import { View } from "react-native";
import { act } from "react-test-renderer";

import { flat, render, rootJson } from "@/__tests__/helpers/render";
import { useThemeStore } from "@/stores/theme-store";
import {
  anchorOwned,
  anchorRect,
  arriveFrom,
  endSplashStory,
  getAnchorData,
  guideFrom,
  headerFrom,
  pillFrom,
  releaseSplashPage,
  setAnchorData,
  splashOn,
  splashStory,
  subscribeAnchorData,
} from "../bus";
import { SplashAnchor, SplashPageMark } from "../splash-anchor";
import { SplashArrive } from "../splash-arrive";
import { useHeroSplash } from "../use-hero-splash";
import { useSteadyId } from "../use-steady-id";

jest.mock("@/global.css", () => ({}));
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
jest.mock("react-native-reanimated", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock(),
);
jest.mock("@/constants/helmet-images", () => ({ helmetImageFor: () => 7 }));
const mockSafety = {
  ready: true,
  chosenId: null as string | null,
  links: {} as Record<string, string>,
};
jest.mock("@/hooks/use-safety", () => ({
  useCurrentHelmetChoice: () => ({
    ready: mockSafety.ready,
    chosenId: mockSafety.chosenId,
  }),
  useHelmetLinks: () => mockSafety.links,
}));

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
});
afterEach(() => {
  releaseSplashPage();
  endSplashStory();
  jest.useRealTimers();
});

describe("bus：页面数据", () => {
  it("写进去就能读出来，订阅的人收到通知；退订后不再收到", () => {
    const l = jest.fn();
    const off = subscribeAnchorData(l);
    setAnchorData("hero", { battery: 50 });
    expect(getAnchorData<{ battery: number }>("hero")).toEqual({ battery: 50 });
    expect(l).toHaveBeenCalledTimes(1);
    off();
    setAnchorData("hero", undefined);
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe("bus：页面就绪 / 先画骨架（每个用例一份新的 bus）", () => {
  type Bus = typeof import("../bus");
  /** 一份新的 bus，和同一份 react / react-test-renderer（isolateModules 里各是新的一份，要从同一次里取） */
  const fresh = () => {
    let bus!: Bus;
    let renderer!: typeof import("react-test-renderer");
    let React!: typeof import("react");
    jest.isolateModules(() => {
      React = jest.requireActual("react");
      renderer = jest.requireActual("react-test-renderer");
      bus = jest.requireActual<Bus>("../bus");
    });
    return { bus, renderer, React };
  };

  it("页面没搭好时等着；markPageReady 之后放行所有等待的人；之后再等直接放行", async () => {
    const { bus } = fresh();
    const seen: string[] = [];
    void bus.whenPageReady().then(() => seen.push("a"));
    void bus.whenPageReady().then(() => seen.push("b"));
    await Promise.resolve();
    expect(seen).toEqual([]);
    bus.markPageReady();
    bus.markPageReady();
    await Promise.resolve();
    expect(seen).toEqual(["a", "b"]);
    await expect(bus.whenPageReady()).resolves.toBeUndefined();
  });

  it("进程刚起来时先画骨架；遮罩放行后不再画；只放行一次", () => {
    const { bus, renderer, React } = fresh();
    let hold: boolean | undefined;
    function Probe() {
      hold = bus.useSplashHold();
      return null;
    }
    let tree!: ReturnType<typeof renderer.create>;
    renderer.act(() => {
      tree = renderer.create(React.createElement(Probe));
    });
    expect(hold).toBe(true);
    renderer.act(() => bus.releaseSplashHold());
    expect(hold).toBe(false);
    renderer.act(() => bus.releaseSplashHold());
    expect(hold).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it("遮罩万一没放行：6 秒后页面自己放行", () => {
    jest.useFakeTimers();
    const { bus, renderer, React } = fresh();
    let hold: boolean | undefined;
    function Probe() {
      hold = bus.useSplashHold();
      return null;
    }
    let tree!: ReturnType<typeof renderer.create>;
    renderer.act(() => {
      tree = renderer.create(React.createElement(Probe));
    });
    renderer.act(() => {
      jest.advanceTimersByTime(5999);
    });
    expect(hold).toBe(true);
    renderer.act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(hold).toBe(false);
    renderer.act(() => tree.unmount());
  });
});

describe("bus：收场归位", () => {
  it("第一步把页面上的东西全放回不参与（故事时间先不动），第二步故事时间归位", () => {
    splashOn.set(1);
    arriveFrom.set(100);
    headerFrom.set(100);
    pillFrom.set(100);
    guideFrom.set(100);
    anchorOwned.hero.set(1);
    splashStory.set(2000);
    releaseSplashPage();
    expect([
      splashOn.get(),
      arriveFrom.get(),
      headerFrom.get(),
      pillFrom.get(),
      guideFrom.get(),
    ]).toEqual([0, -1, -1, -1, -1]);
    expect(anchorOwned.hero.get()).toBe(0);
    expect(splashStory.get()).toBe(2000);
    endSplashStory();
    expect(splashStory.get()).toBe(-1);
  });
});

describe("SplashArrive", () => {
  const styleOf = (el: ReactElement) => {
    const r = render(el);
    return flat(rootJson(r).props.style);
  };
  const ty = (s: Record<string, unknown>) =>
    (s.transform as Record<string, number>[])[0].translateY;
  const sc = (s: Record<string, unknown>) =>
    (s.transform as Record<string, number>[])[1].scale;

  it("没有开屏在播：原样显示", () => {
    expect(
      styleOf(
        <SplashArrive>
          <View />
        </SplashArrive>,
      ),
    ).toMatchObject({
      opacity: 1,
      transform: [{ translateY: 0 }, { scale: 1 }],
    });
  });

  it("rise：没轮到时在下面、透明；走完到位；第几个决定晚多少出发", () => {
    arriveFrom.set(1000);
    splashStory.set(1000);
    let s = styleOf(
      <SplashArrive order={2}>
        <View />
      </SplashArrive>,
    );
    expect(s.opacity).toBe(0);
    expect(ty(s)).toBe(30);
    splashStory.set(1000 + 120 + 325);
    s = styleOf(
      <SplashArrive order={2} from={-20}>
        <View />
      </SplashArrive>,
    );
    expect(Number(s.opacity)).toBeGreaterThan(0);
    expect(Number(s.opacity)).toBeLessThan(1);
    expect(ty(s)).not.toBe(0);
    splashStory.set(5000);
    s = styleOf(
      <SplashArrive order={2}>
        <View />
      </SplashArrive>,
    );
    expect(s).toMatchObject({ opacity: 1 });
    expect(ty(s)).toBe(0);
    expect(sc(s)).toBe(1);
  });

  it("soft 原地淡入只挪一点；pop 从小弹到原大；分别跟标题栏 / 连接状态那一刻走", () => {
    headerFrom.set(0);
    splashStory.set(150);
    let s = styleOf(
      <SplashArrive kind="soft" cue="header">
        <View />
      </SplashArrive>,
    );
    expect(s.opacity).toBe(0.5);
    expect(ty(s)).toBeLessThan(6);
    expect(ty(s)).toBeGreaterThan(0);
    pillFrom.set(0);
    splashStory.set(100);
    s = styleOf(
      <SplashArrive kind="pop" cue="pill">
        <View />
      </SplashArrive>,
    );
    expect(ty(s)).toBe(0);
    expect(sc(s)).toBeGreaterThan(0.86);
    expect(sc(s)).toBeLessThan(1.2);
    // 标题栏还没进场（-1）时 header 的块直接显示
    headerFrom.set(-1);
    expect(
      styleOf(
        <SplashArrive cue="header" lead={-50}>
          <View />
        </SplashArrive>,
      ).opacity,
    ).toBe(1);
  });
});

describe("SplashAnchor / SplashPageMark", () => {
  it("把 data 交给遮罩；遮罩接管时藏起来（交还时渐变回来）", () => {
    anchorOwned.loginMark.set(1);
    let r = render(
      <SplashAnchor name="loginMark" data={{ size: 80 }}>
        <View />
      </SplashAnchor>,
    );
    expect(getAnchorData("loginMark")).toEqual({ size: 80 });
    expect(flat(rootJson(r).props.style).opacity).toBe(0);
    anchorOwned.loginMark.set(0.25);
    r = render(
      <SplashAnchor name="loginMark">
        <View />
      </SplashAnchor>,
    );
    expect(flat(rootJson(r).props.style).opacity).toBe(0.75);
  });

  it("排版后量出窗口里的位置报给遮罩；量出来是 0 尺寸的不报；挂上之后再量几次", () => {
    jest.useFakeTimers();
    const measures: [number, number, number, number][] = [
      [10, 20, 0, 0],
      [10, 20, 100, 40],
    ];
    let calls = 0;
    anchorRect.hero.set(null);
    const r = render(
      <SplashAnchor name="hero">
        <View />
      </SplashAnchor>,
    );
    // jest 里 RN 的 View 是带 measureInWindow 空实现的类组件：换成按顺序给尺寸的
    const view = r.root.find(
      (n) => typeof n.instance?.measureInWindow === "function",
    );
    view.instance.measureInWindow = (
      cb: (x: number, y: number, w: number, h: number) => void,
    ) => {
      const m = measures[Math.min(calls++, measures.length - 1)];
      cb(...m);
    };
    const host = r.root.find(
      (n) =>
        typeof n.type === "string" && typeof n.props.onLayout === "function",
    );
    act(() => host.props.onLayout());
    expect(calls).toBe(1);
    expect(anchorRect.hero.get()).toBeNull();
    act(() => {
      jest.advanceTimersByTime(50);
    });
    expect(anchorRect.hero.get()).toEqual({ x: 10, y: 20, w: 100, h: 40 });
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(calls).toBe(5);
  });

  it("SplashPageMark：一个看不见的 1×1 点，排版即算页面搭好", () => {
    const r = render(<SplashPageMark />);
    const s = flat(rootJson(r).props.style);
    expect([s.width, s.height, s.opacity]).toEqual([1, 1, 0]);
    expect(() => (rootJson(r).props.onLayout as () => void)()).not.toThrow();
  });
});

describe("useHeroSplash", () => {
  let got: unknown;
  function Probe({ list, fresh }: { list?: DevicePublic[]; fresh: boolean }) {
    got = useHeroSplash(list, fresh);
    return null;
  }
  const dev = (id: string, over: Partial<DevicePublic> = {}) =>
    ({
      deviceId: id,
      name: null,
      battery: 80,
      charging: false,
      ...over,
    }) as DevicePublic;
  beforeEach(() => {
    setAnchorData("hero", undefined);
    Object.assign(mockSafety, { ready: true, chosenId: null, links: {} });
  });

  it("当前头盔的选择还没读到：先不给；没有头盔：不给", () => {
    mockSafety.ready = false;
    render(<Probe list={[dev("h1")]} fresh />);
    expect(got).toBeUndefined();
    mockSafety.ready = true;
    render(<Probe list={undefined} fresh={false} />);
    expect(got).toBeUndefined();
  });

  it("页面没给之前按同一套规则从设备列表算（连着时绿色环）；页面给了就以页面为准", () => {
    mockSafety.links = { h1: "connected" };
    render(<Probe list={[dev("h1")]} fresh />);
    expect(got).toMatchObject({ battery: 80, linked: true, value: "80" });
    act(() => setAnchorData("hero", { battery: 12, from: "page" }));
    render(<Probe list={[dev("h1")]} fresh />);
    expect(got).toEqual({ battery: 12, from: "page" });
  });
});

describe("useSteadyId", () => {
  it("每一份一个不重复的 id；卸载时清掉记着的样式（JS 和 UI 两边）", async () => {
    const steady =
      jest.requireActual<typeof import("../steady-style")>("../steady-style");
    const ids: string[] = [];
    function Probe() {
      const id = useSteadyId();
      ids.push(id);
      return null;
    }
    const r = render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    expect(new Set(ids).size).toBe(2);
    const a = steady.steady(ids[0], { opacity: 1 });
    expect(steady.steady(ids[0], { opacity: 1 })).toBe(a);
    r.unmount();
    expect(steady.steady(ids[0], { opacity: 1 })).not.toBe(a);
  });
});
