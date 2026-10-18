// 设备页还没绑定头盔时的三步指引（一张卡走到底）：每一步卡片上写什么、按钮去哪、「稍后」记成跳过、
// 具备了就自己打勾换下一件（只在人看着这一页时走）、三件都处理完交给衔接动画；绑过又解绑的只有绑定那一张。
// 换到下一件那一段（光沿边走回徽标、徽标应一下、光再出去点亮按钮）停在某一毫秒看一帧；浅色外观。
// 判断逻辑在 services/device-guide（已有单测），这里看组件把它接成了什么样。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as SkiaModule from "@shopify/react-native-skia";
import type { DevicePublic } from "@helmet/shared";
import * as Notifications from "expo-notifications";
import { Dimensions, Linking } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";

import { mockFlags, mockRouter } from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  render,
  type Rendered,
} from "@/__tests__/helpers/render";
import { anchorRect, guideFrom, splashStory } from "@/components/splash/bus";
import {
  MARK_LIFT,
  SCENE_W,
  easeOut,
  lerp,
} from "@/components/splash/route-scene";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { FINISH_MS, SEARCH_SLOW_MS } from "@/services/device-guide";
import { useGuideStore } from "@/stores/guide-store";
import { useThemeStore } from "@/stores/theme-store";
import { DeviceGuide } from "../device-guide";

jest.mock("@/global.css", () => ({}));
jest.mock("@expo/vector-icons", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .iconsMock(),
);
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
/**
 * 替身里的动画一下子就走到终值，看不到「换到下一件」那一段的中间。设了 at，这一段就停在第 at 毫秒，
 * 好看那一帧的光、徽标和波纹（组件里只有这一段是 1700 ms 的动画）
 */
const mockBeat = { at: null as number | null };
jest.mock("react-native-reanimated", () => {
  const base = jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock();
  const withTiming = (base as Record<string, unknown>).withTiming as (
    ...a: unknown[]
  ) => unknown;
  return {
    ...base,
    withTiming: (to: unknown, cfg?: { duration?: number }, cb?: unknown) =>
      mockBeat.at !== null && cfg?.duration === 1700
        ? mockBeat.at
        : withTiming(to, cfg, cb),
  };
});
jest.mock("@shopify/react-native-skia", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .skiaMock(),
);
jest.mock("expo-router", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .expoRouterMock(),
);
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("expo-image", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { Image: (props: Record<string, unknown>) => h("ExpoImage", props) };
});
jest.mock("expo-notifications", () => ({ requestPermissionsAsync: jest.fn() }));
const mockBluetoothAction = jest.fn();
jest.mock("@/components/ble-onboarding", () => ({
  useBleOnboardingSteps: () => [
    {
      key: "bluetooth",
      done: false,
      blocking: true,
      action: mockBluetoothAction,
    },
  ],
}));

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const helmet = { deviceId: "h1", name: "通勤", battery: 80 } as DevicePublic;
type Props = Parameters<typeof DeviceGuide>[0];
const base = (): Props => ({
  helmet: undefined,
  link: undefined,
  notify: "undetermined" as Props["notify"],
  contacts: 0,
  bindOnly: false,
  onStage: true,
  onFinished: jest.fn(),
});
/** 渲染并量一次宽度（卡片在量到宽度之后才搭） */
const mount = (p: Partial<Props> = {}) => {
  const props = { ...base(), ...p };
  const r = render(<DeviceGuide {...props} />);
  const wrap = r.root.find(
    (n) =>
      typeof n.type === "string" &&
      typeof n.props.onLayout === "function" &&
      n.props.style?.flexGrow === 1,
  );
  act(() =>
    wrap.props.onLayout({
      nativeEvent: { layout: { width: 360, height: 700 } },
    }),
  );
  return {
    r,
    props,
    update: (q: Partial<Props>) =>
      r.rerender(<DeviceGuide {...props} {...q} />),
  };
};
const settle = (ms = 4000) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });
type Tf = Record<string, number | string>[];
const transformOf = (n: ReactTestInstance) =>
  (flat(n.props.style).transform ?? []) as Tf;
