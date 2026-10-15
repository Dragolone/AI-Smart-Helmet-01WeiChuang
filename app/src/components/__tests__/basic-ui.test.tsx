// 展示类基础组件：ThemedText / ThemedView / Badge / StatusChip / EmptyState / 列表原语 /
// Tappable / Skeleton / KeyboardAvoid。断言不同 props 走到的分支（文字、颜色、可访问性、按压回调）。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Animated as RNAnimated, Platform, Text, View } from "react-native";
import { act } from "react-test-renderer";
import { flat, render, rootJson } from "@/__tests__/helpers/render";
import { Colors } from "@/constants/theme";
import { useThemeStore } from "@/stores/theme-store";
import * as Haptics from "expo-haptics";
import { Badge, type BadgeVariant } from "../badge";
import { EmptyState } from "../empty-state";
import { KeyboardAvoid } from "../keyboard-avoid";
import { Card, GroupTitle, IconCircle, ListRow, SectionLabel } from "../list";
import { Skeleton } from "../skeleton";
import { StatusChip, type ChipLevel } from "../status-chip";
import { Tappable } from "../tappable";
import { ThemedText, type ThemedTextProps } from "../themed-text";
import { ThemedView } from "../themed-view";

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
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));

const dark = Colors.dark;
const light = Colors.light;

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
});

describe("ThemedText", () => {
  const styleOf = (el: React.ReactElement) =>
    flat(render(el).root.findByType(Text).props.style);

  it("默认正文 16 号、深色主题白字", () => {
    const s = styleOf(<ThemedText>正文</ThemedText>);
    expect(s.fontSize).toBe(16);
    expect(s.color).toBe(dark.text);
  });

  it.each<[ThemedTextProps["type"], number]>([
    ["title", 48],
    ["subtitle", 32],
    ["small", 14],
    ["smallBold", 14],
    ["link", 14],
    ["code", 12],
    ["label", 11],
    ["display", 34],
  ])("type=%s 字号 %i", (type, size) => {
    expect(styleOf(<ThemedText type={type}>x</ThemedText>).fontSize).toBe(size);
  });

  it("linkPrimary 自带蓝色、盖过主题色；label 转大写", () => {
    expect(styleOf(<ThemedText type="linkPrimary">x</ThemedText>).color).toBe(
      "#3c87f7",
    );
    expect(styleOf(<ThemedText type="label">x</ThemedText>).textTransform).toBe(
      "uppercase",
    );
  });

  it("themeColor 取主题里的那一档；浅色主题换浅色值；外部 style 最后生效", () => {
    expect(
      styleOf(<ThemedText themeColor="textSecondary">x</ThemedText>).color,
    ).toBe(dark.textSecondary);
    act(() => useThemeStore.setState({ mode: "light" }));
    expect(styleOf(<ThemedText>x</ThemedText>).color).toBe(light.text);
    expect(
      styleOf(<ThemedText style={{ color: "red" }}>x</ThemedText>).color,
    ).toBe("red");
  });
});

describe("ThemedView", () => {
  it("默认底色 background，type 指定别的档", () => {
    const bg = (el: React.ReactElement) =>
      flat(render(el).root.findByType(View).props.style).backgroundColor;
    expect(bg(<ThemedView />)).toBe(dark.background);
    expect(bg(<ThemedView type="backgroundElement" />)).toBe(
      dark.backgroundElement,
    );
  });
});

describe("Badge", () => {
  it.each<[BadgeVariant, string, string]>([
    ["success", dark.success, dark.successBg],
    ["warning", dark.warning, dark.warningBg],
    ["danger", dark.danger, dark.dangerBg],
    ["neutral", dark.textSecondary, dark.backgroundSelected],
  ])("%s：圆点和文字同色、底色是对应的半透明档", (variant, fg, bg) => {
    const r = render(<Badge variant={variant} label="在线" />);
    const views = r.root.findAllByType(View);
    expect(flat(views[0].props.style).backgroundColor).toBe(bg);
    expect(flat(views[1].props.style).backgroundColor).toBe(fg);
    expect(flat(r.root.findByType(Text).props.style).color).toBe(fg);
    expect(r.allText()).toBe("在线");
  });
});

describe("StatusChip", () => {
  it.each<[ChipLevel, string, string]>([
    ["ok", "checkmark-circle-outline", dark.success],
    ["warn", "alert-circle-outline", dark.warning],
    ["unknown", "help-circle-outline", dark.warning],
    ["bad", "close-circle-outline", dark.danger],
  ])("%s 四档图标各不相同，颜色按语义", (level, icon, color) => {
    const r = render(<StatusChip level={level} label="蓝牙" />);
    const ic = r.root.findByType("Ionicons" as never);
    expect(ic.props.name).toBe(icon);
    expect(ic.props.color).toBe(color);
    // 文字用正文色，不靠颜色区分
    expect(flat(r.root.findByType(Text).props.style).color).toBe(dark.text);
  });

  it("换档时图标换掉（key 跟着名字和颜色变）", () => {
    const r = render(<StatusChip level="ok" label="蓝牙" />);
    r.rerender(<StatusChip level="bad" label="蓝牙" />);
    expect(r.icons()).toEqual(["close-circle-outline"]);
  });
});

