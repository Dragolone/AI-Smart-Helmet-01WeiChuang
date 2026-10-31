// Tappable：只有 scale 模式才建 Reanimated 的共享值和动画样式（全 App 100 来处调用里约 80 处不缩放，
// 每个实例都白建有跨线程成本）；渲染出来的宿主节点和样式不变——非 scale 不多包一层。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as Haptics from "expo-haptics";
import { View } from "react-native";
import { act } from "react-test-renderer";
import { flat, isHost, render } from "@/__tests__/helpers/render";
import { useThemeStore } from "@/stores/theme-store";
import { Colors } from "@/constants/theme";
import { Tappable, type TappableProps } from "../tappable";

/** 每次渲染调了几次 useSharedValue / useAnimatedStyle，以及拿到的共享值（替身里 withSpring 直接给终值） */
const mockCalls = {
  sharedValue: 0,
  animatedStyle: 0,
  shared: [] as { get: () => number }[],
};

jest.mock("@/global.css", () => ({}));
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
}));
jest.mock("react-native-worklets", () =>
  jest.requireActual("react-native-worklets/src/mock"),
);
jest.mock("react-native-reanimated", () => {
  const actual = jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock() as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  return {
    ...actual,
    useSharedValue: (init: unknown) => {
      mockCalls.sharedValue += 1;
      const v = actual.useSharedValue(init) as { get: () => number };
      mockCalls.shared.push(v);
      return v;
    },
    useAnimatedStyle: (fn: unknown) => {
      mockCalls.animatedStyle += 1;
      return actual.useAnimatedStyle(fn);
    },
  };
});

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  mockCalls.sharedValue = 0;
  mockCalls.animatedStyle = 0;
  mockCalls.shared = [];
  jest.clearAllMocks();
});

type Feedback = TappableProps["feedback"];
const kid = <View testID="kid" />;
const hosts = (r: ReturnType<typeof render>) =>
  r.root.findAll((n) => isHost(n, "View")).length;
/** Tappable 交给 RN Pressable 的那一层（style 是函数、带按下回调）；Pressable 外面还包着 memo，取最外层 */
const pressable = (r: ReturnType<typeof render>) =>
  r.root.findAll(
    (n) =>
      typeof n.type !== "string" &&
      typeof n.props.style === "function" &&
      typeof n.props.onPressIn === "function",
  )[0];
const styleOf = (r: ReturnType<typeof render>, pressed: boolean) =>
  flat(
    (pressable(r).props.style as (s: { pressed: boolean }) => unknown)({
      pressed,
    }),
  );

describe("Tappable 非 scale 模式：不建 Reanimated 对象", () => {
  it.each<[string, Feedback]>([
    ["默认（opacity）", undefined],
    ["opacity", "opacity"],
    ["fill", "fill"],
    ["空数组", []],
    ["opacity + fill", ["opacity", "fill"]],
  ])(
    "%s：不调 useSharedValue / useAnimatedStyle，宿主节点只有 Pressable 和孩子",
    (_n, feedback) => {
      const r = render(
        <Tappable feedback={feedback} style={{ padding: 3 }}>
          {kid}
        </Tappable>,
      );
      expect(mockCalls.sharedValue).toBe(0);
      expect(mockCalls.animatedStyle).toBe(0);
      // Pressable 的 View + 孩子：没有外层的弹簧包装
      expect(hosts(r)).toBe(2);
      const root = r.tree.toJSON() as unknown as { props: { style: unknown } };
      expect(flat(root.props.style).transform).toBeUndefined();
      expect(flat(root.props.style).padding).toBe(3);
    },
  );

  it("按下 / 松手：回调照常转给调用方，触觉照常；opacity / fill / 禁用的样式不变", () => {
    const onPressIn = jest.fn();
    const onPressOut = jest.fn();
    const r = render(
      <Tappable
        feedback={["opacity", "fill"]}
        haptic
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={{ padding: 3 }}
      >
        {kid}
      </Tappable>,
    );
    act(() => pressable(r).props.onPressIn({}));
    act(() => pressable(r).props.onPressOut({}));
    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(onPressOut).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith("light");
    expect(styleOf(r, false).opacity).toBeUndefined();
    expect(styleOf(r, true)).toMatchObject({
      padding: 3,
      opacity: 0.6,
      backgroundColor: Colors.dark.backgroundSelected,
    });
    r.rerender(
      <Tappable disabled style={{ padding: 3 }}>
        {kid}
      </Tappable>,
    );
    expect(styleOf(r, false).opacity).toBe(0.45);
    expect(mockCalls.sharedValue).toBe(0);
  });
});

describe("Tappable scale 模式：弹簧缩放照旧", () => {
  it.each<[string, Feedback]>([
    ["scale", "scale"],
    ["opacity + scale", ["opacity", "scale"]],
  ])(
    "%s：每个实例一个共享值 + 一个动画样式；外层 Animated.View 挂缩放变换，样式 / 热区仍归 Pressable",
    (_n, feedback) => {
      const r = render(
        <Tappable feedback={feedback} style={{ padding: 3 }}>
          {kid}
        </Tappable>,
      );
      expect(mockCalls.sharedValue).toBe(1);
      expect(mockCalls.animatedStyle).toBe(1);
      // 外层弹簧包装 + Pressable 的 View + 孩子
      expect(hosts(r)).toBe(3);
      const root = r.tree.toJSON() as unknown as { props: { style: unknown } };
      expect(flat(root.props.style).transform).toEqual([{ scale: 1 }]);
      expect(styleOf(r, false).padding).toBe(3);
    },
  );

  it("hitSlop 外层也带上（外层和 Pressable 一样大，原生命中测试点在外层外面就不往里找）；没写就都没有", () => {
    const hitSlop = { top: 7, bottom: 7 };
    const slops = (r: ReturnType<typeof render>) => {
      const root = r.tree.toJSON() as unknown as {
        props: { hitSlop?: unknown };
      };
      return [root.props.hitSlop, pressable(r).props.hitSlop];
    };
    expect(
      slops(
        render(
          <Tappable feedback="scale" hitSlop={hitSlop}>
            {kid}
          </Tappable>,
        ),
      ),
    ).toEqual([hitSlop, hitSlop]);
    expect(slops(render(<Tappable feedback="scale">{kid}</Tappable>))).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("按下缩到 0.965、松手回到 1；调用方的回调和触觉照常", () => {
    const onPressIn = jest.fn();
    const onPressOut = jest.fn();
    const r = render(
      <Tappable
        feedback="scale"
        haptic
        onPressIn={onPressIn}
        onPressOut={onPressOut}
      >
        {kid}
      </Tappable>,
    );
    const scale = mockCalls.shared.at(-1)!;
    expect(scale.get()).toBe(1);
    act(() => pressable(r).props.onPressIn({}));
    expect(scale.get()).toBe(0.965);
    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    act(() => pressable(r).props.onPressOut({}));
    expect(scale.get()).toBe(1);
    expect(onPressOut).toHaveBeenCalledTimes(1);
  });
});
