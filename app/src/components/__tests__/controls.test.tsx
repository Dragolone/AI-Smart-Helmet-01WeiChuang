// 控件类组件：环形仪表、呼吸波纹、求救倒计时圆环（只画，不改）、音量滑杆、分段控件、滑动取消（只测不改）、
// 设备设置项（开关 / 档位 / 步进三种控件、待确认描边、回执五种状态、回执与当前值对不上时不说已生效、
// iOS 读屏播报回执变化、设置还没拉到时不冒充「没上报过」、步进从在途目标值接着加减）与设置分类页。
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
import {
  AccessibilityInfo,
  Animated as RNAnimated,
  Platform,
  Text,
  View,
} from "react-native";
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
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { ApiRequestError, SessionEndedError } from "@/api/client";
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
/** sliding = true 时 withTiming 交回「还在路上」的标记而不是终值：看得出滑块是在滑还是被直接放到了位 */
const mockAnim = { sliding: false };
jest.mock("react-native-reanimated", () => {
  const base = jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock() as unknown as Record<string, unknown> & {
    withTiming: (...a: unknown[]) => unknown;
  };
  return {
    ...base,
    withTiming: (to: unknown, ...rest: unknown[]) =>
      mockAnim.sliding ? { slidingTo: to } : base.withTiming(to, ...rest),
  };
});
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

  it("普通音量：品牌色、显示头盔上的实际百分比（不按拖动档位取整），刻度写推荐上限", () => {
    const r = render(
      <VolumeSlider value={62} {...props()} icon="volume-high" />,
    );
    expect(r.texts()).toEqual([
      tr("device.volume"),
      "62%",
      "10%",
      tr("device.volumeRecommended", { n: VOLUME_RECOMMENDED }),
      "100%",
    ]);
    expect(r.icons()).toEqual(["volume-high"]);
    const fill = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).position === "absolute" &&
        flat(n.props.style).width === "62%",
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
    // 没开始过拖动：也不用收尾
    expect(p.onDraggingChange).not.toHaveBeenCalled();
  });

  it("拖到一半被打断（onFinalize 失败）：收回拖动状态、回到原值，不交出结果", () => {
    const p = props();
    const r = render(<VolumeSlider value={50} {...p} />);
    layout(r, 200);
    const g = pan(r);
    act(() => g.handlers.onBegin({ x: 100 }));
    act(() => g.handlers.onStart({ x: 100 }));
    act(() => g.handlers.onUpdate({ x: 180 }));
    expect(r.texts()[1]).toBe(`90% · ${tr("device.volumeLoud")}`);
    act(() => g.handlers.onFinalize({}, false));
    expect(p.onDraggingChange).toHaveBeenLastCalledWith(false);
    expect(p.onRelease).not.toHaveBeenCalled();
    expect(r.texts()[1]).toBe("50%");
    const fill = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).position === "absolute" &&
        typeof flat(n.props.style).width === "string",
    );
    expect(flat(fill.props.style).width).toBe("50%");
    // 下一次拖动照常：开始、松手都会通知
    act(() => g.handlers.onStart({ x: 40 }));
    act(() => g.handlers.onFinalize({}, true));
    expect(p.onRelease).toHaveBeenCalledWith(20);
  });

  it("头盔没确认过（unconfirmed）：数字和填充用次要色，照常可拖；拖动中按手指下的值上色", () => {
    const p = props();
    const r = render(<VolumeSlider value={80} unconfirmed {...p} />);
    expect(r.texts()[1]).toBe("80%");
    expect(flat(r.root.findAllByType(Text)[1].props.style).color).toBe(
      dark.textSecondary,
    );
    expect(pan(r).config.enabled).toEqual([true]);
    layout(r, 200);
    act(() => pan(r).handlers.onStart({ x: 100 }));
    expect(flat(r.root.findAllByType(Text)[1].props.style).color).toBe(
      dark.text,
    );
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
    // 只在整条上变淡一次：每一段不再交给 Tappable 的 disabled 各淡一次（叠起来只剩 0.2）
    expect(segs(r)[1].props.disabled).toBeFalsy();
    expect(segs(r)[1].props.onPress).toBeUndefined();
    expect(segs(r)[1].props.accessibilityState).toEqual({
      checked: false,
      disabled: true,
    });
  });

  it("10-17 评审：同一段的布局变了（字号、改名）滑块跟着挪；整条变宽右边距重算", () => {
    const el = (current: number) => (
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
    expect(thumb(r)).toMatchObject({ left: 100, right: 100, height: 40 });
    // 当前那一段变宽变高（大字号）
    act(() =>
      segs(r)[1].props.onLayout({
        nativeEvent: { layout: { x: 90, y: 0, width: 140, height: 56 } },
      }),
    );
    r.rerender(el(1));
    expect(thumb(r)).toMatchObject({ left: 90, right: 70, top: 0, height: 56 });
    // 整条变宽：右边距按新宽度算
    const root = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityRole === "radiogroup",
    );
    act(() => root.props.onLayout({ nativeEvent: { layout: { width: 400 } } }));
    r.rerender(el(1));
    expect(thumb(r)).toMatchObject({ left: 90, right: 170 });
  });

  it("10-17 评审：前面的选项没了（解绑一顶头盔），滑块按值找当前那段，不拿错下标的位置", () => {
    const three = [
      { value: "a", label: "甲" },
      { value: "b", label: "乙" },
      { value: "c", label: "丙" },
    ];
    const el = (opts: { value: string; label: string }[]) => (
      <FluidSegmented
        options={opts}
        current="c"
        equal={false}
        palette={palette}
        onSelect={() => undefined}
      />
    );
    const r = render(el(three));
    const lay = (widths: number[]) => {
      let x = 0;
      segs(r).forEach((s, i) => {
        act(() =>
          s.props.onLayout({
            nativeEvent: { layout: { x, y: 0, width: widths[i], height: 34 } },
          }),
        );
        x += widths[i] + 8;
      });
    };
    lay([60, 70, 80]);
    const root = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityRole === "radiogroup",
    );
    act(() => root.props.onLayout({ nativeEvent: { layout: { width: 300 } } }));
    r.rerender(el(three));
    expect(thumb(r)).toMatchObject({ left: 146, right: 74 });
    // 「甲」没了：「丙」挪到第二格
    r.rerender(el(three.slice(1)));
    lay([70, 80]);
    r.rerender(el(three.slice(1)));
    expect(thumb(r)).toMatchObject({ left: 78, right: 142 });
  });

  it("没有高亮（current 为 null）：量到布局、整条又报一次同样的宽度，都不放滑块", () => {
    const r = render(
      <FluidSegmented
        options={options}
        current={null}
        palette={palette}
        onSelect={() => undefined}
      />,
    );
    measure(r);
    const root = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityRole === "radiogroup",
    );
    act(() => root.props.onLayout({ nativeEvent: { layout: { width: 300 } } }));
    r.rerender(
      <FluidSegmented
        options={options}
        current={null}
        palette={palette}
        onSelect={() => undefined}
      />,
    );
    expect(thumb(r).opacity).toBe(0);
  });

  it("滑块正在滑：整条又报一次同样的宽度、当前那段又报一次同样的位置，都不打断它；那一段的 y / 宽 / 高真变了才直接对齐", () => {
    const el = (current: number) => (
      <FluidSegmented
        options={options}
        current={current}
        palette={palette}
        onSelect={() => undefined}
      />
    );
    const r = render(el(0));
    measure(r);
    r.rerender(el(0));
    expect(thumb(r)).toMatchObject({ left: 0, right: 200 });
    const root = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityRole === "radiogroup",
    );
    const layOut = (x: number, y: number, width: number, height: number) =>
      act(() =>
        segs(r)[2].props.onLayout({
          nativeEvent: { layout: { x, y, width, height } },
        }),
      );
    mockAnim.sliding = true;
    try {
      r.rerender(el(2));
      r.rerender(el(2));
      const sliding = { left: { slidingTo: 200 }, right: { slidingTo: 0 } };
      expect(thumb(r)).toMatchObject(sliding);
      act(() =>
        root.props.onLayout({ nativeEvent: { layout: { width: 300 } } }),
      );
      layOut(200, 2, 100, 40);
      r.rerender(el(2));
      expect(thumb(r)).toMatchObject(sliding);
      // 只有 y 变了
      layOut(200, 6, 100, 40);
      r.rerender(el(2));
      expect(thumb(r)).toMatchObject({ left: 200, right: 0, top: 6 });
      // 只有宽变了
      layOut(200, 6, 90, 40);
      r.rerender(el(2));
      expect(thumb(r)).toMatchObject({ left: 200, right: 10, height: 40 });
      // 只有高变了
      layOut(200, 6, 90, 50);
      r.rerender(el(2));
      expect(thumb(r)).toMatchObject({ top: 6, height: 50 });
    } finally {
      mockAnim.sliding = false;
    }
  });

  it("待确认那段带读屏说明（给了 tentativeHint 时）", () => {
    const r = render(
      <FluidSegmented
        options={options}
        current={0}
        tentative={2}
        tentativeHint="等待头盔确认"
        palette={palette}
        onSelect={() => undefined}
      />,
    );
    expect(segs(r).map((s) => s.props.accessibilityHint)).toEqual([
      undefined,
      undefined,
      "等待头盔确认",
    ]);
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

  // iOS 读屏的双击只派发 onAccessibilityTap（RCTViewComponentView accessibilityActivate），
  // 只测 onAccessibilityAction 测不到这条路
  it("iOS 读屏双击（onAccessibilityTap）= 取消；动作带本地化名字，不念英文 activate", () => {
    const { r, onCancel } = mount();
    const t = r.root.find(
      (n) =>
        typeof n.type === "string" && n.props.accessibilityRole === "button",
    );
    expect(t.props.accessibilityActions).toEqual([
      { name: "activate", label: "取消求救" },
    ]);
    act(() => t.props.onAccessibilityTap());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["取消已在路上", { busy: true }],
    ["别的操作在路上", { disabled: true }],
  ])("%s：iOS 读屏双击不再取消", (_name, over) => {
    const { r, onCancel } = mount(over);
    const t = r.root.find(
      (n) =>
        typeof n.type === "string" && n.props.accessibilityRole === "button",
    );
    act(() => t.props.onAccessibilityTap());
    expect(onCancel).not.toHaveBeenCalled();
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

  it("系统字体放大：两种文字都最多放大 2 倍（不封顶时 adjustsFontSizeToFit 会把字压到 4 pt）", () => {
    const multiplierOf = (r: Rendered) =>
      r.root.find((n) => isHost(n, "Text")).props.maxFontSizeMultiplier;
    expect(multiplierOf(mount().r)).toBe(2);
    expect(multiplierOf(mount({ busy: true }).r)).toBe(2);
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

  it("离线没送达的那条：头盔已经回来在线时不再说「头盔离线」，改说上次没送达、请重试（10-16 iPhone）", () => {
    const r = render(
      <CommandFeedback
        command={cmd({ status: "offline" })}
        settingKey="light"
        online
      />,
    );
    expect(r.texts()).toEqual([tr("device.cmd.expiredRetry")]);
    expect(r.icons()).toEqual(["cloud-offline-outline"]);
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
    // 旧格式的 false 按「关」显示，标题右边也写「关」
    ({ r } = list({ keys: ["light"], settings: { light: false } }));
    expect(radios(rowsOf(r)[0])[0].props.accessibilityState.checked).toBe(true);
    expect(r.texts()).toContain(tr("device.level.off"));
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

  it("待确认那一段带读屏说明：在途的念「等待头盔确认」，没上报过的念「显示的是默认值」", () => {
    const hints = (r: Rendered) =>
      r.root
        .findAll(
          (n) => n.type === Tappable && n.props.accessibilityRole === "radio",
        )
        .map((n) => n.props.accessibilityHint)
        .filter(Boolean);
    const inFlight = list({
      keys: ["light"],
      settings: { light: 1 },
      lastCommand: cmd({ status: "pending", params: { light: 2 } }),
    });
    expect(hints(inFlight.r)).toEqual([tr("device.a11y.awaitingHelmet")]);
    const unreported = list({ keys: ["light"], settings: {} });
    expect(hints(unreported.r)).toEqual([tr("device.unconfirmedDefault")]);
  });

  it("已生效那条写的值和头盔现在的值对不上了（头盔自己上报改过）：不再挂「已生效」", () => {
    const success = cmd({ status: "success", params: { light: 2 } });
    expect(
      render(
        <CommandFeedback command={success} settingKey="light" confirmed={0} />,
      ).tree.toJSON(),
    ).toBeNull();
    expect(
      render(
        <CommandFeedback command={success} settingKey="light" confirmed={2} />,
      ).texts(),
    ).toEqual([tr("device.cmd.success")]);
    // 列表里按当前值比对：大灯被头盔改回关之后，这一行下面什么都不写
    const { r } = list({
      keys: ["light"],
      settings: { light: 0 },
      lastCommand: success,
    });
    expect(r.allText()).not.toContain(tr("device.cmd.success"));
    // 比对前按列表同一套规则规整：数值项里写成 true 的命令值等于 1，不当成「对不上」
    expect(
      render(
        <CommandFeedback
          command={cmd({ status: "success", params: { vibration: true } })}
          settingKey="vibration"
          confirmed={1}
        />,
      ).texts(),
    ).toEqual([tr("device.cmd.success")]);
    // 失败 / 离线照常显示（那是「没生效」，和当前值无关）
    expect(
      render(
        <CommandFeedback
          command={cmd({ status: "failed", params: { light: 2 } })}
          settingKey="light"
          confirmed={0}
        />,
      ).texts(),
    ).toEqual([tr("device.cmd.failed")]);
  });

  describe("iOS 读屏播报回执变化", () => {
    let say: ReturnType<typeof jest.spyOn>;
    const os = Platform.OS;
    beforeEach(() => {
      Object.defineProperty(Platform, "OS", {
        value: "ios",
        configurable: true,
      });
      say = jest
        .spyOn(AccessibilityInfo, "announceForAccessibility")
        .mockImplementation(() => undefined);
    });
    afterEach(() => {
      say.mockRestore();
      Object.defineProperty(Platform, "OS", { value: os, configurable: true });
    });

    it("挂上时已有的不念；刚点的那条从下发中到已生效，每变一次念一次", () => {
      const r = render(
        <CommandFeedback
          command={cmd({ commandId: "old", status: "success" })}
          settingKey="light"
        />,
      );
      expect(say).not.toHaveBeenCalled();
      r.rerender(
        <CommandFeedback
          command={cmd({ commandId: "c2", status: "pending" })}
          settingKey="light"
        />,
      );
      expect(say).toHaveBeenLastCalledWith(tr("device.cmd.pending"));
      r.rerender(
        <CommandFeedback
          command={cmd({ commandId: "c2", status: "delivered" })}
          settingKey="light"
        />,
      );
      expect(say).toHaveBeenLastCalledWith(tr("device.cmd.delivered"));
      r.rerender(
        <CommandFeedback
          command={cmd({ commandId: "c2", status: "success" })}
          settingKey="light"
        />,
      );
      expect(say).toHaveBeenLastCalledWith(tr("device.cmd.success"));
      expect(say).toHaveBeenCalledTimes(3);
      // 同一状态再渲染一次不重复念
      r.rerender(
        <CommandFeedback
          command={cmd({ commandId: "c2", status: "success" })}
          settingKey="light"
          online
        />,
      );
      expect(say).toHaveBeenCalledTimes(3);
    });

    it("设置刚拉回来带出一条旧回执（没有命令 → 有）不念；改的是别的项也不念", () => {
      const r = render(<CommandFeedback command={null} settingKey="light" />);
      r.rerender(
        <CommandFeedback
          command={cmd({ status: "offline" })}
          settingKey="light"
        />,
      );
      expect(say).not.toHaveBeenCalled();
      r.rerender(
        <CommandFeedback
          command={cmd({
            commandId: "c3",
            status: "pending",
            params: { radar: true },
          })}
          settingKey="light"
        />,
      );
      expect(say).not.toHaveBeenCalled();
    });

    it("Android 不主动念（靠 accessibilityLiveRegion）", () => {
      Object.defineProperty(Platform, "OS", {
        value: "android",
        configurable: true,
      });
      const r = render(
        <CommandFeedback
          command={cmd({ commandId: "a" })}
          settingKey="light"
        />,
      );
      r.rerender(
        <CommandFeedback
          command={cmd({ commandId: "a", status: "success" })}
          settingKey="light"
        />,
      );
      expect(say).not.toHaveBeenCalled();
    });
  });

  it("设置还在拉（undefined）：不描出厂默认、不说「显示的是默认值」；步进显示一横、不能加减", () => {
    const { r } = list({ keys: ["radar", "light", "radarDistance"] });
    expect(r.allText()).not.toContain(tr("device.unconfirmedDefault"));
    const segmented = r.root.findAll((n) => n.type === FluidSegmented);
    expect(segmented.map((x) => [x.props.current, x.props.tentative])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(r.allText()).toContain("—");
    const steps = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        (n.props.accessibilityLabel === "+" ||
          n.props.accessibilityLabel === "−"),
    );
    expect(steps.map((x) => x.props.disabled)).toEqual([true, true]);
  });

  it("步进有命令在路上：显示目标值（次要色、读屏补「等待头盔确认」），再点 + 从目标值接着加", () => {
    const { r, onChange } = list({
      keys: ["radarDistance"],
      settings: { radarDistance: 15 },
      lastCommand: cmd({ params: { radarDistance: 20 }, status: "pending" }),
    });
    const num = r.root
      .findAllByType(Text)
      .find((t) => t.props.children === "20m")!;
    expect(num).toBeDefined();
    expect(flat(num.props.style).color).toBe(dark.textSecondary);
    expect(num.props.accessibilityHint).toBe(tr("device.a11y.awaitingHelmet"));
    const plus = r.root.find(
      (n) => n.type === Tappable && n.props.accessibilityLabel === "+",
    );
    act(() => plus.props.onPress());
    expect(onChange).toHaveBeenCalledWith("radarDistance", 25);
    // 回执失败后回到头盔确认过的值
    const after = list({
      keys: ["radarDistance"],
      settings: { radarDistance: 15 },
      lastCommand: cmd({ params: { radarDistance: 20 }, status: "failed" }),
    });
    const settled = after.r.root
      .findAllByType(Text)
      .find((t) => t.props.children === "15m")!;
    expect(flat(settled.props.style).color).not.toBe(dark.textSecondary);
    expect(settled.props.accessibilityHint).toBeUndefined();
  });

  it("整体禁用（有命令在发）：所有段和按钮都不可点；不传 keys 时列出全部十项", () => {
    const { r } = list({ disabled: true, settings: {} });
    expect(rowsOf(r)).toHaveLength(10);
    const all = r.root.findAll(
      (n) => n.type === Tappable && n.props.accessibilityRole === "radio",
    );
    // 不可点：没有 onPress、读屏念「不可用」（变淡由整条控件统一做，不在每一段上再淡一次）
    expect(
      all.every(
        (x) =>
          x.props.onPress === undefined &&
          x.props.accessibilityState.disabled === true,
      ),
    ).toBe(true);
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
    await waitFor(() =>
      expect(r.texts()).toEqual(["通勤头盔", tr("device.offlineNote")]),
    );
    expect(r.icons()).toEqual(["cloud-offline-outline"]);
  });

  it("DeviceContext：详情没回来前先用设备列表缓存里的名字（不闪设备号）；详情回来以详情为准", async () => {
    let resolve!: (v: unknown) => void;
    (devicesApi.detail as jest.Mock).mockImplementation(
      () => new Promise((res) => (resolve = res)),
    );
    (devicesApi.status as jest.Mock).mockImplementation(
      () => new Promise(() => undefined),
    );
    const qc = makeQueryClient();
    qc.setQueryData(["devices"], [{ deviceId: "h1", name: "通勤头盔" }]);
    const r = render(
      <QueryClientProvider client={qc}>
        <DeviceContext deviceId="h1" />
      </QueryClientProvider>,
    );
    expect(r.texts()).toEqual(["通勤头盔"]);
    await act(async () => {
      resolve({ name: "骑行头盔" });
      await Promise.resolve();
    });
    await waitFor(() => expect(r.texts()).toEqual(["骑行头盔"]));
  });

  it("DeviceContext：在线不提示", async () => {
    (devicesApi.detail as jest.Mock).mockImplementation(() =>
      Promise.resolve({ name: null }),
    );
    (devicesApi.status as jest.Mock).mockImplementation(() =>
      Promise.resolve({ online: true }),
    );
    const r = mount(<DeviceContext deviceId="h9" />);
    // 两个查询都落地之后（status 回来了）仍然只有设备号
    await waitFor(() =>
      expect(devicesApi.status as jest.Mock).toHaveBeenCalled(),
    );
    await flush();
    await flush();
    expect(r.texts()).toEqual(["h9"]);
  });

  it("头盔已不在本账号下（乱链接 / 别的手机解绑了，设置或状态 404）：不画开关，同详情首页给空态（优化清单 10）", async () => {
    (devicesApi.detail as jest.Mock).mockImplementation(
      () => new Promise(() => undefined),
    );
    (devicesApi.status as jest.Mock).mockImplementation(
      () => new Promise(() => undefined),
    );
    settingsHook.mockReturnValue({
      values: undefined,
      lastCommand: null,
      sending: false,
      send: jest.fn(),
      isError: true,
      error: new ApiRequestError(404, { code: "DEVICE_NOT_FOUND" }),
    });
    const r = mount(
      <DeviceSettingsPage
        deviceId="h_missing"
        groups={[{ keys: ["fallDetect"] as DeviceSettingKey[] }]}
      />,
    );
    expect(r.allText()).toContain(tr("device.goneTitle"));
    expect(r.allText()).toContain(tr("device.goneBody", { id: "h_missing" }));
    expect(r.allText()).not.toContain(tr("device.set.fallDetect"));
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

  it("设置没拿到是因为会话已失效（正被送回登录页）：不写「登录已失效」，登录页自有说明", () => {
    (devicesApi.detail as jest.Mock).mockImplementation(
      () => new Promise(() => undefined),
    );
    (devicesApi.status as jest.Mock).mockImplementation(
      () => new Promise(() => undefined),
    );
    settingsHook.mockReturnValue({
      values: undefined,
      lastCommand: null,
      sending: false,
      send: jest.fn(),
      isError: true,
      error: new SessionEndedError(),
    });
    const r = mount(
      <DeviceSettingsPage
        deviceId="h1"
        groups={[{ keys: ["buzzer"] as DeviceSettingKey[] }]}
      />,
    );
    expect(r.allText()).not.toContain(
      translate("error.sessionEnded", undefined, "zh-CN"),
    );
  });
});