describe("EmptyState", () => {
  it("只有标题时不渲染说明和按钮", () => {
    const r = render(<EmptyState icon="cube-outline" title="还没有头盔" />);
    expect(r.texts()).toEqual(["还没有头盔"]);
    expect(r.icons()).toEqual(["cube-outline"]);
  });

  it("有说明、有按钮文字但没给回调：按钮不出现", () => {
    const r = render(
      <EmptyState
        icon="cube-outline"
        title="T"
        body="说明"
        actionLabel="去绑定"
      />,
    );
    expect(r.texts()).toEqual(["T", "说明"]);
  });

  it("按钮文字 + 回调都给了：出现紧凑主按钮，按下调回调", () => {
    const onAction = jest.fn();
    const r = render(
      <EmptyState
        icon="cube-outline"
        title="T"
        actionLabel="去绑定"
        actionIcon="add"
        onAction={onAction}
      />,
    );
    expect(r.allText()).toContain("去绑定");
    expect(r.icons()).toContain("add");
    r.press("去绑定");
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe("列表原语", () => {
  it("Card 描边卡片带主题底色，外部 style 叠加", () => {
    const r = render(
      <Card style={{ marginTop: 3 }}>
        <Text>内容</Text>
      </Card>,
    );
    const s = flat(r.root.findAllByType(View)[0].props.style);
    expect(s.backgroundColor).toBe(dark.backgroundElement);
    expect(s.borderColor).toBe(dark.border);
    expect(s.marginTop).toBe(3);
  });

  it("IconCircle 默认 32 圆、图标 18；自定义尺寸 / 颜色 / 底色", () => {
    let r = render(<IconCircle icon="person" />);
    let ic = r.root.findByType("Ionicons" as never);
    expect(ic.props.size).toBe(Math.round(32 * 0.56));
    expect(ic.props.color).toBe(dark.text);
    expect(flat(r.root.findByType(View).props.style).borderRadius).toBe(16);
    r = render(
      <IconCircle
        icon="person"
        size={40}
        iconSize={12}
        color="#123"
        bg="#456"
      />,
    );
    ic = r.root.findByType("Ionicons" as never);
    expect(ic.props.size).toBe(12);
    expect(ic.props.color).toBe("#123");
    expect(flat(r.root.findByType(View).props.style).backgroundColor).toBe(
      "#456",
    );
  });

  it("SectionLabel：没回调不显示动作；有 caption 显示；动作可点", () => {
    expect(render(<SectionLabel title="设备" action="全部" />).texts()).toEqual(
      ["设备"],
    );
    const onAction = jest.fn();
    const r = render(
      <SectionLabel
        title="设备"
        caption="2 台"
        action="全部"
        onAction={onAction}
      />,
    );
    expect(r.texts()).toEqual(["设备", "2 台", "全部"]);
    r.press("全部");
    expect(onAction).toHaveBeenCalled();
  });

  it("GroupTitle 灰色小标题", () => {
    const r = render(<GroupTitle title="通用" />);
    expect(flat(r.root.findByType(Text).props.style).color).toBe(
      dark.textSecondary,
    );
  });

  it("ListRow 默认档：圆底图标 + 副标题 + 右侧值 + 可点时有箭头", () => {
    const onPress = jest.fn();
    const r = render(
      <ListRow
        icon="call-outline"
        title="手机号"
        subtitle="用于登录"
        value="139****0042"
        onPress={onPress}
      />,
    );
    expect(r.texts()).toEqual(["手机号", "用于登录", "139****0042"]);
    expect(r.icons()).toEqual(["call-outline", "chevron-forward"]);
    r.press("手机号");
    expect(onPress).toHaveBeenCalled();
  });

  it("ListRow 不可点：没有箭头；last=false 有分隔线、last=true 没有", () => {
    const sepOf = (last: boolean) => {
      const r = render(<ListRow icon={"a" as never} title="x" last={last} />);
      return flat(r.root.findAllByType(View)[0].props.style).borderBottomWidth;
    };
    const r = render(<ListRow icon={"a" as never} title="x" />);
    expect(r.icons()).toEqual(["a"]);
    expect(sepOf(false)).toBeGreaterThan(0);
    expect(sepOf(true)).toBeUndefined();
  });

  it("ListRow 紧凑档 + 危险：图标和标题变红，值显示在右边", () => {
    const r = render(
      <ListRow
        compact
        destructive
        icon="trash-outline"
        title="注销账号"
        value="不可恢复"
        right={<Text>右侧</Text>}
        onPress={() => undefined}
      />,
    );
    const ic = r.root.findAllByType("Ionicons" as never);
    expect(ic[0].props.color).toBe(dark.danger);
    expect(ic[0].props.size).toBe(20);
    expect(ic[1].props.name).toBe("chevron-forward");
    const title = r.root.findAllByType(Text)[0];
    expect(flat(title.props.style).color).toBe(dark.danger);
    expect(r.texts()).toEqual(["注销账号", "不可恢复", "右侧"]);
  });

  it("ListRow 紧凑档不可点、非危险：图标灰色、没有箭头", () => {
    const r = render(<ListRow compact icon={"moon" as never} title="外观" />);
    const ic = r.root.findAllByType("Ionicons" as never);
    expect(ic).toHaveLength(1);
    expect(ic[0].props.color).toBe(dark.textSecondary);
  });
});

describe("Tappable", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });
  const pressableOf = (r: ReturnType<typeof render>) =>
    r.root.find(
      (n) => typeof n.props.onPressIn === "function" && n.type !== Tappable,
    );

  it("按下 / 松开转给外部回调；haptic 时按下有触觉", () => {
    const onPressIn = jest.fn();
    const onPressOut = jest.fn();
    const r = render(
      <Tappable haptic onPressIn={onPressIn} onPressOut={onPressOut}>
        <Text>点我</Text>
      </Tappable>,
    );
    const p = pressableOf(r);
    p.props.onPressIn({});
    p.props.onPressOut({});
    expect(onPressIn).toHaveBeenCalled();
    expect(onPressOut).toHaveBeenCalled();
    expect(Haptics.impactAsync).toHaveBeenCalledWith("light");
  });

  it("默认不震动；opacity 模式按下变淡；disabled 变灰", () => {
    const r = render(
      <Tappable disabled style={{ margin: 1 }}>
        <Text>点我</Text>
      </Tappable>,
    );
    const p = pressableOf(r);
    p.props.onPressIn({});
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    const styleFn = p.props.style as (s: { pressed: boolean }) => unknown;
    expect(flat(styleFn({ pressed: false }))).toEqual({
      margin: 1,
      opacity: 0.45,
    });
    expect(flat(styleFn({ pressed: true })).opacity).toBe(0.6);
  });

  it("fill 模式按下换选中底色；scale 模式外面包一层动画容器", () => {
    const r = render(
      <Tappable feedback={["fill", "scale"]}>
        <Text>行</Text>
      </Tappable>,
    );
    const p = pressableOf(r);
    const styleFn = p.props.style as (s: { pressed: boolean }) => unknown;
    expect(flat(styleFn({ pressed: true })).backgroundColor).toBe(
      dark.backgroundSelected,
    );
    expect(flat(styleFn({ pressed: true })).opacity).toBeUndefined();
    // 外层是挂弹簧变换的 View
    const outer = rootJson(r);
    expect(outer.type).toBe("View");
    expect(flat(outer.props.style).transform).toEqual([{ scale: 1 }]);
    // 按下 / 松开不抛错（弹簧在替身里直接给终值）
    p.props.onPressIn({});
    p.props.onPressOut({});
  });
});

describe("Skeleton", () => {
  // 真的 Animated.loop 在 jest 里每段动画瞬间结束、循环同步重启，会卡死：换成假的，只看起停
  const stop = jest.fn();
  const start = jest.fn();
  let spy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    spy = jest
      .spyOn(RNAnimated, "loop")
      .mockReturnValue({ start, stop, reset: jest.fn() } as never);
  });
  afterEach(() => spy.mockRestore());

  it("默认撑满宽、16 高、8 圆角，底色是选中档；卸载时停掉循环", () => {
    const r = render(<Skeleton />);
    const s = flat(r.root.findByType(RNAnimated.View).props.style);
    expect(s.width).toBe("100%");
    expect(s.height).toBe(16);
    expect(s.borderRadius).toBe(8);
    expect(s.backgroundColor).toBe(dark.backgroundSelected);
    expect(start).toHaveBeenCalled();
    r.unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("自定义宽高圆角", () => {
    const r = render(<Skeleton width={120} height={40} radius={20} />);
    const s = flat(r.root.findByType(RNAnimated.View).props.style);
    expect([s.width, s.height, s.borderRadius]).toEqual([120, 40, 20]);
  });
});

describe("KeyboardAvoid", () => {
  const original = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, "OS", {
      value: original,
      configurable: true,
    });
  });

  it("iOS 用 padding 顶起；Android 交给系统（不设 behavior）", () => {
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    const kav = (r: ReturnType<typeof render>) =>
      r.root.find(
        (n) => n.props.behavior !== undefined || n.props.style?.flex === 1,
      );
    let r = render(
      <KeyboardAvoid>
        <Text>表单</Text>
      </KeyboardAvoid>,
    );
    expect(kav(r).props.behavior).toBe("padding");
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    r = render(
      <KeyboardAvoid>
        <Text>表单</Text>
      </KeyboardAvoid>,
    );
    expect(kav(r).props.behavior).toBeUndefined();
    expect(r.allText()).toBe("表单");
  });
});
