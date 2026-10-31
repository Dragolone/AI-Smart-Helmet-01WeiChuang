// 表单控件：输入框（聚焦 / 错误 / 密码显隐）、主按钮（idle / loading / disabled / danger / compact /
// 成功态 + 减弱动态效果）、次按钮、页面级错误、错误码 → 字段映射。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { Text, TextInput } from "react-native";
import { act } from "react-test-renderer";
import { mockFlags } from "@/__tests__/helpers/native-mocks";
import { flat, render, type Rendered } from "@/__tests__/helpers/render";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore } from "@/i18n";
import { useThemeStore } from "@/stores/theme-store";
import * as Haptics from "expo-haptics";
import {
  FormError,
  FormInput,
  PrimaryButton,
  SecondaryButton,
  errorField,
} from "../form";

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

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  mockFlags.reducedMotion = false;
});
afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

/** 按钮最外层（带 accessibilityState 的宿主节点） */
const buttonOf = (r: Rendered) =>
  r.root.find(
    (n) =>
      typeof n.type === "string" && n.props.accessibilityState !== undefined,
  );
/** 最外层 Pressable（带 onPressIn 的复合组件） */
const pressableOf = (r: Rendered) =>
  r.root.find(
    (n) =>
      typeof n.type !== "string" && typeof n.props.onPressIn === "function",
  );

describe("FormInput", () => {
  it("标签平时灰色、聚焦变品牌色，失焦变回", () => {
    const r = render(<FormInput label="手机号" icon="call-outline" />);
    const labelColor = () =>
      flat(r.root.findAllByType(Text)[0].props.style).color;
    expect(labelColor()).toBe(dark.textSecondary);
    expect(r.icons()).toEqual(["call-outline"]);
    const input = r.root.findByType(TextInput);
    act(() => input.props.onFocus());
    expect(labelColor()).toBe(dark.brand);
    act(() => input.props.onBlur());
    expect(labelColor()).toBe(dark.textSecondary);
  });

  it("有错误：下方红字、边框红色；没错误不显示", () => {
    const r = render(<FormInput label="验证码" error="验证码错误" />);
    const texts = r.root.findAllByType(Text);
    expect(texts.map((t) => t.props.children)).toEqual([
      "验证码",
      "验证码错误",
    ]);
    expect(flat(texts[1].props.style).color).toBe(dark.danger);
    const wrap = r.root.find(
      (n) =>
        typeof n.type === "string" && flat(n.props.style).borderRadius === 14,
    );
    expect(flat(wrap.props.style).borderColor).toBe(dark.danger);
    expect(flat(wrap.props.style).shadowOpacity).toBe(0);
    r.rerender(<FormInput label="验证码" error={null} />);
    expect(r.root.findAllByType(Text)).toHaveLength(1);
  });

  it("密码框默认隐藏；点眼睛切换明文，可访问性文字跟着变", () => {
    const r = render(<FormInput label="密码" secureTextEntry />);
    const input = () => r.root.findByType(TextInput);
    expect(input().props.secureTextEntry).toBe(true);
    expect(r.icons()).toEqual(["eye-off-outline"]);
    const show = translate("common.showPassword", undefined, "zh-CN");
    const eye = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        n.props.accessibilityLabel === show &&
        typeof n.props.onPress === "function",
    );
    act(() => eye.props.onPress());
    expect(input().props.secureTextEntry).toBe(false);
    expect(r.icons()).toEqual(["eye-outline"]);
    expect(() =>
      r.byLabel(translate("common.hidePassword", undefined, "zh-CN")),
    ).not.toThrow();
  });

  it("密码框（含点眼睛切成明文后）不自动大写 / 纠错，调用方仍可覆盖", () => {
    const r = render(<FormInput label="密码" secureTextEntry />);
    const input = () => r.root.findByType(TextInput);
    const off = () => {
      expect(input().props.autoCapitalize).toBe("none");
      expect(input().props.autoCorrect).toBe(false);
      expect(input().props.spellCheck).toBe(false);
    };
    off();
    const eye = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        typeof n.props.onPress === "function" &&
        typeof n.props.accessibilityLabel === "string",
    );
    act(() => eye.props.onPress());
    expect(input().props.secureTextEntry).toBe(false);
    off();
    r.rerender(
      <FormInput label="密码" secureTextEntry autoCapitalize="words" />,
    );
    expect(input().props.autoCapitalize).toBe("words");
  });

  it("普通输入框不被强加大写 / 纠错设置", () => {
    const r = render(<FormInput label="昵称" />);
    const props = r.root.findByType(TextInput).props;
    expect(props.autoCapitalize).toBeUndefined();
    expect(props.autoCorrect).toBeUndefined();
    expect(props.spellCheck).toBeUndefined();
  });

  it("普通输入框不带眼睛，secureTextEntry 不下发", () => {
    const r = render(<FormInput label="昵称" placeholder="填昵称" />);
    expect(r.root.findByType(TextInput).props.secureTextEntry).toBeUndefined();
    expect(r.root.findByType(TextInput).props.placeholder).toBe("填昵称");
    expect(r.icons()).toEqual([]);
  });
});

