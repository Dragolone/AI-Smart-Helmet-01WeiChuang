// 设备页还没绑定头盔时的三步指引（一张卡走到底）：每一步卡片上写什么、按钮去哪、「稍后」记成跳过、
// 具备了就自己打勾换下一件（只在人看着这一页时走）、三件都处理完交给衔接动画；绑过又解绑的只有绑定那一张。
// 判断逻辑在 services/device-guide（已有单测），这里看组件把它接成了什么样。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { DevicePublic } from "@helmet/shared";
import * as Notifications from "expo-notifications";
import { Dimensions, Linking } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";

import { mockRouter } from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  render,
  type Rendered,
} from "@/__tests__/helpers/render";
import { anchorRect, guideFrom, splashStory } from "@/components/splash/bus";
import { MARK_LIFT, SCENE_W } from "@/components/splash/route-scene";
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
jest.mock("react-native-reanimated", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock(),
);
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
  type Tf = Record<string, number | string>[];
  const transformOf = (n: ReactTestInstance) =>
    (flat(n.props.style).transform ?? []) as Tf;
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
