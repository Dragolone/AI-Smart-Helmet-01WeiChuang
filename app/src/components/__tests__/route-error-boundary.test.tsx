// 页面级错误边界：显示「页面暂时无法显示 · 其他页面照常可用」，点重试调 expo-router 给的 retry；出错时记一条日志；
// 能退回上一页时多一个「返回」（全屏页没有标题栏，倒计时页还禁了手势返回）
import { describe, expect, it, jest } from "@jest/globals";
import { Text } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { translate } from "@/i18n";
import { devLog } from "@/services/dev-log";
import { RouteErrorBoundary } from "../route-error-boundary";

jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("@/global.css", () => ({}));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
const mockRouter = { canGoBack: jest.fn(() => false), back: jest.fn() };
jest.mock("expo-router", () => ({
  router: {
    canGoBack: () => mockRouter.canGoBack(),
    back: () => mockRouter.back(),
  },
}));
jest.mock("@/components/form", () => {
  const Button = ({
    title,
    onPress,
  }: {
    title: string;
    onPress: () => void;
  }) => {
    const { Text: T } =
      jest.requireActual<typeof import("react-native")>("react-native");
    return <T onPress={onPress}>{title}</T>;
  };
  return { PrimaryButton: Button, SecondaryButton: Button };
});

function renderBoundary(retry = jest.fn(() => Promise.resolve())) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <RouteErrorBoundary error={new Error("boom")} retry={retry} />,
    );
  });
  const texts = () =>
    tree.root.findAllByType(Text).map((n) => String(n.props.children));
  const press = (title: string) =>
    act(() => {
      tree.root
        .findAllByType(Text)
        .find((n) => n.props.children === title)!
        .props.onPress();
    });
  return { texts, press };
}

describe("RouteErrorBoundary", () => {
  it("写清只是这一页出错，重试交给 expo-router 重新渲染这一页", () => {
    const retry = jest.fn(() => Promise.resolve());
    const { texts, press } = renderBoundary(retry);
    expect(texts()).toEqual(
      expect.arrayContaining([
        translate("app.crashTitle"),
        translate("app.pageCrashBody"),
        translate("app.crashRetry"),
      ]),
    );
    expect(devLog).toHaveBeenCalledWith(
      "CRASH",
      expect.stringContaining("boom"),
    );
    press(translate("app.crashRetry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("能退回上一页时给「返回」，点了退回上一页（10-22：倒计时页崩了原来只剩重试，iOS 上只能杀 App）", () => {
    mockRouter.canGoBack.mockReturnValue(true);
    const { texts, press } = renderBoundary();
    expect(texts()).toContain(translate("nav.back"));
    press(translate("nav.back"));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it("退无可退（标签页）时不显示「返回」", () => {
    mockRouter.canGoBack.mockReturnValue(false);
    const { texts } = renderBoundary();
    expect(texts()).not.toContain(translate("nav.back"));
  });
});