/** 徽标那张图外面那层的缩放 */
const emblemScale = (r: Rendered) => {
  const hosts = r.root.findAll(
    (x) =>
      typeof x.type === "string" &&
      x.findAll((c) => isHost(c, "ExpoImage")).length === 1 &&
      transformOf(x).length === 1 &&
      "scale" in transformOf(x)[0],
  );
  return transformOf(hosts[hosts.length - 1])[0].scale;
};
/** 文字为 label 的那个按钮 / 链接此刻的 onPress（先拿着，晚一点再按） */
const handlerOf = (r: Rendered, label: string) => {
  let n: ReactTestInstance | null = r.root.find(
    (x) =>
      isHost(x, "Text") && x.children.length === 1 && x.children[0] === label,
  );
  while (n && typeof n.props.onPress !== "function") n = n.parent;
  if (!n) throw new Error(`「${label}」不可点`);
  return n.props.onPress as () => void;
};

beforeEach(() => {
  jest.useFakeTimers();
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  useGuideStore.getState().reset();
  useGuideStore.getState().begin("u1");
});
afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  act(() => useGuideStore.getState().reset());
});

describe("第一步：绑定头盔", () => {
  it("还没绑：扫码绑定 / 手动输入；进度写 0 / 3 和三步的名字", () => {
    const { r } = mount();
    expect(r.allText()).toContain(tr("guide.helmet.bindTitle"));
    expect(r.allText()).toContain("0 / 3");
    r.press(tr("guide.helmet.scan"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/bind-device");
    r.press(tr("guide.helmet.manual"));
    expect(mockRouter.navigate).toHaveBeenLastCalledWith({
      pathname: "/bind-device",
      params: { manual: "1" },
    });
  });

  it("绑了但手机蓝牙关着：去开蓝牙；没给蓝牙权限：去 App 设置", () => {
    let { r } = mount({ helmet, link: "bluetoothOff" });
    expect(r.allText()).toContain(tr("guide.helmet.btOffTitle"));
    r.press(tr("guide.helmet.btOffAction"));
    expect(mockBluetoothAction).toHaveBeenCalled();
    r.unmount();
    const settings = jest
      .spyOn(Linking, "openSettings")
      .mockImplementation(() => Promise.resolve());
    ({ r } = mount({ helmet, link: "bluetoothDenied" }));
    expect(r.allText()).toContain(tr("guide.helmet.btDeniedTitle"));
    r.press(tr("guide.helmet.btDeniedAction"));
    expect(settings).toHaveBeenCalled();
    settings.mockRestore();
  });

  it("绑了在找头盔：提示打开头盔电源；找了 5 秒还没找到换一句更具体的", () => {
    const { r } = mount({ helmet, link: "searching" });
    expect(r.allText()).toContain(tr("guide.helmet.searchTitle"));
    const before = r.allText();
    settle(SEARCH_SLOW_MS);
    expect(r.allText()).not.toBe(before);
  });

  it("连上了：画勾、停一下，自动换到第二步（允许通知）；进度 1 / 3", () => {
    const { r } = mount({ helmet, link: "connected" });
    expect(r.allText()).toContain(tr("guide.helmet.linkedTitle"));
    settle();
    expect(useGuideStore.getState().state.r1).toBe("done");
    expect(r.allText()).toContain(tr("guide.notify.title"));
    expect(r.allText()).toContain("1 / 3");
  });

  it("人不在这一页时不自己打勾：回来之后才走", () => {
    const { update } = mount({ helmet, link: "connected", onStage: false });
    settle(10_000);
    expect(useGuideStore.getState().state.r1).toBe("");
    update({ onStage: true });
    settle();
    expect(useGuideStore.getState().state.r1).toBe("done");
  });

  it("刚绑上、连接结论还没出来（还没有 link）：按「在找头盔」写、徽标上有波纹，不当成没绑", () => {
    const { r } = mount({ helmet, link: undefined });
    expect(r.allText()).toContain(tr("guide.helmet.searchTitle"));
    expect(r.allText()).toContain(tr("guide.helmet.searching"));
    expect(r.allText()).not.toContain(tr("guide.helmet.bindTitle"));
    expect(useGuideStore.getState().state.r1).toBe("");
  });

  it("画勾用的路径 Skia 解析不出来：退回成系统的勾图标，照样打勾换下一件", () => {
    mockFlags.skiaPathNull = true;
    try {
      const { r } = mount({ helmet, link: "connected" });
      expect(r.icons()).toContain("checkmark");
      settle();
      expect(useGuideStore.getState().state.r1).toBe("done");
    } finally {
      mockFlags.skiaPathNull = false;
    }
  });
});

describe("第二、三步与收尾", () => {
  beforeEach(() => {
    act(() => useGuideStore.getState().mark(1, "done"));
  });

  it("允许通知：弹系统权限框，给了就画勾换到第三步", async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockImplementation(
      () => Promise.resolve({ granted: true }),
    );
    const { r } = mount({ helmet, link: "connected" });
    settle();
    expect(r.allText()).toContain(tr("guide.notify.allow"));
    await act(async () => {
      r.press(tr("guide.notify.allow"));
      await Promise.resolve();
    });
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
    settle();
    expect(useGuideStore.getState().state.r2).toBe("done");
    expect(r.allText()).toContain(tr("guide.contact.title"));
  });

  it("没给通知：卡片改口（去设置）；「稍后再说」记成跳过，不画勾直接下一件", async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockImplementation(
      () => Promise.resolve({ granted: false }),
    );
    const { r } = mount({ helmet, link: "connected" });
    settle();
    await act(async () => {
      r.press(tr("guide.notify.allow"));
      await Promise.resolve();
    });
    expect(r.allText()).toContain(tr("guide.notify.deniedBody"));
    r.press(tr("guide.later"));
    expect(useGuideStore.getState().state.r2).toBe("skipped");
    settle();
    expect(r.allText()).toContain(tr("guide.contact.title"));
  });

  it("弹窗里拒了、后来去系统设置打开了通知：回到前台重查到允许，卡片就打勾（弹窗的结果不一直压着）", async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockImplementation(
      () => Promise.resolve({ granted: false }),
    );
    const { r, update } = mount({ helmet, link: "connected" });
    settle();
    await act(async () => {
      r.press(tr("guide.notify.allow"));
      await Promise.resolve();
    });
    expect(r.allText()).toContain(tr("guide.notify.deniedBody"));
    // 回到前台那次重查：系统那边也是拒绝
    update({ notify: "denied" });
    settle();
    expect(r.allText()).toContain(tr("guide.notify.deniedBody"));
    expect(useGuideStore.getState().state.r2).toBe("");
    // 去设置里打开了，再回来重查到允许
    update({ notify: "granted" });
    settle();
    expect(useGuideStore.getState().state.r2).toBe("done");
  });

  it("系统权限框调不起来（请求直接报错）：不报错，卡片照旧、还能再点", async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockImplementation(
      () => Promise.reject(new Error("unavailable")),
    );
    const { r } = mount({ helmet, link: "connected" });
    settle();
    await act(async () => {
      r.press(tr("guide.notify.allow"));
      await Promise.resolve();
    });
    settle();
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(r.allText()).toContain(tr("guide.notify.allow"));
    expect(r.allText()).not.toContain(tr("guide.notify.deniedBody"));
    expect(useGuideStore.getState().state.r2).toBe("");
  });

  it("重查还没跟上（仍是点之前的结果）时先用弹窗的答复", async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockImplementation(
      () => Promise.resolve({ granted: true }),
    );
    const { r, update } = mount({ helmet, link: "connected" });
    settle();
    await act(async () => {
      r.press(tr("guide.notify.allow"));
      await Promise.resolve();
    });
    update({ notify: "undetermined" });
    settle();
    expect(useGuideStore.getState().state.r2).toBe("done");
  });

  it("第三步：添加联系人去添加页；已有联系人就自己打勾；三件都处理完交给衔接动画（量不到位置给 null）", () => {
    act(() => useGuideStore.getState().mark(2, "done"));
    const onFinished = jest.fn();
    const { r, update } = mount({
      helmet,
      link: "connected",
      notify: "granted",
      contacts: 0,
      onFinished,
    });
    settle();
    expect(r.allText()).toContain(tr("guide.contact.add"));
    r.press(tr("guide.contact.add"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/add-contact");
    update({ contacts: 2 });
    settle();
    expect(useGuideStore.getState().state.r3).toBe("done");
    expect(useGuideStore.getState().armed).toBe(true);
    settle(FINISH_MS);
    expect(onFinished).toHaveBeenCalledWith(null);
  });

  it("三件都处理完、量到了卡片和徽标的位置：交给衔接动画时带上这两个位置", () => {
    act(() => {
      useGuideStore.getState().mark(2, "done");
      useGuideStore.getState().mark(3, "skipped");
    });
    const onFinished = jest.fn();
    mount({ helmet, link: "connected", notify: "granted", onFinished });
    const card = { x: 16, y: 200, w: 358, h: 252 };
    const emblem = { x: 36, y: 220, w: 36, h: 36 };
    anchorRect.guideCard.set(card);
    anchorRect.guideEmblem.set(emblem);
    try {
      settle(FINISH_MS);
      expect(onFinished).toHaveBeenCalledWith({ card, emblem });
    } finally {
      anchorRect.guideCard.set(null);
      anchorRect.guideEmblem.set(null);
    }
  });

  it("最后一件点了「稍后」、还没变成设备页的那一下又点了一次「稍后」：不再记，收尾照常只交一次", () => {
    act(() => useGuideStore.getState().mark(2, "done"));
    const onFinished = jest.fn();
    const { r } = mount({
      helmet,
      link: "connected",
      notify: "granted",
      contacts: 0,
      onFinished,
    });
    settle();
    r.press(tr("guide.later"));
    expect(useGuideStore.getState().state.r3).toBe("skipped");
    const before = useGuideStore.getState().markedAt;
    // 最后一件还留在卡片上（等着交给衔接动画），它的「稍后」还在
    r.press(tr("guide.later"));
    expect(useGuideStore.getState()).toMatchObject({
      state: { r1: "done", r2: "done", r3: "skipped" },
      markedAt: before,
      armed: true,
    });
    settle(FINISH_MS);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("收尾途中人离开了：撤回（衔接层不先搭着），回来从头来一遍", () => {
    act(() => {
      useGuideStore.getState().mark(2, "done");
      useGuideStore.getState().mark(3, "skipped");
    });
    const onFinished = jest.fn();
    const { update } = mount({
      helmet,
      link: "connected",
      notify: "granted",
      contacts: 1,
      onFinished,
    });
    expect(useGuideStore.getState().armed).toBe(true);
    update({ onStage: false });
    expect(useGuideStore.getState().armed).toBe(false);
    settle(FINISH_MS * 2);
    expect(onFinished).not.toHaveBeenCalled();
    update({ onStage: true });
    settle(FINISH_MS);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});

describe("绑过又解绑的账号", () => {
  it("只有绑定那一张：没有后两张和进度；绑上就收尾", () => {
    act(() => {
      useGuideStore.getState().reset();
      useGuideStore.getState().begin("u1", true);
    });
    const onFinished = jest.fn();
    const { r, update } = mount({ bindOnly: true, onFinished });
    expect(r.allText()).toContain(tr("guide.helmet.bindTitle"));
    expect(r.allText()).not.toContain("0 / 3");
    update({ helmet, link: "connected" });
    settle();
    expect(useGuideStore.getState().state.r1).toBe("done");
    settle(FINISH_MS);
    expect(onFinished).toHaveBeenCalled();
  });
});

describe("开屏落到这一页（卡片从商标的位置立起来）", () => {
  // 开屏把「卡片开始立起来」的时刻写进 guideFrom，各样东西按晚多少出发跟着故事时间走
  const FROM = 2000;
  const at = (u: number) => {
    guideFrom.set(FROM);
    splashStory.set(FROM + u);
  };
  afterEach(() => {
    guideFrom.set(-1);
    splashStory.set(-1);
    anchorRect.guideCard.set(null);
  });
  /** 最前面那张卡（带透视的那块） */
  const front = (r: Rendered) => {
    const n = r.root.find(
      (x) =>
        typeof x.type === "string" &&
        transformOf(x).some((t) => t.perspective === 900),
    );
    const s = flat(n.props.style);
    const tf = Object.assign({}, ...transformOf(n)) as Record<string, unknown>;
    return { opacity: s.opacity, ...tf } as Record<string, unknown>;
  };
  /** 后面两张卡（会转一点角度、横竖各缩放） */
  const backs = (r: Rendered) =>
    r.root
      .findAll(
        (x) =>
          typeof x.type === "string" &&
          transformOf(x).some((t) => "scaleX" in t) &&
          transformOf(x).some((t) => "rotate" in t),
      )
      .map((n) => ({
        opacity: flat(n.props.style).opacity,
        rotate: transformOf(n).find((t) => "rotate" in t)!.rotate,
      }));

  it("最前面那张卡：一开始横躺着、缩小、看不见，从商标那里立起来，最后停在原位", () => {
    at(70);
    let { r } = mount();
    expect(front(r)).toMatchObject({
      opacity: 0,
      rotateX: "62deg",
      scale: 0.56,
      translateY: 0,
    });
    at(70 + 400);
    ({ r } = mount());
    const mid = front(r);
    expect(mid.opacity).toBe(1);
    expect(parseFloat(String(mid.rotateX))).toBeGreaterThan(0);
    expect(parseFloat(String(mid.rotateX))).toBeLessThan(62);
    expect(mid.scale as number).toBeGreaterThan(0.56);
    expect(mid.scale as number).toBeLessThan(1);
    at(70 + 2000);
    ({ r } = mount());
    expect(front(r)).toMatchObject({
      opacity: 1,
      rotateX: "0deg",
      scale: 1,
      translateY: 0,
    });
  });

  it("量到了卡片的位置：起点是商标在屏幕上的高度（比卡片中心低一截再往上立）", () => {
    const { width, height } = Dimensions.get("window");
    const markY = height / 2 - MARK_LIFT * (width / SCENE_W);
    anchorRect.guideCard.set({ x: 16, y: 200, w: 358, h: 252 });
    at(70);
    const { r } = mount();
    expect(front(r).translateY as number).toBeCloseTo(markY - (200 + 126) + 40);
  });

  it("后面两张随后落下来：先斜着、看不见，第三张比第二张晚一点；落定后摆正", () => {
    at(520);
    let { r } = mount();
    expect(backs(r)).toEqual([
      { opacity: 0, rotate: "-3deg" },
      { opacity: 0, rotate: "3deg" },
    ]);
    at(520 + 110 + 300);
    ({ r } = mount());
    const [second, third] = backs(r);
    expect(second.opacity as number).toBeGreaterThan(third.opacity as number);
    at(520 + 2000);
    ({ r } = mount());
    expect(backs(r).map((b) => b.rotate)).toEqual(["0deg", "0deg"]);
    expect(backs(r).every((b) => (b.opacity as number) > 0.99)).toBe(true);
  });

  it("商标落成徽标的那一下：徽标先大 22% 再回到原大", () => {
    at(760);
    let { r } = mount();
    expect(emblemScale(r)).toBeCloseTo(1.22);
    at(760 + 3000);
    ({ r } = mount());
    expect(emblemScale(r)).toBeCloseTo(1);
  });

  it("卡上的内容依次浮上来：一开始看不见，到点才出现；进度那一行最后出来", () => {
    at(0);
    let { r } = mount();
    expect(r.allText()).not.toContain(tr("guide.helmet.bindTitle"));
    expect(r.allText()).not.toContain("0 / 3");
    at(700);
    ({ r } = mount());
    expect(r.allText()).toContain(tr("guide.helmet.bindTitle"));
    expect(r.allText()).not.toContain("0 / 3");
    at(3000);
    ({ r } = mount());
    expect(r.allText()).toContain("0 / 3");
  });
});

describe("换到下一件那一段（停在某一毫秒看一帧）", () => {
  /** 沿边那道光每画一张图：边上的光画了几笔、按钮那块光画了几块 */
  let drawn: { paths: number; rrects: number }[] = [];
  let pictures: ReturnType<typeof jest.spyOn>;
  /** advanceAt 之前已经做完的几件 */
  let marks: (1 | 2)[] = [];
  beforeEach(() => {
    drawn = [];
    pictures = jest.spyOn(SkiaModule, "createPicture").mockImplementation(((
      cb: (canvas: unknown) => void,
    ) => {
      const d = { paths: 0, rrects: 0 };
      cb({
        drawPath: () => {
          d.paths += 1;
        },
        drawRRect: () => {
          d.rrects += 1;
        },
      });
      drawn.push(d);
      return { kind: "picture" };
    }) as never);
  });
  afterEach(() => {
    pictures.mockRestore();
    mockBeat.at = null;
    marks = [];
  });
  /**
   * 轮到的这件已经具备：等它自己打勾、换到下一件，这一段停在第 ms 毫秒。
   * 这一页刚搭好时会先几乎全透明地画几帧光（预热），先过了那一段再记。
   * 同一个用例里看第二帧之前先卸掉上一棵树：它还挂着的话，它的自动打勾会抢先把这一件记掉
   */
  const advanceAt = (ms: number, p: Partial<Props> = {}) => {
    // 每一帧都从头走：上一帧已经把这一件记成做完了
    act(() => {
      useGuideStore.getState().reset();
      useGuideStore.getState().begin("u1");
      for (const step of marks) useGuideStore.getState().mark(step, "done");
    });
    mockBeat.at = ms;
    const m = mount({ helmet, link: "connected", ...p });
    settle(300);
    drawn = [];
    settle();
    return m;
  };
  /** 徽标外面泛开的那一圈 */
  const ripple = (r: Rendered) => {
    const st = flat(
      r.root.find(
        (x) =>
          typeof x.type === "string" &&
          flat(x.props.style).width === 170 &&
          flat(x.props.style).borderRadius === 85,
      ).props.style,
    );
    return {
      opacity: st.opacity as number,
      scale: (st.transform as Tf)[0].scale as number,
    };
  };

  it("做完一件：光先从按钮下面沿卡片的边走回徽标（按钮那块不亮），光到之前徽标不动", () => {
    const { r } = advanceAt(200);
    expect(useGuideStore.getState().state.r1).toBe("done");
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn[drawn.length - 1]).toEqual({ paths: 2, rrects: 0 });
    expect(emblemScale(r)).toBe(1);
    expect(ripple(r).opacity).toBe(0);
  });

  it("光到了徽标：徽标放大 20% 应一下，同时往外泛一圈（先亮起来再淡掉、越扩越大）", () => {
    let { r } = advanceAt(524);
    expect(emblemScale(r)).toBeCloseTo(1.2);
    r.unmount();
    ({ r } = advanceAt(402));
    // 泛开的头 15% 是亮起来的那一段
    const early = ripple(r);
    expect(early.opacity).toBeCloseTo(0.4);
    expect(early.scale).toBeCloseTo(lerp(0.18, 0.88, easeOut(0.1)));
    r.unmount();
    ({ r } = advanceAt(650));
    const late = ripple(r);
    expect(late.opacity).toBeCloseTo((0.6 * 0.5) / 0.85);
    expect(late.scale).toBeGreaterThan(early.scale);
  });

  it("下一件还要人去做：光再从徽标出去、停在按钮下面，到了把按钮点亮（只亮按钮那一块）", () => {
    const { r } = advanceAt(800);
    expect(drawn[drawn.length - 1]).toEqual({ paths: 2, rrects: 0 });
    r.unmount();
    advanceAt(1300);
    expect(drawn[drawn.length - 1]).toEqual({ paths: 0, rrects: 1 });
  });

  it("点了「稍后」：光不往回走、徽标也不应，只有光出去点亮下一件的按钮", () => {
    /** 第二件（允许通知）点「稍后」，这一段停在第 ms 毫秒 */
    const skipAt = (ms: number) => {
      act(() => {
        useGuideStore.getState().reset();
        useGuideStore.getState().begin("u1");
        useGuideStore.getState().mark(1, "done");
      });
      mockBeat.at = ms;
      const m = mount({ helmet, link: "connected" });
      settle(300);
      drawn = [];
      m.r.press(tr("guide.later"));
      expect(useGuideStore.getState().state.r2).toBe("skipped");
      return m;
    };
    // 第 370 毫秒：做完的话光快走到徽标、徽标刚开始应、往外泛一圈；跳过的这时什么都没有
    const { r } = skipAt(370);
    expect(drawn).toEqual([]);
    expect(emblemScale(r)).toBe(1);
    expect(ripple(r).opacity).toBe(0);
    r.unmount();
    // 第 800 毫秒：光照样出去，去点亮第三件的「添加联系人」
    skipAt(800);
    expect(drawn[drawn.length - 1]).toEqual({ paths: 2, rrects: 0 });
  });

  it("最后一件做完：光走回徽标，但不再出去（没有下一件的按钮要点亮）", () => {
    marks = [1, 2];
    const { r } = advanceAt(800, { notify: "granted", contacts: 1 });
    expect(useGuideStore.getState().state.r3).toBe("done");
    expect(drawn).toEqual([]);
    r.unmount();
    advanceAt(200, { notify: "granted", contacts: 1 });
    expect(useGuideStore.getState().state.r3).toBe("done");
    expect(drawn[drawn.length - 1]).toEqual({ paths: 2, rrects: 0 });
  });

  it("自己打勾和手点「稍后」前后脚到（同一件）：只记先到的「做完」，换下一件那一段也不重来一遍", () => {
    act(() => useGuideStore.getState().mark(1, "done"));
    mockBeat.at = 524;
    const { r, update } = mount({ helmet, link: "connected" });
    settle();
    // 手指按下「稍后」的那一刻，卡片上还是旧的那一版
    const later = handlerOf(r, tr("guide.later"));
    update({ notify: "granted" });
    settle();
    expect(useGuideStore.getState().state.r2).toBe("done");
    expect(emblemScale(r)).toBeCloseTo(1.2);
    act(() => later());
    update({ notify: "granted" });
    expect(useGuideStore.getState().state).toMatchObject({
      r2: "done",
      r3: "",
    });
    // 光走回徽标、徽标应一下的那一段还在（不会被换成「跳过」那种不应的样子）
    expect(emblemScale(r)).toBeCloseTo(1.2);
  });
});

describe("浅色外观", () => {
  it("卡片的描边和底色跟着主题：深色才用半透明白边和深色渐变底", () => {
    useThemeStore.setState({ mode: "light" });
    const { r } = mount();
    const L = Colors.light;
    // 最前面那张带透视；后面压着的两张会转一点角度、横向缩放
    const cards = r.root.findAll(
      (x) =>
        typeof x.type === "string" &&
        (transformOf(x).some((t) => t.perspective === 900) ||
          (transformOf(x).some((t) => "rotate" in t) &&
            transformOf(x).some((t) => "scaleX" in t))),
    );
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => flat(c.props.style).borderColor)).toEqual(
      Array(3).fill(L.border),
    );
    expect(
      cards.map(
        (c) =>
          c.findAll(
            (x) =>
              typeof x.type === "string" &&
              flat(x.props.style).backgroundColor === L.backgroundElement,
          ).length > 0,
      ),
    ).toEqual([true, true, true]);
    expect(
      r.root.findAll(
        (x) =>
          typeof x.type === "string" &&
          String(
            flat(x.props.style).experimental_backgroundImage ?? "",
          ).startsWith("linear-gradient"),
      ),
    ).toHaveLength(0);
  });
});
