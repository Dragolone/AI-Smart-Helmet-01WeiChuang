// 控件类组件：环形仪表、呼吸波纹、求救倒计时圆环（只画，不改）、音量滑杆、分段控件、滑动取消（只测不改）、
// 设备设置项（开关 / 档位 / 步进三种控件、待确认描边、回执五种状态）与设置分类页。
// 手势用替身记录回调，直接调 onStart / onUpdate / onFinalize 看组件怎么反应。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CommandPublic, DeviceSettingKey } from "@helmet/shared";
import * as Haptics from "expo-haptics";
import { cloneElement } from "react";
import { Animated as RNAnimated, Text, View } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";

import {
  mockFlags,
  type RecordedGesture,
} from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  makeQueryClient,
  render,
  rootJson,
  type Rendered,
} from "@/__tests__/helpers/render";
import { devicesApi } from "@/api/devices";
import { Colors } from "@/constants/theme";
import { useDeviceSettings } from "@/hooks/use-device-settings";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { useThemeStore } from "@/stores/theme-store";
import { CountdownRing } from "../countdown-ring";
import {
  CommandFeedback,
  DeviceSettingList,
  EXPOSED_SETTINGS,
  levelLabelKey,
} from "../device-settings";
import { DeviceContext, DeviceSettingsPage } from "../device-settings-page";
import { FluidSegmented, type SegmentPalette } from "../fluid-segmented";
import { PulseRing } from "../pulse-ring";
import { RingGauge } from "../ring-gauge";
import { SlideToCancel, type SlideColors } from "../slide-to-cancel";
import { Tappable } from "../tappable";
import {
  VOLUME_LOUD_THRESHOLD,
  VOLUME_RECOMMENDED,
  VolumeSlider,
  clampVolume,
} from "../volume-slider";

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
jest.mock("react-native-gesture-handler", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .gestureMock(),
);
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  selectionAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("@/api/devices", () => ({
  devicesApi: { detail: jest.fn(), status: jest.fn(), list: jest.fn() },
}));
jest.mock("@/hooks/use-device-settings", () => ({
  useDeviceSettings: jest.fn(),
}));

const dark = Colors.dark;
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  mockFlags.reducedMotion = false;
});
afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

/** 渲染两次：effect 里写进共享值的终值在第二次渲染时生效（第二次要是新元素，不然 React 直接跳过） */
const settle = (el: React.ReactElement) => {
  const r = render(el);
  r.rerender(cloneElement(el));
  return r;
};
const deg = (style: Record<string, unknown>) =>
  parseFloat((style.transform as { rotate: string }[])[0].rotate);
/** 手势记录器 */
const gestureOf = (r: Rendered): RecordedGesture =>
  r.root.find((n) => isHost(n, "GestureDetector")).props.gesture;

describe("RingGauge", () => {
  const rotations = (r: Rendered) =>
    r.root
      .findAll(
        (n) =>
          typeof n.type === "string" &&
          Array.isArray(flat(n.props.style).transform) &&
          String(
            (flat(n.props.style).transform as { rotate?: string }[])[0]
              ?.rotate ?? "",
          ).endsWith("deg"),
      )
      .map((n) => deg(flat(n.props.style)));

  it.each([
    [0, 0, 0],
    [30, 108, 0],
    [50, 180, 0],
    [75, 180, 90],
    [100, 180, 180],
    [140, 180, 180],
    [-10, 0, 0],
  ])("value=%i：右半环转 %i°、左半环转 %i°", (value, right, left) => {
    const r = settle(
      <RingGauge value={value} color="#0f0" track="#222" inner="#111" />,
    );
    const [a, b] = rotations(r);
    expect(a).toBeCloseTo(right, 6);
    expect(b).toBeCloseTo(left, 6);
  });

  it("中心盘按线宽缩进，盖卡片底色；children 放在中心", () => {
    const r = render(
      <RingGauge
        value={10}
        size={80}
        stroke={10}
        color="#0f0"
        track="#222"
        inner="#111"
      >
        <Text>78</Text>
      </RingGauge>,
    );
    const center = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).backgroundColor === "#111",
    );
    const s = flat(center.props.style);
    expect([s.left, s.top, s.width, s.height, s.borderRadius]).toEqual([
      10, 10, 60, 60, 30,
    ]);
    expect(r.allText()).toBe("78");
    expect(flat(rootJson(r).props.style).backgroundColor).toBe("#222");
  });
});

