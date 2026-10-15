// 几个小 hook 的边界（2026-10-16）：外观跟随系统时系统给 null、前后台切换、屏幕常亮开关失败被接住。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as RN from "react-native";

import { useThemeStore } from "@/stores/theme-store";
import { useAppActive } from "../use-app-active";
import { useColorScheme } from "../use-color-scheme";
import { useKeepAwakeSafe } from "../use-keep-awake-safe";

// 仓库里有两份 React：app/node_modules/react（App 源码解析到它）和根目录那份（react-test-renderer 用它）。
// 两份各有各的 dispatcher，直接渲染 App 源码里的 hook 会报 Invalid hook call——这里让 App 源码也用根目录那份
jest.mock("react", () => jest.requireActual("../../../../node_modules/react"));

const mockActivate = jest.fn(async (_tag: string) => undefined);
const mockDeactivate = jest.fn(async (_tag: string) => undefined);
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: (tag: string) => mockActivate(tag),
  deactivateKeepAwake: (tag: string) => mockDeactivate(tag),
}));
jest.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
}));

const renderers: ReactTestRenderer[] = [];
async function renderHook<T, P>(hook: (p: P) => T, initial: NoInfer<P>) {
  const box = {} as { current: T };
  let props = initial;
  function Probe({ p }: { p: P }) {
    box.current = hook(p);
    return null;
  }
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<Probe p={props} />);
  });
  renderers.push(r);
  return {
    box,
    rerender: async (next: P) => {
      props = next;
      await act(async () => {
        r.update(<Probe p={props} />);
      });
    },
    unmount: async () => {
      await act(async () => {
        r.unmount();
      });
      renderers.splice(renderers.indexOf(r), 1);
    },
  };
}

afterEach(async () => {
  await act(async () => {
    for (const r of renderers.splice(0)) r.unmount();
  });
  jest.restoreAllMocks();
});

describe("useColorScheme", () => {
  beforeEach(() => {
    useThemeStore.setState({ mode: "dark" });
  });

  it("选了深色 / 浅色：不看系统", async () => {
    jest.spyOn(RN, "useColorScheme").mockReturnValue("light");
    const a = await renderHook(() => useColorScheme(), null);
    expect(a.box.current).toBe("dark");
    await act(async () => {
      useThemeStore.setState({ mode: "light" });
    });
    expect(a.box.current).toBe("light");
  });

  it("跟随系统：系统浅色就浅色；系统深色、没给（null / undefined）、给了认不出的值都按深色（品牌默认）", async () => {
    useThemeStore.setState({ mode: "system" });
    const spy = jest.spyOn(RN, "useColorScheme");
    for (const [system, expected] of [
      ["light", "light"],
      ["dark", "dark"],
      [null, "dark"],
      [undefined, "dark"],
      ["unspecified", "dark"],
    ] as const) {
      spy.mockReturnValue(system as never);
      const h = await renderHook(() => useColorScheme(), null);
      expect({ system, got: h.box.current }).toEqual({ system, got: expected });
      await h.unmount();
    }
  });
});

describe("useAppActive", () => {
  it("初值跟当前状态；之后只有 active 算在前台（inactive / background 都不算）", async () => {
    const listeners: ((s: string) => void)[] = [];
    const original = RN.AppState.currentState;
    Object.defineProperty(RN.AppState, "currentState", {
      value: "background",
      configurable: true,
      writable: true,
    });
    jest.spyOn(RN.AppState, "addEventListener").mockImplementation(((
      _: string,
      cb: (s: string) => void,
    ) => {
      listeners.push(cb);
      return { remove: () => listeners.splice(listeners.indexOf(cb), 1) };
    }) as never);
    const h = await renderHook(() => useAppActive(), null);
    expect(h.box.current).toBe(false);
    for (const [state, expected] of [
      ["active", true],
      ["inactive", false],
      ["active", true],
      ["background", false],
      ["unknown", false],
    ] as const) {
      await act(async () => listeners.forEach((cb) => cb(state)));
      expect({ state, got: h.box.current }).toEqual({ state, got: expected });
    }
    await h.unmount();
    expect(listeners).toHaveLength(0);
    Object.defineProperty(RN.AppState, "currentState", {
      value: original,
      configurable: true,
      writable: true,
    });
  });
});

describe("useKeepAwakeSafe", () => {
  beforeEach(() => {
    mockActivate.mockReset();
    mockDeactivate.mockReset();
    mockActivate.mockResolvedValue(undefined);
    mockDeactivate.mockResolvedValue(undefined);
  });

  it("挂上时开、卸载时关，用的是同一个标签", async () => {
    const h = await renderHook((tag: string) => useKeepAwakeSafe(tag), "sos");
    expect(mockActivate).toHaveBeenCalledWith("sos");
    await h.unmount();
    expect(mockDeactivate).toHaveBeenCalledWith("sos");
  });

  it("开、关都失败（Activity 已经不在）：吞掉，不产生未处理的 Promise 拒绝", async () => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);
    try {
      mockActivate.mockRejectedValue(
        new Error("The current activity is no longer available"),
      );
      mockDeactivate.mockRejectedValue(
        new Error("The current activity is no longer available"),
      );
      const h = await renderHook((tag: string) => useKeepAwakeSafe(tag), "map");
      await h.unmount();
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("标签变了：先关旧的再开新的", async () => {
    const h = await renderHook((tag: string) => useKeepAwakeSafe(tag), "a");
    await h.rerender("b");
    expect(mockDeactivate).toHaveBeenCalledWith("a");
    expect(mockActivate.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });
});
