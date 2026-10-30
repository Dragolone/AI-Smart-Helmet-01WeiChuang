// 电量环（null / 0 / 中间值 / 100 / 超界 / 变淡）、画出来的勾、动效原语（motion.tsx）。
// 替身里的 withTiming 直接给终值、共享值跨渲染保留：effect 跑完后再渲染一次，看到的就是动画走完的样子。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { PixelRatio, Text, View } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { mockFlags } from "@/__tests__/helpers/native-mocks";
import {
  flat,
  render,
  rootJson,
  type Rendered,
} from "@/__tests__/helpers/render";
import { useThemeStore } from "@/stores/theme-store";
import Animated from "react-native-reanimated";
import { BatteryArc } from "../battery-arc";
import { CHECK_DRAW_MS, CheckDraw } from "../check-draw";
import {
  AnimatedChip,
  CrossfadeIcon,
  DotsLoader,
  MotionText,
  PulseDot,
  TINT_MS,
  ValueTransition,
  listEntering,
  useJello,
  useTintStyle,
} from "../motion";
import { ThemedText } from "../themed-text";

jest.mock("@/global.css", () => ({}));
jest.mock("@expo/vector-icons", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .iconsMock(),
);
jest.mock("react-native-worklets", () =>
  jest.requireActual("react-native-worklets/src/mock"),
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

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  mockFlags.reducedMotion = false;
  mockFlags.skiaPathNull = false;
});
afterEach(() => {
  mockFlags.reducedMotion = false;
  mockFlags.skiaPathNull = false;
});

describe("BatteryArc", () => {
  const arc = (
    value: number | null,
    extra: Partial<Parameters<typeof BatteryArc>[0]> = {},
  ) => {
    const props = {
      size: 240,
      value,
      color: "#0F0",
      track: "#333",
      tick: "#555",
      ...extra,
    };
    const r = render(<BatteryArc {...props} />);
    // 第一次渲染时 effect 才把目标值写进共享值：再渲染一次看动画走完的样子
    r.rerender(<BatteryArc {...props} />);
    return r;
  };
  /** 样式里 rotate 的度数 */
  const deg = (style: Record<string, unknown>) =>
    parseFloat((style.transform as { rotate: string }[])[0].rotate);
  /** 节点往下走到第一个宿主元素（View 在 jest 里是包了一层的复合组件） */
  const hostOf = (n: ReactTestInstance): ReactTestInstance =>
    typeof n.type === "string" ? n : hostOf(n.children[0] as ReactTestInstance);
  /** 进度那一组（整组一起淡化的容器）和它下面的几层 */
  const layers = (r: Rendered) => {
    const frame = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.needsOffscreenAlphaCompositing !== undefined,
    );
    const [full, clip, rest, startCap, endWrap] = (
      frame.children as ReactTestInstance[]
    ).map(hostOf);
    const first = hostOf(clip.children[0] as ReactTestInstance);
    return {
      frame: flat(frame.props.style),
      dimmedComposite: frame.props.needsOffscreenAlphaCompositing as boolean,
      full: flat(full.props.style),
      clip: flat(clip.props.style),
      first: flat(first.props.style),
      rest: flat(rest.props.style),
      startCap: flat(startCap.props.style),
      end: flat(endWrap.props.style),
    };
  };

  it("刻度每 10° 一根共 28 根；底环缺口朝下（下边透明），两头圆点用底环色", () => {
    const r = arc(null);
    const ticks = r.root.findAll(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).backgroundColor === "#555",
    );
    expect(ticks).toHaveLength(28);
    const base = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).borderTopColor === "#333",
    );
    const bs = flat(base.props.style);
    expect([bs.borderLeftColor, bs.borderRightColor]).toEqual(["#333", "#333"]);
    expect(bs.borderColor).toBe("transparent");
    const caps = r.root.findAll(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).backgroundColor === "#333" &&
        flat(n.props.style).borderRadius ===
          Number(flat(n.props.style).width) / 2,
    );
    expect(caps).toHaveLength(2);
  });

  it("没有电量数据：进度那组整个不显示", () => {
    expect(layers(arc(null)).frame.opacity).toBe(0);
  });

  it("0 和负数都按 0：不显示进度", () => {
    expect(layers(arc(0)).frame.opacity).toBe(0);
    expect(layers(arc(-20)).frame.opacity).toBe(0);
  });

  it("10%：只走第一段，用转进来的那段弧画，后半截不显示", () => {
    const l = layers(arc(10));
    expect(l.frame.opacity).toBe(1);
    expect(l.clip.overflow).toBe("hidden");
    expect(l.full.borderTopColor).toBe("transparent");
    expect(l.first.opacity).toBe(1);
    // a = 0.1 × 3 = 0.3 → 起点退 0.5° 再转 90.5° × 0.3
    expect(deg(l.first)).toBeCloseTo(-45.5 + 90.5 * 0.3, 6);
    expect(l.rest.opacity).toBe(0);
    expect(deg(l.end)).toBeCloseTo(27, 6);
  });

  it("42%：第一段走满、第二段由前沿那段弧画", () => {
    const l = layers(arc(42));
    expect(l.full.borderTopColor).toBe("#0F0");
    expect(l.full.borderRightColor).toBe("transparent");
    expect(l.full.borderBottomColor).toBe("transparent");
    expect(l.first.opacity).toBe(0);
    expect(l.rest.opacity).toBe(1);
    expect(deg(l.rest)).toBeCloseTo(0.42 * 270 - 45, 6);
    expect(l.startCap.backgroundColor).toBe("#0F0");
  });

  it("100% 和超过 100 都画满三段，终点转到 270°", () => {
    for (const v of [100, 180]) {
      const l = layers(arc(v));
      expect([
        l.full.borderTopColor,
        l.full.borderRightColor,
        l.full.borderBottomColor,
      ]).toEqual(["#0F0", "#0F0", "#0F0"]);
      expect(deg(l.end)).toBe(270);
    }
  });

  it("变淡：整组一起合成后降到 0.45，不是每层各自半透明", () => {
    const l = layers(arc(60, { dimmed: true }));
    expect(l.dimmedComposite).toBe(true);
    expect(l.frame.opacity).toBe(0.45);
    expect(layers(arc(60)).dimmedComposite).toBe(false);
  });

  it("尺寸落在整像素上；children 叠在环里", () => {
    const r = render(
      <BatteryArc size={201} value={50} color="#0F0" track="#333" tick="#555">
        <Text>头盔图</Text>
      </BatteryArc>,
    );
    const box = flat(r.root.findAllByType(View)[0].props.style);
    expect(box.width).toBe(box.height);
    expect(box.width).toBe(PixelRatio.roundToNearestPixel(201 / 2) * 2);
    expect(r.allText()).toBe("头盔图");
  });
});