describe("PulseRing", () => {
  let loop: ReturnType<typeof jest.spyOn>;
  const start = jest.fn();
  const stop = jest.fn();
  beforeEach(() => {
    loop = jest
      .spyOn(RNAnimated, "loop")
      .mockReturnValue({ start, stop, reset: jest.fn() } as never);
  });
  afterEach(() => loop.mockRestore());

  it("不活动时不渲染；活动时按 count 画几圈并启动循环，停下时停掉", () => {
    const r = render(<PulseRing active={false} size={60} color="#f00" />);
    expect(r.tree.toJSON()).toBeNull();
    expect(start).not.toHaveBeenCalled();
    r.rerender(<PulseRing active size={60} color="#f00" count={3} />);
    const rings = r.root.findAll(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).borderColor === "#f00",
    );
    expect(rings).toHaveLength(2); // count 只在第一次挂上时决定（惰性初始化）
    expect(start).toHaveBeenCalledTimes(2);
    expect(flat(rings[0].props.style).width).toBe(60);
    expect(flat(rings[0].props.style).borderRadius).toBe(30);
    r.rerender(<PulseRing active={false} size={60} color="#f00" count={3} />);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(r.tree.toJSON()).toBeNull();
  });
});

describe("CountdownRing", () => {
  const ring = (p: number) => {
    const progress = { value: p, get: () => p, set: () => undefined } as never;
    return render(
      <CountdownRing size={252} progress={progress} color="#f00" track="#333">
        <Text>58</Text>
      </CountdownRing>,
    );
  };
  /** 进度那一组的宿主节点：第一个是整段四边，然后裁剪盒、四段接缝、前沿那段 */
  const parts = (r: Rendered) => {
    const hostOf = (n: ReactTestInstance): ReactTestInstance =>
      typeof n.type === "string"
        ? n
        : hostOf(n.children[0] as ReactTestInstance);
    const frame = r.root
      .findAll((n) => typeof n.type === "string")[0]
      .children.map((c) => hostOf(c as ReactTestInstance))[1];
    const kids = (frame.children as ReactTestInstance[])
      .map(hostOf)
      .map((n) => flat(n.props.style));
    return {
      frame: flat(frame.props.style),
      full: kids[0],
      seams: kids.slice(2, 6),
      rest: kids[6],
    };
  };

  it("满圈：四段都上色、四处接缝都盖上", () => {
    const p = parts(ring(1));
    expect(p.frame.opacity).toBe(1);
    expect([
      p.full.borderTopColor,
      p.full.borderRightColor,
      p.full.borderBottomColor,
      p.full.borderLeftColor,
    ]).toEqual(["#f00", "#f00", "#f00", "#f00"]);
    expect(p.seams.map((s) => s.opacity)).toEqual([1, 1, 1, 1]);
    expect(deg(p.rest)).toBe(315);
  });

  it("还剩一半：前两段上色；接缝只盖 90° 那一处", () => {
    const p = parts(ring(0.5));
    expect([
      p.full.borderTopColor,
      p.full.borderRightColor,
      p.full.borderBottomColor,
    ]).toEqual(["#f00", "#f00", "transparent"]);
    expect(p.seams.map((s) => s.opacity)).toEqual([0, 1, 0, 0]);
    expect(p.rest.opacity).toBe(1);
  });

  it("走完：整组不显示；底环和中间的读数还在", () => {
    const r = ring(0);
    expect(parts(r).frame.opacity).toBe(0);
    expect(r.allText()).toBe("58");
    const track = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).borderColor === "#333",
    );
    expect(track).toBeTruthy();
  });
});

