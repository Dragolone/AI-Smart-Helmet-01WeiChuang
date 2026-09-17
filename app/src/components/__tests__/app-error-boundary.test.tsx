// 根级错误边界：子树渲染抛错 → 兜底屏（非 __DEV__）；重试后重新渲染子树
import { describe, expect, it, jest } from "@jest/globals";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { AppErrorBoundary } from "../app-error-boundary";

jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
// theme.ts 顶部 import 了 global.css（web 用），jest 不转 css
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
    const { Text } =
      jest.requireActual<typeof import("react-native")>("react-native");
    return <Text onPress={onPress}>{title}</Text>;
  },
}));
jest.mock("@/components/themed-text", () => ({
  ThemedText: ({ children }: { children: React.ReactNode }) => {
    const { Text } =
      jest.requireActual<typeof import("react-native")>("react-native");
    return <Text>{children}</Text>;
  },
}));

let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error("boom");
  const { Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return <Text>recovered</Text>;
}

describe("AppErrorBoundary", () => {
  it("renders the fallback on a render error and recovers on retry", () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <AppErrorBoundary scheme="dark">
          <Bomb />
        </AppErrorBoundary>,
      );
    });
    const texts = () =>
      tree.root
        .findAllByType(
          jest.requireActual<typeof import("react-native")>("react-native")
            .Text,
        )
        .map((n) => String(n.props.children));
    expect(texts()).toContain("Something went wrong");
    shouldThrow = false;
    act(() => {
      tree.root
        .findAll(
          (n) => n.props.children === "Try again" && !!n.props.onPress,
        )[0]
        .props.onPress();
    });
    expect(texts()).toContain("recovered");
    spy.mockRestore();
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  });
});