describe("CheckDraw", () => {
  const paths = (r: Rendered) =>
    r.root.findAll((n) => n.type === ("SkiaPath" as never)).map((n) => n.props);

  it("play=false：圈和勾都没画（end = 0）", () => {
    const r = render(<CheckDraw color="#fff" play={false} />);
    r.rerender(<CheckDraw color="#fff" play={false} />);
    expect(paths(r).map((p) => (p.end as { value: number }).value)).toEqual([
      0, 0,
    ]);
    expect(paths(r)[0].opacity).toBe(0.5);
  });

  it("play=true：时钟走到 CHECK_DRAW_MS，圈和勾都画满、弹完回到 1", () => {
    const r = render(<CheckDraw color="#fff" />);
    r.rerender(<CheckDraw color="#fff" />);
    expect(paths(r).map((p) => (p.end as { value: number }).value)).toEqual([
      1, 1,
    ]);
    const box = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).transform !== undefined &&
        flat(n.props.style).width === 24,
    );
    expect(flat(box.props.style).transform).toEqual([{ scale: 1 }]);
    expect(CHECK_DRAW_MS).toBe(860);
  });

  it("减弱动态效果：直接是画好的样子", () => {
    mockFlags.reducedMotion = true;
    const r = render(
      <CheckDraw color="#fff" size={48} strokeWidth={3} ringOpacity={0.2} />,
    );
    r.rerender(
      <CheckDraw color="#fff" size={48} strokeWidth={3} ringOpacity={0.2} />,
    );
    expect(paths(r).map((p) => (p.end as { value: number }).value)).toEqual([
      1, 1,
    ]);
    expect(paths(r)[0].strokeWidth).toBe(3);
    expect(paths(r)[0].opacity).toBe(0.2);
    // 以 24 为画布，按 size 等比放大
    const g = r.root.find((n) => n.type === ("SkiaGroup" as never));
    expect(g.props.transform).toEqual([{ scale: 2 }]);
  });

  it("Skia 解析不出路径时退回系统勾图标", () => {
    mockFlags.skiaPathNull = true;
    const r = render(<CheckDraw color="#abc" size={30} />);
    expect(r.icons()).toEqual(["checkmark"]);
    const ic = r.root.findByType("Ionicons" as never);
    expect([ic.props.size, ic.props.color]).toEqual([30, "#abc"]);
  });
});