describe("VolumeSlider", () => {
  const props = () => ({
    onRelease: jest.fn(),
    onStep: jest.fn(),
    onDraggingChange: jest.fn(),
  });
  const pan = (r: Rendered) => gestureOf(r).gestures![0];
  const tap = (r: Rendered) => gestureOf(r).gestures![1];
  const layout = (r: Rendered, width: number) => {
    const hit = r.root.find(
      (n) =>
        typeof n.type === "string" && typeof n.props.onLayout === "function",
    );
    act(() => hit.props.onLayout({ nativeEvent: { layout: { width } } }));
  };

  it("clampVolume：按 5 取整、夹在 10–100", () => {
    expect([
      clampVolume(0),
      clampVolume(12),
      clampVolume(13),
      clampVolume(77),
      clampVolume(250),
    ]).toEqual([10, 10, 15, 75, 100]);
    expect(VOLUME_LOUD_THRESHOLD).toBe(VOLUME_RECOMMENDED);
  });

  it("普通音量：品牌色、显示百分比，刻度写推荐上限", () => {
    const r = render(
      <VolumeSlider value={62} {...props()} icon="volume-high" />,
    );
    expect(r.texts()).toEqual([
      tr("device.volume"),
      "60%",
      "10%",
      tr("device.volumeRecommended", { n: VOLUME_RECOMMENDED }),
      "100%",
    ]);
    expect(r.icons()).toEqual(["volume-high"]);
    const fill = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).position === "absolute" &&
        flat(n.props.style).width === "60%",
    );
    expect(flat(fill.props.style).backgroundColor).toBe(dark.brand);
  });

  it("超过推荐线：红色并标「高音量」；应用中：灰显、标「正在应用」、手势禁用", () => {
    let r = render(<VolumeSlider value={85} {...props()} />);
    expect(r.texts()[1]).toBe(`85% · ${tr("device.volumeLoud")}`);
    expect(flat(r.root.findAllByType(Text)[1].props.style).color).toBe(
      dark.sos,
    );
    r = render(<VolumeSlider value={85} pending {...props()} />);
    expect(r.texts()[1]).toBe(`85% · ${tr("device.applying")}`);
    expect(pan(r).config.enabled).toEqual([false]);
    expect(tap(r).config.enabled).toEqual([false]);
  });

  it("拖动：开始时通知拖动中，跨档才回调（带选择触觉），松手交出最后一档", () => {
    const p = props();
    const r = render(<VolumeSlider value={50} {...p} />);
    layout(r, 200);
    const g = pan(r);
    expect(g.config.activeOffsetX).toEqual([[-4, 4]]);
    act(() => g.handlers.onBegin({ x: 100 }));
    act(() => g.handlers.onStart({ x: 100 }));
    expect(p.onDraggingChange).toHaveBeenCalledWith(true);
    // 50% 处就是原值 50：不算跨档
    expect(p.onStep).not.toHaveBeenCalled();
    act(() => g.handlers.onUpdate({ x: 101 }));
    expect(p.onStep).not.toHaveBeenCalled();
    act(() => g.handlers.onUpdate({ x: 180 }));
    expect(p.onStep).toHaveBeenCalledWith(90);
    expect(Haptics.selectionAsync).toHaveBeenCalled();
    // 拖动中显示拖到的值（超过推荐线变红）
    expect(r.texts()[1]).toBe(`90% · ${tr("device.volumeLoud")}`);
    act(() => g.handlers.onUpdate({ x: 999 }));
    expect(p.onStep).toHaveBeenLastCalledWith(100);
    act(() => g.handlers.onFinalize({}, true));
    expect(p.onRelease).toHaveBeenCalledWith(100);
    expect(p.onDraggingChange).toHaveBeenLastCalledWith(false);
  });

  it("手势没成立（被上下滚动抢走）：不交出结果", () => {
    const p = props();
    const r = render(<VolumeSlider value={50} {...p} />);
    layout(r, 200);
    act(() => pan(r).handlers.onFinalize({}, false));
    expect(p.onRelease).not.toHaveBeenCalled();
  });

  it("点一下：直接跳到那一档并交出", () => {
    const p = props();
    const r = render(<VolumeSlider value={50} {...p} />);
    layout(r, 200);
    act(() => tap(r).handlers.onEnd({ x: 20 }));
    expect(p.onStep).toHaveBeenCalledWith(10);
    expect(p.onRelease).toHaveBeenCalledWith(10);
  });
});

