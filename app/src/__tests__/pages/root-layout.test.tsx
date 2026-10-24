// 根布局（app/_layout）：模块一加载就做的几件事（开发期异常旁路、留住原生启动图、回到前台重拉过期数据、
// 换账号 / 登出清缓存、会话被否定时提醒），以及布局本身：三份设置恢复完才挂路由和实时通道、登录门控、
// 各页标题、求救页按 sosId 各占一页、状态栏深浅跟外观走。
// 实时通道（保命链路）这里只看「什么时候起」，换成记录调用的替身；开屏 / 衔接 / 连接横幅 / 隐私弹窗换成占位。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { focusManager, type QueryClient } from "@tanstack/react-query";
import * as SplashScreen from "expo-splash-screen";
import { Stack } from "expo-router";
import { AppState } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { isHost, render, type Rendered } from "@/__tests__/helpers/render";
import { useRealtimeUpdates } from "@/hooks/use-realtime";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { installDevErrorTap } from "@/services/dev-log";
import { hideIconsFromScreenReader } from "@/services/icon-a11y";
import {
  clearSessionExpiredNotice,
  notifySessionExpired,
} from "@/services/session-notice";
import { useAuthStore } from "@/stores/auth-store";
import { useConsentStore } from "@/stores/consent-store";
import { useThemeStore } from "@/stores/theme-store";
import RootLayout from "@/app/_layout";

jest.mock("@/global.css", () => ({}));
/** 记下根布局交给 focusManager 的那个「前台 / 后台」监听装配函数（模块加载时就调，挂在单例上取） */
type FocusSetup = (
  setFocused: (focused?: boolean) => void,
) => (() => void) | undefined;
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  const fm = actual.focusManager;
  const original = fm.setEventListener.bind(fm);
  fm.setEventListener = (setup) => {
    Object.assign(fm, { recordedSetup: setup });
    original(setup);
  };
  return actual;
});
jest.mock("@expo/vector-icons", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .iconsMock(),
);
jest.mock("react-native-worklets", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .workletsMock(),
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
jest.mock("react-native-safe-area-context", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .safeAreaMock(),
);
jest.mock("react-native-gesture-handler", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .gestureMock(),
);
jest.mock("expo-router", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return {
    ...jest
      .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
        "@/__tests__/helpers/native-mocks",
      )
      .expoRouterMock(),
    DarkTheme: { dark: true },
    DefaultTheme: { dark: false },
    ThemeProvider: ({
      value,
      children,
    }: {
      value: unknown;
      children?: React.ReactNode;
    }) => h("ThemeProvider", { value }, children),
  };
});
jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-status-bar", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return {
    StatusBar: (props: Record<string, unknown>) => h("StatusBar", props),
  };
});
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
  AFTER_FIRST_UNLOCK: 0,
}));
const placeholder = (name: string) => () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return (props: Record<string, unknown>) => h(name, props);
};
jest.mock("@/components/splash/splash-overlay", () => ({
  SplashOverlay: placeholder("SplashOverlay")(),
}));
jest.mock("@/components/splash/guide-handover", () => ({
  GuideHandover: placeholder("GuideHandover")(),
}));
jest.mock("@/components/connection-banner", () => ({
  ConnectionBanner: placeholder("ConnectionBanner")(),
}));
jest.mock("@/components/privacy-consent-modal", () => ({
  PrivacyConsentModal: placeholder("PrivacyConsentModal")(),
}));
jest.mock("@/components/theme-fade", () => ({
  ThemeFade: placeholder("ThemeFade")(),
}));
/** 轻提示宿主换成探针：顺手拿到根布局给的 QueryClient */
let mockQc: QueryClient | null = null;
jest.mock("@/components/toast", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  const { useQueryClient } = jest.requireActual<
    typeof import("@tanstack/react-query")
  >("@tanstack/react-query");
  return {
    showToast: jest.fn(),
    ToastHost: () => {
      mockQc = useQueryClient();
      return h("ToastHost");
    },
  };
});
jest.mock("@/hooks/use-realtime", () => ({ useRealtimeUpdates: jest.fn() }));
jest.mock("@/services/dev-log", () => ({
  installDevErrorTap: jest.fn(),
  devLog: jest.fn(),
}));
jest.mock("@/services/icon-a11y", () => ({
  hideIconsFromScreenReader: jest.fn(),
}));
jest.mock("@/services/session-notice", () => ({
  notifySessionExpired: jest.fn(),
  clearSessionExpiredNotice: jest.fn(),
}));
/** 重装检查（iOS 重装后清钥匙串）：由用例决定什么时候清完 */
let mockFreshInstallDone: () => void = () => undefined;
jest.mock("@/services/fresh-install", () => ({
  clearIfFreshInstall: () =>
    new Promise<void>((resolve) => {
      mockFreshInstallDone = resolve;
    }),
}));