describe("motion 原语", () => {
  /** 两层常驻：读屏可见（importantForAccessibility="auto"）的那层里的图标就是当前图标，另一层是正在淡出的旧图标 */
  const activeIcon = (r: Rendered) =>
    r.root
      .find(
        (n) =>
          (n.type as unknown) === "View" &&
          n.props.importantForAccessibility === "auto",
      )
      .findAll((n) => (n.type as unknown) === "Ionicons")
      .map((n) => String(n.props.name));

  it("CrossfadeIcon：首次挂上不弹；换图标时旧的留在另一层淡出、新的进当前层，pop 弹一下（替身里弹簧直接回到 1）", () => {
    const r = render(
      <CrossfadeIcon name="checkmark" size={16} color="#0f0" pop />,
    );
    expect(r.icons()).toEqual(["checkmark"]);
    r.rerender(<CrossfadeIcon name="close" size={16} color="#f00" pop />);
    r.rerender(<CrossfadeIcon name="close" size={16} color="#f00" pop />);
    expect(activeIcon(r)).toEqual(["close"]);
    expect(r.icons().sort()).toEqual(["checkmark", "close"]); // 旧图标在淡出层上，读屏忽略
    const box = flat(rootJson(r).props.style);
    expect(box.width).toBe(16);
    expect(box.transform).toEqual([{ scale: 1 }]);
  });

  it("CrossfadeIcon：减弱动态效果 / 不要 pop 时换图标不弹", () => {
    mockFlags.reducedMotion = true;
    const r = render(
      <CrossfadeIcon name={"a" as never} size={10} color="#000" pop />,
    );
    r.rerender(
      <CrossfadeIcon name={"b" as never} size={10} color="#000" pop />,
    );
    expect(r.icons()).toEqual(["b"]); // 减弱动态效果：直接换，不留旧图标
    mockFlags.reducedMotion = false;
    r.rerender(<CrossfadeIcon name={"c" as never} size={10} color="#000" />);
    expect(activeIcon(r)).toEqual(["c"]);
  });

  it("AnimatedChip：显示文字、点了回调；disabled 时不响应", () => {
    const onPress = jest.fn();
    const common = {
      label: "全部",
      activeBg: "#1",
      inactiveBg: "#2",
      activeFg: "#3",
      inactiveFg: "#4",
      onPress,
    };
    const r = render(
      <AnimatedChip {...common} active borderActive="#5" borderInactive="#6" />,
    );
    expect(r.texts()).toEqual(["全部"]);
    r.press("全部");
    expect(onPress).toHaveBeenCalledTimes(1);
    r.rerender(<AnimatedChip {...common} active={false} disabled />);
    const p = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        n.props.disabled === true &&
        typeof n.props.onPress === "function",
    );
    expect(p).toBeTruthy();
  });

  it("ValueTransition：两层轮流当前层，换值时新值进藏着的那层、旧值留在另一层退场；同值重渲染不动；减弱动态效果时不留旧值", () => {
    const r = render(
      <ValueTransition value={3}>
        <Text>3 km</Text>
      </ValueTransition>,
    );
    // 替身里 withTiming 直接给终值、反应只在挂上时跑一次：看结构不看透明度，所以不用 r.texts()（它滤掉不透明度 0 的）
    const all = () =>
      r.root
        .findAll((n) => (n.type as unknown) === "Text")
        .map((n) => n.children.filter((c) => typeof c === "string").join(""));
    const layers = () =>
      r.root.findAll(
        (n) =>
          (n.type as unknown) === "View" &&
          typeof n.props.importantForAccessibility === "string",
      );
    expect(all()).toEqual(["3 km"]);
    expect(layers()).toHaveLength(2);
    r.rerender(
      <ValueTransition value="4.5">
        <Text>4.5 km</Text>
      </ValueTransition>,
    );
    // 第 0 层留着旧值退场（absolute、读屏忽略），第 1 层是新值（在流里、可读）
    expect(all()).toEqual(["3 km", "4.5 km"]);
    const [l0, l1] = layers();
    expect(flat(l0.props.style).position).toBe("absolute");
    expect(l0.props.importantForAccessibility).toBe("no-hide-descendants");
    expect(flat(l1.props.style).position).toBeUndefined();
    expect(l1.props.importantForAccessibility).toBe("auto");
    // 同一个值只是重渲染：当前层内容跟着变，不换层
    r.rerender(
      <ValueTransition value="4.5">
        <Text>4.5 km!</Text>
      </ValueTransition>,
    );
    expect(all()).toEqual(["3 km", "4.5 km!"]);
    // 再换值：轮回第 0 层，第 1 层留上次换值时的内容退场
    r.rerender(
      <ValueTransition value={6}>
        <Text>6 km</Text>
      </ValueTransition>,
    );
    expect(all()).toEqual(["6 km", "4.5 km"]);
    expect(layers()[0].props.importantForAccessibility).toBe("auto");
    // 系统开了「减弱动态效果」：直接换，不留旧值
    mockFlags.reducedMotion = true;
    try {
      r.rerender(
        <ValueTransition value={7}>
          <Text>7 km</Text>
        </ValueTransition>,
      );
      expect(all()).toEqual(["7 km"]);
    } finally {
      mockFlags.reducedMotion = false;
    }
  });

  it("PulseDot：尺寸 / 颜色 / 圆；静态时不透明", () => {
    const r = render(<PulseDot color="#0f0" active={false} size={10} />);
    r.rerender(<PulseDot color="#0f0" active={false} size={10} />);
    const s = flat(rootJson(r).props.style);
    expect([
      s.width,
      s.height,
      s.borderRadius,
      s.backgroundColor,
      s.opacity,
    ]).toEqual([10, 10, 5, "#0f0", 1]);
    // 进行中：循环动画（替身里 withRepeat 原样返回内层），不抛错
    r.rerender(<PulseDot color="#0f0" active />);
  });

  it("DotsLoader：三个点，默认 6 大", () => {
    const r = render(<DotsLoader color="#fff" />);
    const dots = r.root.findAll(
      (n) =>
        typeof n.type === "string" &&
        flat(n.props.style).backgroundColor === "#fff",
    );
    expect(dots).toHaveLength(3);
    expect(flat(dots[0].props.style).width).toBe(6);
  });

  it("useJello：触发后 scaleX / scaleY 回到 1（替身里序列给 0 以外的终值时也只走一遍）", () => {
    let api!: ReturnType<typeof useJello>;
    function Probe() {
      api = useJello();
      return <Animated.View style={api.style} />;
    }
    const r = render(<Probe />);
    expect(flat(api.style).transform).toEqual([{ scaleX: 1 }, { scaleY: 1 }]);
    act(() => api.trigger());
    r.rerender(<Probe />);
    expect(Array.isArray(flat(api.style).transform)).toBe(true);
  });

  it("useTintStyle：只输出给了的颜色项，过渡到目标色", () => {
    let style!: Record<string, unknown>;
    function Probe(props: Parameters<typeof useTintStyle>[0]) {
      style = useTintStyle(props) as unknown as Record<string, unknown>;
      return null;
    }
    render(<Probe backgroundColor="#111" />);
    expect(style).toEqual({ backgroundColor: "#111" });
    render(<Probe borderColor="#222" color="#333" />);
    expect(style).toEqual({ borderColor: "#222", color: "#333" });
    render(<Probe />);
    expect(style).toEqual({});
    expect(TINT_MS).toBe(240);
  });

  it("listEntering 按序号错峰（构造器可链式调用）；MotionText 就是 ThemedText", () => {
    expect(listEntering(0)).toBeTruthy();
    expect(listEntering(100)).toBeTruthy();
    expect(MotionText).toBe(ThemedText);
  });
});