describe("FluidSegmented", () => {
  const palette: SegmentPalette = {
    thumb: "#T",
    activeText: "#A",
    text: "#N",
    tentativeText: "#P",
    outline: "#O",
  };
  const options = [
    { value: 0, label: "关" },
    { value: 1, label: "低" },
    { value: 2, label: "高" },
  ] as const;
  const segs = (r: Rendered) =>
    r.root.findAll(
      (n) => n.type === Tappable && n.props.accessibilityRole === "radio",
    );
  const textColor = (r: Rendered, label: string) =>
    flat(
      r.root.findAllByType(Text).find((t) => t.props.children === label)!.props
        .style,
    ).color;
  const borderOf = (seg: ReactTestInstance) =>
    flat(
      seg.findAll(
        (n) =>
          typeof n.type === "string" && flat(n.props.style).borderWidth === 1.5,
      )[0].props.style,
    ).borderColor;
  /** 量布局：整条 300 宽，三段各 100 */
  const measure = (r: Rendered) => {
    const root = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityRole === "radiogroup",
    );
    segs(r).forEach((s, i) =>
      act(() =>
        s.props.onLayout({
          nativeEvent: { layout: { x: i * 100, y: 2, width: 100, height: 40 } },
        }),
      ),
    );
    act(() => root.props.onLayout({ nativeEvent: { layout: { width: 300 } } }));
  };
  const thumb = (r: Rendered) =>
    flat(
      r.root.find(
        (n) => typeof n.type === "string" && n.props.pointerEvents === "none",
      ).props.style,
    );

  it("高亮的是 current（实心滑块上的字），待确认那段描边、不填色", () => {
    const onSelect = jest.fn();
    const r = render(
      <FluidSegmented
        options={options}
        current={1}
        tentative={2}
        palette={palette}
        onSelect={onSelect}
        accessibilityLabel="大灯"
      />,
    );
    expect(segs(r).map((s) => s.props.accessibilityState)).toEqual([
      { checked: false, disabled: false },
      { checked: true, disabled: false },
      { checked: false, disabled: false },
    ]);
    expect([
      textColor(r, "关"),
      textColor(r, "低"),
      textColor(r, "高"),
    ]).toEqual(["#N", "#A", "#P"]);
    expect(borderOf(segs(r)[2])).toBe("#O");
    expect(borderOf(segs(r)[0])).toBe("transparent");
    r.press("高");
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("量到布局后滑块放到 current 那段；current 变了滑过去，变成没有时淡掉", () => {
    const el = (current: number | null) => (
      <FluidSegmented
        options={options}
        current={current}
        palette={palette}
        onSelect={() => undefined}
      />
    );
    const r = render(el(1));
    measure(r);
    r.rerender(el(1));
    expect(thumb(r)).toMatchObject({
      left: 100,
      right: 100,
      top: 2,
      height: 40,
      opacity: 1,
    });
    r.rerender(el(2));
    r.rerender(el(2));
    expect(thumb(r)).toMatchObject({ left: 200, right: 0 });
    r.rerender(el(0));
    r.rerender(el(0));
    expect(thumb(r)).toMatchObject({ left: 0, right: 200 });
    r.rerender(el(null));
    r.rerender(el(null));
    expect(thumb(r).opacity).toBe(0);
  });

  it("减弱动态效果：直接跳到位；没量到布局时先不放", () => {
    mockFlags.reducedMotion = true;
    const el = (current: number) => (
      <FluidSegmented
        options={options}
        current={current}
        palette={palette}
        onSelect={() => undefined}
      />
    );
    const r = render(el(0));
    r.rerender(el(2));
    expect(thumb(r).opacity).toBe(0);
    measure(r);
    r.rerender(el(2));
    expect(thumb(r)).toMatchObject({ left: 200, right: 0, opacity: 1 });
  });

  it("筛选 chip 那种：平时有描边，高亮那段描边跟滑块同色；按内容宽；禁用变淡", () => {
    const r = render(
      <FluidSegmented
        options={options}
        current={0}
        palette={{ ...palette, border: "#B" }}
        equal={false}
        disabled
        onSelect={() => undefined}
      />,
    );
    expect(borderOf(segs(r)[0])).toBe("#T");
    expect(borderOf(segs(r)[1])).toBe("#B");
    expect(segs(r)[0].props.style).toBe(false);
    const root = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityRole === "radiogroup",
    );
    expect(flat(root.props.style).opacity).toBe(0.45);
    expect(segs(r)[1].props.disabled).toBe(true);
  });
});

