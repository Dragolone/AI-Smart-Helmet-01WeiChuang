// 安卓 8.x 的旧绘制管线画不对「单边上色 + 旋转」的圆环（10-22 模拟器：8.0 / 8.1 弧线斜穿过倒计时数字，9 正常；
// 9 上强制切回旧管线同样错）。那些机型改用 Skia 画倒计时环和电量环，iOS 和安卓 9 起照旧
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { View } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { isLegacyAndroidRenderer } from "../legacy-renderer";

jest.mock("react-native-reanimated", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .reanimatedMock(),
);
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
);
jest.mock("@shopify/react-native-skia", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .skiaMock(),
);

type Rings = {
  CountdownRing: typeof import("../countdown-ring").CountdownRing;
  BatteryArc: typeof import("../battery-arc").BatteryArc;
};

/** 按「是不是旧绘制管线」重新加载两个组件（开关在模块加载时定） */
function loadWith(legacy: boolean): Rings {
  // 隔离加载会另起一份 React，和渲染器用的不是同一份时 hooks 会报错：指回外面这份
  const react = jest.requireActual<typeof import("react")>("react");
  let rings!: Rings;
  jest.isolateModules(() => {
    jest.doMock("react", () => react);
    jest.doMock("@/components/legacy-renderer", () => ({
      LEGACY_ANDROID_RENDERER: legacy,
    }));
    rings = {
      CountdownRing:
        jest.requireActual<typeof import("../countdown-ring")>(
          "../countdown-ring",
        ).CountdownRing,
      BatteryArc:
        jest.requireActual<typeof import("../battery-arc")>("../battery-arc")
          .BatteryArc,
    };
  });
  return rings;
}

const shared = (v: number) => ({
  value: v,
  get: () => v,
  set: () => undefined,
});

function render(el: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(el);
  });
  return tree;
}
const skiaPaths = (t: ReactTestRenderer) =>
  t.root.findAll((n) => (n.type as unknown) === "SkiaPath");
/** 原来那套画法：带 borderTopColor 的圆形边框 View */
const borderArcs = (t: ReactTestRenderer) =>
  t.root.findAll(
    (n) =>
      n.type === View &&
      [n.props.style]
        .flat(Infinity)
        .some((s) => s && typeof s === "object" && "borderTopColor" in s),
  );

afterEach(() => {
  jest.restoreAllMocks();
});

describe("旧绘制管线的安卓（8.0 / 8.1）改用 Skia 画环", () => {
  it("倒计时环：Skia 从正上方顺时针画一整圈，进度弧按剩余比例截取，不再用旋转的边框", () => {
    const { CountdownRing } = loadWith(true);
    const progress = shared(0.4);
    const t = render(
      <CountdownRing
        size={252}
        progress={progress as never}
        color="#D92D25"
        track="#333333"
      />,
    );
    const paths = skiaPaths(t);
    expect(paths).toHaveLength(2);
    expect(paths[0].props.color).toBe("#333333");
    expect(paths[1].props.color).toBe("#D92D25");
    expect(paths[1].props.start).toBe(0);
    expect(paths[1].props.end).toBe(progress);
    const arc = (paths[1].props.path as { arcs: unknown[][] }).arcs[0];
    expect(arc.slice(1)).toEqual([-90, 359.9]);
    expect(borderArcs(t)).toHaveLength(0);
  });

  it("电量环：Skia 画缺口朝下的 270° 底环和进度弧（起点在左下 135°），刻度照旧", () => {
    const { BatteryArc } = loadWith(true);
    const t = render(
      <BatteryArc
        size={240}
        value={85}
        color="#4ADE80"
        track="#333333"
        tick="#555555"
      />,
    );
    const paths = skiaPaths(t);
    expect(paths).toHaveLength(2);
    const arc = (paths[0].props.path as { arcs: unknown[][] }).arcs[0];
    expect(arc.slice(1)).toEqual([135, 270]);
    expect(borderArcs(t)).toHaveLength(0);
  });
});

describe("哪些机型算旧管线", () => {
  it.each<[string, number | string, boolean]>([
    ["android", 26, true],
    ["android", 27, true],
    ["android", 28, false],
    ["android", 36, false],
    ["ios", "26.0", false],
  ])("%s %s → %s", (os, version, legacy) => {
    expect(isLegacyAndroidRenderer(os, version)).toBe(legacy);
  });
});

describe("iOS 和安卓 9 起照旧（单边上色的边框）", () => {
  it("两个环都不用 Skia", () => {
    const { CountdownRing, BatteryArc } = loadWith(false);
    const ring = render(
      <CountdownRing
        size={252}
        progress={shared(0.4) as never}
        color="#D92D25"
        track="#333333"
      />,
    );
    expect(skiaPaths(ring)).toHaveLength(0);
    expect(borderArcs(ring).length).toBeGreaterThan(0);
    const arc = render(
      <BatteryArc
        size={240}
        value={85}
        color="#4ADE80"
        track="#333333"
        tick="#555555"
      />,
    );
    expect(skiaPaths(arc)).toHaveLength(0);
  });
});