// 模块加载时的调用：在任何用例清掉替身记录之前先记下来
const atImport = {
  devTap: (installDevErrorTap as jest.Mock).mock.calls.length,
  iconsHidden: (hideIconsFromScreenReader as jest.Mock).mock.calls.length,
  splashHold: (SplashScreen.preventAutoHideAsync as jest.Mock).mock.calls
    .length,
};

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const hydrators = {
  auth: jest.fn(() => Promise.resolve()),
  locale: jest.fn(() => Promise.resolve()),
  theme: jest.fn(() => Promise.resolve()),
  consent: jest.fn(() => Promise.resolve()),
};
const screens = (r: Rendered) =>
  r.root.findAll((n) => isHost(n, "StackScreen"));
const screen = (r: Rendered, name: string) =>
  screens(r).find((n) => n.props.name === name)!;
const guards = (r: Rendered) =>
  r.root
    .findAll((n: ReactTestInstance) => n.type === Stack.Protected)
    .map((n) => n.props.guard as boolean);
const hostNames = (r: Rendered) =>
  r.root
    .findAll((n) => typeof n.type === "string")
    .map((n) => n.type as string);
const hydrateAll = () =>
  act(() => {
    useAuthStore.setState({ hydrated: true });
    useLocaleStore.setState({ hydrated: true });
    useThemeStore.setState({ hydrated: true });
  });

beforeEach(() => {
  useLocaleStore.setState({
    locale: "zh-CN",
    hydrated: false,
    hydrate: hydrators.locale,
  });
  useThemeStore.setState({
    mode: "dark",
    hydrated: false,
    hydrate: hydrators.theme,
  });
  useAuthStore.setState({
    tokens: null,
    user: null,
    hydrated: false,
    sessionExpired: false,
    hydrate: hydrators.auth,
  } as never);
  useConsentStore.setState({ hydrate: hydrators.consent } as never);
});
afterEach(() => {
  jest.clearAllMocks();
});

describe("模块加载时", () => {
  it("装上开发期异常旁路、图标不进读屏名字、留住原生启动图（由开屏动画自己收）", () => {
    expect(atImport.devTap).toBe(1);
    expect(atImport.iconsHidden).toBe(1);
    expect(atImport.splashHold).toBe(1);
  });

  it("App 回到前台 = 查询的「窗口获得焦点」：active 才算在前台，卸下时取消监听", () => {
    const setup = (focusManager as unknown as { recordedSetup?: FocusSetup })
      .recordedSetup;
    expect(setup).toBeDefined();
    const remove = jest.fn();
    let onChange: ((s: string) => void) | null = null;
    // 只接管这一次调用：RN 的替身本身就是 jest.fn，restore 会把它原来的实现一起抹掉
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementationOnce((type, cb) => {
        expect(type).toBe("change");
        onChange = cb as (s: string) => void;
        return { remove } as never;
      });
    const setFocused = jest.fn();
    const cleanup = setup!(setFocused);
    onChange!("background");
    onChange!("active");
    onChange!("inactive");
    expect(setFocused.mock.calls).toEqual([[false], [true], [false]]);
    cleanup!();
    expect(remove).toHaveBeenCalled();
    // 根布局装的就是它：现在的焦点状态由它管
    expect(typeof focusManager.isFocused()).toBe("boolean");
  });
});

