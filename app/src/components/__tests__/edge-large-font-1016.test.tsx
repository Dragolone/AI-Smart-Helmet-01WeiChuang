// 设备详情页在系统字体放大时的排版（2026-10-16 模拟器系统字体 2.0 倍）：
// ① 状态行（「设备离线 · 上次上报 3 分钟前」「蓝牙未连接 · 搜索头盔中… · 重试连接」）右边的值按内容占宽，
//    左边的结论被挤成一字一行（「设 / 备 / 离 / 线」竖排），原因也挤成三行；
// ② 电量卡右上角「过去 24 小时」被切成「过去 2」。
import { readFileSync } from "fs";
import { join } from "path";

import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as RN from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { STACK_FONT_SCALE, StatusRow, statusRowStacked } from "../status-row";

// 仓库里有两份 React（app/node_modules 与根目录）；让组件和 react-test-renderer 用同一份
jest.mock("react", () => jest.requireActual("../../../../node_modules/react"));
jest.mock("@/global.css", () => ({}));
jest.mock("react-native-reanimated", () =>
  jest.requireActual("react-native-reanimated/mock"),
);
jest.mock("react-native-worklets", () =>
  jest.requireActual("react-native-worklets/src/mock"),
);
jest.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
}));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

const renderers: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => renderers.splice(0).forEach((r) => r.unmount()));
  jest.restoreAllMocks();
});

function renderAt(fontScale: number, props: Parameters<typeof StatusRow>[0]) {
  // react-native 的导出是 getter（按需 require），要换 getter 本身；jest 环境默认的 fontScale 是 2
  // `import * as RN` 拿到的是 babel 包过的一份拷贝，组件读的是原模块对象：在原模块上换
  const raw = require("react-native") as { useWindowDimensions: object };
  jest
    .spyOn(raw, "useWindowDimensions", "get")
    .mockReturnValue(() => ({ width: 393, height: 852, scale: 3, fontScale }));
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<StatusRow {...props} />);
  });
  renderers.push(r);
  return r;
}

/** 文字所在的 Text 节点往上数，是不是在左边那一栏（flex: 1 的 View）里 */
function insideTextColumn(r: ReactTestRenderer, text: string): boolean {
  const node = r.root.find(
    (n) => n.type === RN.Text && [n.props.children].flat().includes(text),
  );
  for (let p = node.parent; p; p = p.parent) {
    const style = RN.StyleSheet.flatten(p.props?.style);
    if (p.type === RN.View && style?.flex === 1) return true;
  }
  return false;
}

describe("statusRowStacked：多大字体改成上下两行排", () => {
  it("正常字号、略放大（1.0 / 1.15 / 1.23）仍并排；1.3 起（含 2.0）上下排", () => {
    expect(STACK_FONT_SCALE).toBe(1.3);
    for (const s of [0.85, 1, 1.15, 1.23])
      expect(statusRowStacked(s)).toBe(false);
    for (const s of [1.3, 1.35, 2, 3.1]) expect(statusRowStacked(s)).toBe(true);
  });
});

describe("StatusRow 在 2 倍字体下把右边的值挪到结论下面", () => {
  const offline = {
    icon: "cloud-offline-outline" as const,
    tone: "warn" as const,
    title: "设备离线",
    trailing: "上次上报 · 3 分钟前",
  };
  const ble = {
    icon: "bluetooth-outline" as const,
    tone: "warn" as const,
    title: "蓝牙未连接",
    detail: "搜索头盔中…",
    actionLabel: "重试连接",
    onAction: () => undefined,
  };

  it("2.0 倍：「上次上报」在左边那一栏里（结论下面），不再和结论抢一行", () => {
    const r = renderAt(2, offline);
    expect(insideTextColumn(r, "设备离线")).toBe(true);
    expect(insideTextColumn(r, "上次上报 · 3 分钟前")).toBe(true);
  });

  it("2.0 倍：「重试连接」入口也挪到原因下面", () => {
    const r = renderAt(2, ble);
    expect(insideTextColumn(r, "重试连接")).toBe(true);
    expect(insideTextColumn(r, "搜索头盔中…")).toBe(true);
  });

  it("1.0 倍：照旧并排，右边的值在左栏外面", () => {
    expect(insideTextColumn(renderAt(1, offline), "上次上报 · 3 分钟前")).toBe(
      false,
    );
    expect(insideTextColumn(renderAt(1, ble), "重试连接")).toBe(false);
  });

  it("并排时右边的时间 / 入口最多占一半宽，左边的结论放得下", () => {
    const r = renderAt(1, offline);
    const trailing = r.root.find(
      (n) =>
        n.type === RN.Text &&
        [n.props.children].flat().includes("上次上报 · 3 分钟前"),
    );
    expect(RN.StyleSheet.flatten(trailing.props.style)).toMatchObject({
      maxWidth: "50%",
      flexShrink: 1,
    });
  });
});

describe("设备详情页接线 + 电量卡标题行", () => {
  const read = (...p: string[]) =>
    readFileSync(join(__dirname, "..", "..", ...p), "utf8");

  it("设备详情页用的是公共的 StatusRow（不再有页面里那份并排写死的）", () => {
    const src = read("app", "device", "[deviceId].tsx");
    expect(src).toContain(
      'import { StatusRow } from "@/components/status-row"',
    );
    expect(src).not.toContain("function StatusRow(");
    expect(src).not.toContain("statusRowTrailing");
  });

  it("「过去 24 小时」放不下时换到下一行、靠右，不被切掉", () => {
    const src = read("components", "battery-chart.tsx");
    expect(src).toMatch(/header: \{[^}]*flexWrap: "wrap"/);
    expect(src).toMatch(/windowLabel: \{[^}]*marginLeft: "auto"/);
    expect(src).toMatch(/windowLabel: \{[^}]*flexShrink: 1/);
    expect(src).toContain("style={styles.windowLabel}");
    // 左边（圆环 + 标题）也能收，不把右边挤没
    expect(src).toMatch(/headLeft: \{[^}]*flexShrink: 1/);
  });

  it("圆环里的电量数字最多放大 1.3 倍（圆环定宽，2 倍字体下不撑出圆环）", () => {
    const src = read("components", "battery-chart.tsx");
    expect(src.match(/maxFontSizeMultiplier=\{1\.3\}/g)).toHaveLength(2);
  });
});