describe("PrimaryButton", () => {
  it("idle：品牌底色上的深色字，可点，按下有轻触觉", () => {
    const onPress = jest.fn();
    const r = render(
      <PrimaryButton title="登录" icon="log-in" onPress={onPress} />,
    );
    const btn = buttonOf(r);
    expect(btn.props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
    expect(btn.props.accessibilityLabel).toBeUndefined();
    expect(flat(btn.props.style).opacity).toBe(1);
    expect(flat(btn.props.style).minHeight).toBe(52);
    const title = r.root
      .findAllByType(Text)
      .find((t) => t.props.children === "登录")!;
    expect(flat(title.props.style).color).toBe(dark.onBrand);
    expect(flat(title.props.style).fontSize).toBe(16);
    expect(r.icons()).toEqual(["log-in"]);
    const p = pressableOf(r);
    act(() => {
      p.props.onPressIn();
      p.props.onPressOut();
      p.props.onPress();
    });
    expect(Haptics.impactAsync).toHaveBeenCalledWith("light");
    expect(onPress).toHaveBeenCalled();
  });

  it("loading：不显示文字（换成三点），变淡、不可点、busy", () => {
    const r = render(
      <PrimaryButton title="登录" onPress={() => undefined} loading />,
    );
    const btn = buttonOf(r);
    expect(btn.props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
    expect(flat(btn.props.style).opacity).toBe(0.55);
    expect(r.texts()).not.toContain("登录");
  });

  it("disabled：变淡、不可点，但不是 busy", () => {
    const r = render(
      <PrimaryButton title="登录" onPress={() => undefined} disabled />,
    );
    expect(buttonOf(r).props.accessibilityState).toEqual({
      disabled: true,
      busy: false,
    });
    expect(flat(buttonOf(r).props.style).opacity).toBe(0.55);
  });

  it("danger：白字；compact：46 高、15 号字、图标 17", () => {
    const r = render(
      <PrimaryButton
        title="解绑"
        danger
        compact
        icon="trash"
        onPress={() => undefined}
      />,
    );
    const title = r.root
      .findAllByType(Text)
      .find((t) => t.props.children === "解绑")!;
    expect(flat(title.props.style).color).toBe("#FFFFFF");
    expect(flat(title.props.style).fontSize).toBe(15);
    expect(flat(buttonOf(r).props.style).minHeight).toBe(46);
    expect(r.root.findByType("Ionicons" as never).props.size).toBe(17);
  });

  it("renderIcon 优先于 icon，拿到按钮决定的尺寸和颜色", () => {
    const renderIcon = jest.fn(() => <Text>自绘</Text>);
    const r = render(
      <PrimaryButton
        title="导航"
        icon="map"
        renderIcon={renderIcon}
        onPress={() => undefined}
      />,
    );
    expect(renderIcon).toHaveBeenCalledWith({ size: 18, color: dark.onBrand });
    expect(r.icons()).toEqual([]);
    expect(r.texts()).toContain("自绘");
  });

  it("成功态：默认「已保存」作可访问性文字、不可点、成功触觉；画完调 onSuccessShown", () => {
    jest.useFakeTimers();
    const shown = jest.fn();
    const r = render(
      <PrimaryButton
        title="保存"
        onPress={() => undefined}
        onSuccessShown={shown}
      />,
    );
    // 量到整条和短药丸的宽度（收缩动画用）
    const p = pressableOf(r);
    act(() => p.props.onLayout({ nativeEvent: { layout: { width: 300 } } }));
    // 成功层里「✓ 已保存」那一行：量它的宽度定短药丸多宽
    const row = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.props.accessibilityState === undefined,
    );
    act(() => row.props.onLayout({ nativeEvent: { layout: { width: 80 } } }));
    r.rerender(
      <PrimaryButton
        title="保存"
        success
        onPress={() => undefined}
        onSuccessShown={shown}
      />,
    );
    const saved = translate("common.saved", undefined, "zh-CN");
    const btn = buttonOf(r);
    expect(btn.props.accessibilityLabel).toBe(saved);
    expect(btn.props.accessibilityState.disabled).toBe(true);
    // 成功态不变淡
    expect(flat(btn.props.style).opacity).toBe(1);
    expect(flat(btn.props.style).alignSelf).toBe("center");
    // 成功那一帧就按整条宽定住，再由动画收窄：不会先按内容宽缩一下再弹回来（10-17 评审）
    expect(flat(btn.props.style).width).toBeGreaterThan(0);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith("success");
    // 成功那一层对读屏可见
    const layer = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.importantForAccessibility !== undefined,
    );
    expect(layer.props.importantForAccessibility).toBe("auto");
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(shown).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(30);
    });
    expect(shown).toHaveBeenCalledTimes(1);
    // 收缩过程中的布局不覆盖整条宽度（不抛错即可：分支只记录宽度）
    act(() => p.props.onLayout({ nativeEvent: { layout: { width: 120 } } }));
  });

  it("成功态：量到过整条宽和「✓ 已保存」那一行的宽，整条收成刚好包住它的短药丸（两边各留 22）；减弱动态效果时直接收好", () => {
    const shrunk = (reduced: boolean) => {
      mockFlags.reducedMotion = reduced;
      const el = (success: boolean) => (
        <PrimaryButton
          title="保存"
          success={success}
          onPress={() => undefined}
        />
      );
      const r = render(el(false));
      act(() =>
        pressableOf(r).props.onLayout({
          nativeEvent: { layout: { width: 300 } },
        }),
      );
      const row = r.root.find(
        (n) =>
          typeof n.type === "string" &&
          typeof n.props.onLayout === "function" &&
          n.props.accessibilityState === undefined,
      );
      act(() => row.props.onLayout({ nativeEvent: { layout: { width: 80 } } }));
      r.rerender(el(true));
      // 收窄写在 effect 里：再渲染一次才看得到
      r.rerender(el(true));
      return flat(buttonOf(r).props.style).width;
    };
    expect(shrunk(false)).toBe(80 + 22 * 2);
    expect(shrunk(true)).toBe(80 + 22 * 2);
  });

  it("触觉反馈失败（有的机器不支持）：成功态照常显示、照常回调；按下照常", async () => {
    jest.useFakeTimers();
    (Haptics.notificationAsync as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("haptics unavailable")),
    );
    (Haptics.impactAsync as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("haptics unavailable")),
    );
    const shown = jest.fn();
    const onPress = jest.fn();
    const el = (success: boolean) => (
      <PrimaryButton
        title="保存"
        success={success}
        onPress={onPress}
        onSuccessShown={shown}
      />
    );
    const r = render(el(false));
    act(() => {
      pressableOf(r).props.onPressIn();
      pressableOf(r).props.onPress();
    });
    expect(onPress).toHaveBeenCalled();
    r.rerender(el(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(buttonOf(r).props.accessibilityLabel).toBe(
      translate("common.saved", undefined, "zh-CN"),
    );
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("成功态但还没量到整条宽：原样不收、不居中（不会缩成内容宽）", () => {
    const r = render(
      <PrimaryButton title="保存" success onPress={() => undefined} />,
    );
    const st = flat(buttonOf(r).props.style);
    expect(st.alignSelf).toBeUndefined();
    expect(st.width).toBeUndefined();
  });

  it("成功态 + 系统减弱动态效果：200 ms 就回调；自定义成功文字", () => {
    jest.useFakeTimers();
    mockFlags.reducedMotion = true;
    const shown = jest.fn();
    const r = render(
      <PrimaryButton
        title="保存"
        success
        successTitle="已更新"
        onPress={() => undefined}
        onSuccessShown={shown}
      />,
    );
    expect(buttonOf(r).props.accessibilityLabel).toBe("已更新");
    // 成功层在 effect 里直接置为不透明（减弱动态效果不播）：再渲染一次就看得见
    r.rerender(
      <PrimaryButton
        title="保存"
        success
        successTitle="已更新"
        onPress={() => undefined}
        onSuccessShown={shown}
      />,
    );
    expect(r.texts()).toContain("已更新");
    expect(r.texts()).not.toContain("保存");
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it("成功态退回 idle：重新可点、成功层对读屏隐藏；卸载前撤掉计时器", () => {
    jest.useFakeTimers();
    const shown = jest.fn();
    const r = render(
      <PrimaryButton
        title="保存"
        success
        onPress={() => undefined}
        onSuccessShown={shown}
      />,
    );
    r.rerender(
      <PrimaryButton
        title="保存"
        onPress={() => undefined}
        onSuccessShown={shown}
      />,
    );
    expect(buttonOf(r).props.accessibilityState.disabled).toBe(false);
    const layer = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.importantForAccessibility !== undefined,
    );
    expect(layer.props.importantForAccessibility).toBe("no-hide-descendants");
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    // 变回 idle 时清掉了计时器：不会在离开成功态之后才回调
    expect(shown).not.toHaveBeenCalled();
  });
});

describe("SecondaryButton", () => {
  const styleFnOf = (r: Rendered) => {
    const p = r.root.find(
      (n) => typeof n.type !== "string" && typeof n.props.style === "function",
    );
    return p.props.style as (s: { pressed: boolean }) => unknown;
  };

  it("描边药丸、白字；按下换底色并轻缩", () => {
    const onPress = jest.fn();
    const r = render(
      <SecondaryButton title="历史轨迹" icon="time" onPress={onPress} />,
    );
    const idle = flat(styleFnOf(r)({ pressed: false }));
    expect(idle.borderColor).toBe(dark.borderStrong);
    expect(idle.backgroundColor).toBe("transparent");
    expect(idle.opacity).toBe(1);
    const pressed = flat(styleFnOf(r)({ pressed: true }));
    expect(pressed.backgroundColor).toBe(dark.backgroundSelected);
    expect(pressed.transform).toEqual([{ scale: 0.97 }]);
    expect(r.icons()).toEqual(["time"]);
    r.press("历史轨迹");
    expect(onPress).toHaveBeenCalled();
  });

  it("loading：三点代替文字；disabled：变淡且按下不缩", () => {
    let r = render(
      <SecondaryButton title="加入" onPress={() => undefined} loading />,
    );
    expect(r.texts()).not.toContain("加入");
    r = render(
      <SecondaryButton
        title="加入"
        compact
        onPress={() => undefined}
        disabled
      />,
    );
    const pressed = flat(styleFnOf(r)({ pressed: true }));
    expect(pressed.opacity).toBe(0.55);
    expect(pressed.transform).toBeUndefined();
    expect(pressed.minHeight).toBe(46);
  });

  it("renderIcon 不紧凑时拿到 18、正文色", () => {
    const renderIcon = jest.fn(() => null);
    render(
      <SecondaryButton
        title="x"
        renderIcon={renderIcon}
        onPress={() => undefined}
      />,
    );
    expect(renderIcon).toHaveBeenCalledWith({ size: 18, color: dark.text });
  });

  it("renderIcon 拿到正文色和紧凑尺寸", () => {
    const renderIcon = jest.fn(() => null);
    render(
      <SecondaryButton
        title="x"
        compact
        renderIcon={renderIcon}
        onPress={() => undefined}
      />,
    );
    expect(renderIcon).toHaveBeenCalledWith({ size: 17, color: dark.text });
  });
});

describe("FormError", () => {
  it("没有消息不渲染；有消息红字", () => {
    expect(render(<FormError message={null} />).tree.toJSON()).toBeNull();
    const r = render(<FormError message="网络不可用" />);
    const t = r.root.findByType(Text);
    expect(t.props.children).toBe("网络不可用");
    expect(flat(t.props.style).color).toBe(dark.danger);
  });
});

describe("errorField", () => {
  it.each([
    [{ code: "SMS_CODE_INVALID" }, "code"],
    [{ code: "verify_code_expired" }, "code"],
    [{ code: "INVALID_PASSWORD" }, "password"],
    [{ code: "INVALID_CREDENTIALS" }, "password"],
    [{ code: "PHONE_TAKEN" }, "phone"],
    [{ code: "USER_NOT_FOUND" }, "phone"],
    [{ code: "USER_EXISTS" }, "phone"],
    [{ code: "NICKNAME_TOO_LONG" }, "nickname"],
    [{ code: "RATE_LIMITED" }, null],
    [{ code: "" }, null],
    [{}, null],
    [null, null],
    [new Error("x"), null],
  ])("%j → %s", (err, field) => {
    expect(errorField(err)).toBe(field);
  });
});