describe("登录态变化", () => {
  it("换了账号清空查询缓存；同一账号改档案不清；冷启动先有 token 后有档案不算换人", () => {
    render(<RootLayout />);
    const qc = mockQc!;
    const fill = () => qc.setQueryData(["devices"], [{ deviceId: "h1" }]);
    const kept = () => qc.getQueryData(["devices"]) !== undefined;

    useAuthStore.setState({
      tokens: { accessToken: "a", refreshToken: "r" },
    } as never);
    fill();
    // 冷启动：钥匙串里只有 token，/users/me 回来才有档案
    act(() => useAuthStore.setState({ user: { id: "u1" } } as never));
    expect(kept()).toBe(true);
    act(() =>
      useAuthStore.setState({ user: { id: "u1", nickname: "阿麦" } } as never),
    );
    expect(kept()).toBe(true);
    act(() => useAuthStore.setState({ user: { id: "u2" } } as never));
    expect(kept()).toBe(false);
  });

  it("登出清空查询缓存；会话被服务端否定时提醒一次，重新登录后收起提醒", () => {
    render(<RootLayout />);
    const qc = mockQc!;
    act(() =>
      useAuthStore.setState({
        tokens: { accessToken: "a", refreshToken: "r" },
      } as never),
    );
    expect(clearSessionExpiredNotice).toHaveBeenCalledTimes(1);
    qc.setQueryData(["contacts"], []);

    act(() => useAuthStore.setState({ sessionExpired: true } as never));
    expect(notifySessionExpired).toHaveBeenCalledTimes(1);
    // 仍是被否定状态的其它变化：不重复提醒
    act(() => useAuthStore.setState({ user: { id: "u1" } } as never));
    expect(notifySessionExpired).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(["contacts"])).toEqual([]);

    act(() => useAuthStore.setState({ tokens: null } as never));
    expect(qc.getQueryData(["contacts"])).toBeUndefined();
    // 已经登出再变别的：不再清 / 不再收提醒
    qc.setQueryData(["contacts"], []);
    act(() => useAuthStore.setState({ user: null } as never));
    expect(qc.getQueryData(["contacts"])).toEqual([]);
    expect(clearSessionExpiredNotice).toHaveBeenCalledTimes(1);
    act(() =>
      useAuthStore.setState({
        tokens: { accessToken: "b", refreshToken: "r" },
        sessionExpired: false,
      } as never),
    );
    expect(clearSessionExpiredNotice).toHaveBeenCalledTimes(2);
  });
});

