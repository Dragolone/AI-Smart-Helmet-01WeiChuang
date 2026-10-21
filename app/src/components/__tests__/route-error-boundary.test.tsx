// 页面级错误边界：显示「页面暂时无法显示 · 其他页面照常可用」，点重试调 expo-router 给的 retry；出错时记一条日志
import { describe, expect, it, jest } from "@jest/globals";
import { Text } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { translate } from "@/i18n";
import { devLog } from "@/services/dev-log";
import { RouteErrorBoundary } from "../route-error-boundary";

jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("@/global.css", () => ({}));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@/components/form", () => ({
  PrimaryButton: ({
    title,
    onPress,
  }: {
    title: string;
    onPress: () => void;
  }) => {
    const { Text: T } =
      jest.requireActual<typeof import("react-native")>("react-native");
    return <T onPress={onPress}>{title}</T>;
  },
}));

describe("RouteErrorBoundary", () => {
  it("写清只是这一页出错，重试交给 expo-router 重新渲染这一页", () => {
    const retry = jest.fn(() => Promise.resolve());
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <RouteErrorBoundary error={new Error("boom")} retry={retry} />,
      );
    });
    const texts = tree.root
      .findAllByType(Text)
      .map((n) => String(n.props.children));
    expect(texts).toEqual(
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
    act(() => {
      tree.root
        .findAllByType(Text)
        .find((n) => n.props.children === translate("app.crashRetry"))!
        .props.onPress();
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