describe("SlideToCancel（求救倒计时页的滑动取消：只测不改）", () => {
  const colors: SlideColors = {
    track: "#t",
    trackBorder: "#b",
    fill: "#f",
    thumb: "#th",
    thumbIcon: "#ti",
    text: "#x",
    hint: "#h",
  };
  const mount = (over: Partial<Parameters<typeof SlideToCancel>[0]> = {}) => {
    const onCancel = jest.fn();
    const props = {
      label: "滑动取消求救",
      busyLabel: "取消中…",
      a11yLabel: "取消求救",
      a11yHint: "双击取消",
      busy: false,
      disabled: false,
      colors,
      onCancel,
      ...over,
    };
    const r = render(<SlideToCancel {...props} />);
    // 轨道 300 宽：可拖行程 = 300 - 2 - 64 - 6 = 228
    act(() =>
      r.root
        .find(
          (n) =>
            typeof n.type === "string" &&
            typeof n.props.onLayout === "function",
        )
        .props.onLayout({ nativeEvent: { layout: { width: 300 } } }),
    );
    r.rerender(<SlideToCancel {...props} />);
    return { r, onCancel, props };
  };
  const thumbX = (r: Rendered) => {
    const t = r.root.find(
      (n) =>
        typeof n.type === "string" && n.props.accessibilityRole === "button",
    );
    return (flat(t.props.style).transform as { translateX: number }[])[0]
      .translateX;
  };

  it("空闲：显示提示文字和箭头，圆钮在左端；读屏可以双击直接取消", () => {
    const { r, onCancel } = mount();
    expect(r.texts()).toEqual(["滑动取消求救"]);
    expect(r.icons()).toEqual(["chevron-forward", "arrow-forward"]);
    expect(thumbX(r)).toBe(0);
    const t = r.root.find(
      (n) =>
        typeof n.type === "string" && n.props.accessibilityRole === "button",
    );
    expect(t.props.accessibilityLabel).toBe("取消求救");
    expect(t.props.accessibilityHint).toBe("双击取消");
    expect(t.props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
    act(() =>
      t.props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() =>
      t.props.onAccessibilityAction({
        nativeEvent: { actionName: "magicTap" },
      }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("拖过 70% 松手 = 取消（成功触觉）；没到就弹回（轻触觉）", () => {
    const { r, onCancel } = mount();
    const g = gestureOf(r);
    expect(g.config.enabled).toEqual([true]);
    act(() => g.handlers.onBegin());
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    act(() => g.handlers.onUpdate({ translationX: 100 }));
    act(() => g.handlers.onFinalize({}, true));
    expect(onCancel).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
    act(() => g.handlers.onUpdate({ translationX: 9999 }));
    act(() => g.handlers.onFinalize({}, true));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith("success");
  });

  it("只点了一下没拖：不取消（圆钮探一下再回来）", () => {
    const { r, onCancel } = mount();
    act(() => gestureOf(r).handlers.onFinalize({}, false));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("取消在路上：圆钮停右端、写「取消中…」、不能拖也不能双击", () => {
    const { r, onCancel } = mount({ busy: true });
    expect(r.texts()).toEqual(["取消中…"]);
    expect(thumbX(r)).toBe(228);
    expect(gestureOf(r).config.enabled).toEqual([false]);
    const t = r.root.find(
      (n) =>
        typeof n.type === "string" && n.props.accessibilityRole === "button",
    );
    expect(t.props.accessibilityLabel).toBe("取消中…");
    expect(t.props.accessibilityHint).toBeUndefined();
    act(() =>
      t.props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("别的操作在路上（disabled）：整条变淡、不能拖", () => {
    const { r } = mount({ disabled: true });
    expect(flat(rootJson(r).props.style).opacity).toBe(0.5);
    expect(gestureOf(r).config.enabled).toEqual([false]);
  });

  it("还没量到宽度时不能拖", () => {
    const r = render(
      <SlideToCancel
        label="l"
        busyLabel="b"
        a11yLabel="a"
        a11yHint="h"
        busy={false}
        disabled={false}
        colors={colors}
        onCancel={() => undefined}
      />,
    );
    expect(gestureOf(r).config.enabled).toEqual([false]);
  });
});

describe("设备设置项", () => {
  const cmd = (over: Partial<CommandPublic>): CommandPublic => ({
    commandId: "c1",
    deviceId: "h1",
    type: "settings",
    params: { light: 2 },
    status: "pending",
    issuedAt: "2026-10-16T01:00:00.000Z",
    deliveredAt: null,
    ackResult: null,
    errorCode: null,
    executedAt: null,
    ...over,
  });

  it("levelLabelKey：档位型按 min 偏移取文案；非档位、非数字、越界都没有", () => {
    expect(levelLabelKey("light", 0)).toBe("device.level.off");
    expect(levelLabelKey("fallSensitivity", 1)).toBe("device.level.senLow");
    expect(levelLabelKey("fallSensitivity", 0)).toBeNull();
    expect(levelLabelKey("light", 9)).toBeNull();
    expect(levelLabelKey("light", true)).toBeNull();
    expect(levelLabelKey("buzzer", 1)).toBeNull();
    expect(EXPOSED_SETTINGS).toHaveLength(10);
  });

  it.each<
    [CommandPublic["status"], Partial<CommandPublic>, string, string | null]
  >([
    ["pending", {}, tr("device.cmd.pending"), "time-outline"],
    ["delivered", {}, tr("device.cmd.delivered"), "time-outline"],
    ["success", {}, tr("device.cmd.success"), null],
    ["failed", {}, tr("device.cmd.failed"), "close-circle-outline"],
    [
      "failed",
      { errorCode: "ERR_EPROM_LOCKED" },
      `${tr("device.err.locked")}（ERR_EPROM_LOCKED）`,
      "close-circle-outline",
    ],
    [
      "failed",
      { errorCode: "WEIRD_42" },
      `${tr("device.cmd.failed")}（WEIRD_42）`,
      "close-circle-outline",
    ],
    ["offline", {}, tr("device.cmd.offline"), "cloud-offline-outline"],
  ])("回执 %s：文字和图标", (status, over, text, icon) => {
    const r = render(
      <CommandFeedback command={cmd({ status, ...over })} settingKey="light" />,
    );
    expect(r.texts()).toEqual([text]);
    if (icon) expect(r.icons()).toEqual([icon]);
    else expect(r.root.findAll((n) => isHost(n, "SkiaPath"))).toHaveLength(2);
  });

  it("已生效带执行时间：写上时间；命令没改这一项 / 没有命令：不显示", () => {
    const at = new Date().toISOString();
    const r = render(
      <CommandFeedback
        command={cmd({ status: "success", executedAt: at })}
        settingKey="light"
      />,
    );
    expect(r.texts()[0]).toMatch(/^已生效 · \d{2}:\d{2}$/);
    expect(
      render(
        <CommandFeedback command={cmd({})} settingKey="radar" />,
      ).tree.toJSON(),
    ).toBeNull();
    expect(
      render(
        <CommandFeedback command={null} settingKey="light" />,
      ).tree.toJSON(),
    ).toBeNull();
  });

  const list = (
    props: Partial<Parameters<typeof DeviceSettingList>[0]> = {},
  ) => {
    const onChange = jest.fn();
    const r = render(
      <DeviceSettingList
        settings={undefined}
        disabled={false}
        onChange={onChange}
        {...props}
      />,
    );
    return { r, onChange };
  };
  const rowsOf = (r: Rendered) =>
    r.root.findAll(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).paddingVertical === 12,
    );
  const radios = (row: ReactTestInstance) =>
    row.findAll(
      (n) => n.type === Tappable && n.props.accessibilityRole === "radio",
    );

  it("开关项：头盔上报过的值实心高亮；点「关」只回调、不先翻过去", () => {
    const { r, onChange } = list({
      keys: ["radar"],
      settings: { radar: true },
    });
    const [on, off] = radios(rowsOf(r)[0]);
    expect(on.props.accessibilityState.checked).toBe(true);
    expect(off.props.accessibilityState.checked).toBe(false);
    act(() => off.props.onPress());
    expect(onChange).toHaveBeenCalledWith("radar", false);
    expect(radios(rowsOf(r)[0])[0].props.accessibilityState.checked).toBe(true);
  });

  it("头盔从没上报：没有实心高亮，出厂默认那段描边，并说明「显示的是默认值」", () => {
    const { r } = list({ keys: ["radar"], settings: {} });
    const rs = radios(rowsOf(r)[0]);
    expect(rs.map((x) => x.props.accessibilityState.checked)).toEqual([
      false,
      false,
    ]);
    expect(r.allText()).toContain(tr("device.unconfirmedDefault"));
  });

  it("档位项：标题右边写当前档；带说明；在途命令的目标档描边", () => {
    const { r, onChange } = list({
      keys: ["light"],
      settings: { light: 1 },
      lastCommand: cmd({ params: { light: 3 }, status: "delivered" }),
      icons: { light: "flashlight-outline" },
    });
    const text = r.allText();
    expect(text).toContain(tr("device.set.light"));
    expect(text).toContain(tr("device.level.lightLow"));
    expect(text).toContain(tr("device.hint.light"));
    expect(text).toContain(tr("device.cmd.delivered"));
    expect(r.icons()).toContain("flashlight-outline");
    const rs = radios(rowsOf(r)[0]);
    expect(rs).toHaveLength(4);
    expect(rs[1].props.accessibilityState.checked).toBe(true);
    act(() => rs[2].props.onPress());
    expect(onChange).toHaveBeenCalledWith("light", 2);
  });

  it("历史上存过 light: true（旧格式）按低亮档显示；类型不对的值当作没上报", () => {
    let { r } = list({ keys: ["light"], settings: { light: true } });
    expect(radios(rowsOf(r)[0])[1].props.accessibilityState.checked).toBe(true);
    ({ r } = list({
      keys: ["light", "radar"],
      settings: { light: "x", radar: 1 },
    }));
    expect(
      radios(rowsOf(r)[0]).some((x) => x.props.accessibilityState.checked),
    ).toBe(false);
    expect(
      radios(rowsOf(r)[1]).some((x) => x.props.accessibilityState.checked),
    ).toBe(false);
    // 第二行起有分隔线
    expect(flat(rowsOf(r)[1].props.style).borderTopWidth).toBeGreaterThan(0);
    expect(flat(rowsOf(r)[0].props.style).borderTopWidth).toBeUndefined();
  });

  it("步进项（雷达距离）：按 5 m 加减，到边界那一侧按钮不可点；没上报时显示默认值", () => {
    const { r, onChange } = list({
      keys: ["radarDistance"],
      settings: { radarDistance: 30 },
    });
    expect(r.allText()).toContain("30m");
    const plus = r.root.find(
      (n) => n.type === Tappable && n.props.accessibilityLabel === "+",
    );
    const minus = r.root.find(
      (n) => n.type === Tappable && n.props.accessibilityLabel === "−",
    );
    expect(plus.props.disabled).toBe(true);
    expect(minus.props.disabled).toBe(false);
    act(() => minus.props.onPress());
    expect(onChange).toHaveBeenCalledWith("radarDistance", 25);
    const fresh = list({ keys: ["radarDistance"], settings: {} });
    expect(fresh.r.allText()).toContain("15m");
    const num = fresh.r.root
      .findAllByType(Text)
      .find((t) => String(t.props.children).startsWith("15"));
    expect(flat(num!.props.style).color).toBe(dark.textSecondary);
  });

  it("整体禁用（有命令在发）：所有段和按钮都不可点；不传 keys 时列出全部十项", () => {
    const { r } = list({ disabled: true, settings: {} });
    expect(rowsOf(r)).toHaveLength(10);
    const all = r.root.findAll(
      (n) => n.type === Tappable && n.props.accessibilityRole === "radio",
    );
    expect(all.every((x) => x.props.disabled === true)).toBe(true);
  });
});

describe("设置分类页", () => {
  const settingsHook = useDeviceSettings as unknown as jest.Mock;
  const flush = async () => {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
  };
  const mount = (el: React.ReactElement) =>
    render(
      <QueryClientProvider client={makeQueryClient()}>
        {el}
      </QueryClientProvider>,
    );

  it("DeviceContext：先显示设备号，拿到详情换成名字；离线时补一句", async () => {
    (devicesApi.detail as jest.Mock).mockImplementation(() =>
      Promise.resolve({ name: "通勤头盔" }),
    );
    (devicesApi.status as jest.Mock).mockImplementation(() =>
      Promise.resolve({ online: false }),
    );
    const r = mount(<DeviceContext deviceId="h1" />);
    expect(r.texts()).toEqual(["h1"]);
    await flush();
    expect(r.texts()).toEqual(["通勤头盔", tr("device.offlineNote")]);
    expect(r.icons()).toEqual(["cloud-offline-outline"]);
  });

  it("DeviceContext：在线不提示", async () => {
    (devicesApi.detail as jest.Mock).mockImplementation(() =>
      Promise.resolve({ name: null }),
    );
    (devicesApi.status as jest.Mock).mockImplementation(() =>
      Promise.resolve({ online: true }),
    );
    const r = mount(<DeviceContext deviceId="h9" />);
    await flush();
    expect(r.texts()).toEqual(["h9"]);
  });

  it("分组标题、说明；读设置失败且没有缓存值时如实报错", async () => {
    (devicesApi.detail as jest.Mock).mockImplementation(
      () => new Promise(() => undefined),
    );
    (devicesApi.status as jest.Mock).mockImplementation(
      () => new Promise(() => undefined),
    );
    const send = jest.fn();
    settingsHook.mockReturnValue({
      values: undefined,
      lastCommand: null,
      sending: false,
      send,
      isError: true,
      error: Object.assign(new Error("x"), { code: "NETWORK_ERROR" }),
    });
    const r = mount(
      <DeviceSettingsPage
        deviceId="h1"
        groups={[
          {
            title: "device.safety.rideGroup",
            keys: ["fallDetect"] as DeviceSettingKey[],
          },
          { keys: ["buzzer"] as DeviceSettingKey[] },
        ]}
        note="device.alerts.volumeNote"
      />,
    );
    const text = r.allText();
    expect(text).toContain(tr("device.safety.rideGroup"));
    expect(text).toContain(tr("device.alerts.volumeNote"));
    expect(text).toContain(tr("device.set.fallDetect"));
    expect(text).toContain(tr("device.set.buzzer"));
    // 报错那一行是危险色
    const danger = r.root
      .findAllByType(Text)
      .filter((t) => flat(t.props.style).color === dark.danger);
    expect(danger).toHaveLength(1);
    // 有缓存值时不报错
    settingsHook.mockReturnValue({
      values: { buzzer: true },
      lastCommand: null,
      sending: false,
      send,
      isError: true,
      error: new Error("x"),
    });
    const r2 = mount(
      <DeviceSettingsPage
        deviceId="h1"
        groups={[{ keys: ["buzzer"] as DeviceSettingKey[] }]}
      />,
    );
    expect(
      r2.root
        .findAllByType(Text)
        .filter((t) => flat(t.props.style).color === dark.danger),
    ).toHaveLength(0);
    const [on] = r2.root.findAll(
      (n) => n.type === Tappable && n.props.accessibilityRole === "radio",
    );
    expect(on.props.accessibilityState.checked).toBe(true);
    act(() => on.props.onPress());
    expect(send).toHaveBeenCalledWith("buzzer", true);
    expect(View).toBeTruthy();
  });
});