describe("根布局", () => {
  it("一挂上先等重装检查清完钥匙串，再恢复四份本机设置；三份（登录 / 语言 / 外观）都恢复完才挂路由和实时通道，开屏等常驻层一直在", async () => {
    const r = render(<RootLayout />);
    // 重装检查还没完（iOS 重装后要先清掉上一次安装留在钥匙串里的东西）：一样都不读
    expect(hydrators.auth).not.toHaveBeenCalled();
    expect(hydrators.locale).not.toHaveBeenCalled();
    expect(hydrators.theme).not.toHaveBeenCalled();
    expect(hydrators.consent).not.toHaveBeenCalled();
    await act(async () => {
      mockFreshInstallDone();
    });
    expect(hydrators.auth).toHaveBeenCalledTimes(1);
    expect(hydrators.locale).toHaveBeenCalledTimes(1);
    expect(hydrators.theme).toHaveBeenCalledTimes(1);
    expect(hydrators.consent).toHaveBeenCalledTimes(1);
    const resident = [
      "SplashOverlay",
      "GuideHandover",
      "ToastHost",
      "ConnectionBanner",
      "PrivacyConsentModal",
    ];
    expect(hostNames(r)).toEqual(expect.arrayContaining(resident));
    expect(r.root.findAll((n) => n.type === Stack)).toHaveLength(0);
    expect(useRealtimeUpdates).not.toHaveBeenCalled();

    act(() => {
      useAuthStore.setState({ hydrated: true });
      useLocaleStore.setState({ hydrated: true });
    });
    expect(r.root.findAll((n) => n.type === Stack)).toHaveLength(0);
    expect(useRealtimeUpdates).not.toHaveBeenCalled();

    act(() => useThemeStore.setState({ hydrated: true }));
    expect(r.root.findAll((n) => n.type === Stack)).toHaveLength(1);
    expect(useRealtimeUpdates).toHaveBeenCalled();
    expect(hostNames(r)).toEqual(expect.arrayContaining(resident));
  });

  it("登录门控：没登录只开登录 / 注册 / 找回密码那组，登录后换成 App 那组；协议页、工程模式、找不到页面两边都能进", () => {
    const r = render(<RootLayout />);
    hydrateAll();
    expect(guards(r)).toEqual([false, true]);
    act(() =>
      useAuthStore.setState({
        tokens: { accessToken: "a", refreshToken: "r" },
      } as never),
    );
    expect(guards(r)).toEqual([true, false]);

    // 往上找：先碰到 Stack.Protected 的在门控里，直接碰到 Stack 的在门控外
    const gated = (n: ReactTestInstance) => {
      let cur = n.parent;
      while (cur && cur.type !== Stack) {
        if (cur.type === Stack.Protected) return true;
        cur = cur.parent;
      }
      return false;
    };
    const outside = screens(r)
      .filter((n) => !gated(n))
      .map((n) => n.props.name);
    expect(outside).toEqual(["legal/[doc]", "ble-bench", "+not-found"]);
  });

  it("各页的标题都是翻译过的；求救页全屏、不许手势滑走，真实的单共用一张页（演练页没有 sosId 照默认）", () => {
    const r = render(<RootLayout />);
    hydrateAll();
    const titled: [string, MessageKey][] = [
      ["(tabs)", "nav.back"],
      ["device/[deviceId]", "nav.deviceDetail"],
      ["device-safety/[deviceId]", "device.cat.safety"],
      ["device-alerts/[deviceId]", "device.cat.alerts"],
      ["device-about/[deviceId]", "device.cat.about"],
      ["add-contact", "nav.addContact"],
      ["accident/[accidentId]", "nav.accidentDetail"],
      ["safety-records", "nav.safetyRecords"],
      ["safety-settings", "nav.safetySettings"],
      ["video-preview", "nav.videoPreview"],
      ["contacts", "nav.contacts"],
      ["account/index", "nav.account"],
      ["about", "nav.about"],
      ["account/change-password", "nav.changePassword"],
      ["account/change-phone", "nav.changePhone"],
      ["account/delete", "nav.deleteAccount"],
      ["help", "nav.help"],
      ["(auth)/login", "nav.back"],
      ["(auth)/register", "nav.back"],
      ["(auth)/reset-password", "nav.back"],
      ["legal/[doc]", "nav.privacy"],
      ["ble-bench", "nav.bleBench"],
      ["+not-found", "notFound.title"],
    ];
    for (const [name, key] of titled) {
      expect([name, screen(r, name).props.options.title]).toEqual([
        name,
        tr(key),
      ]);
    }
    expect(screen(r, "bind-device").props.options).toEqual({
      presentation: "fullScreenModal",
    });
    expect(screen(r, "add-contact").props.options.presentation).toBe("modal");

    const sos = screen(r, "sos-active").props;
    expect(sos.options).toEqual({
      presentation: "fullScreenModal",
      gestureEnabled: false,
    });
    const singular = sos.dangerouslySingular as (
      name: string,
      params: Record<string, unknown>,
    ) => string | undefined;
    // 10-16 N10：所有真实的单共用一张页（页内按头盔胶囊切换）
    expect(singular("sos-active", { sosId: "s1", deviceId: "h1" })).toBe(
      "sos-active",
    );
    expect(singular("sos-active", { sosId: "s2", deviceId: "h2" })).toBe(
      "sos-active",
    );
    expect(singular("sos-active", { drill: "1" })).toBeUndefined();
    expect(singular("sos-active", { sosId: ["s1", "s2"] })).toBeUndefined();
  });

  it("外观：深色时状态栏白字、导航主题用深色；浅色反过来；过渡层和错误边界拿到同一个外观", () => {
    const r = render(<RootLayout />);
    hydrateAll();
    const bar = () => r.root.find((n) => isHost(n, "StatusBar")).props.style;
    const theme = () =>
      r.root.find((n) => isHost(n, "ThemeProvider")).props.value;
    const fade = () => r.root.find((n) => isHost(n, "ThemeFade")).props.scheme;
    const boundary = () =>
      r.root.find(
        (n) =>
          typeof n.type !== "string" &&
          (n.type as { name?: string }).name === "AppErrorBoundary",
      ).props.scheme;
    expect([bar(), theme(), fade(), boundary()]).toEqual([
      "light",
      { dark: true },
      "dark",
      "dark",
    ]);
    act(() => useThemeStore.setState({ mode: "light" }));
    expect([bar(), theme(), fade(), boundary()]).toEqual([
      "dark",
      { dark: false },
      "light",
      "light",
    ]);
  });
});
