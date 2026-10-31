// 简单页面：找不到页面、帮助与关于、帮助与反馈、协议阅读页、账号与安全、两个设备设置分类页、标签页布局。
// 路由 / 原生库替身见 helpers/native-mocks；页面放在 src/__tests__/pages 而不是 src/app 下（那里的文件都会被当成路由）。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { ActivityIndicator, Alert, Linking } from "react-native";
import { act } from "react-test-renderer";
import { mockRouter, routerState } from "@/__tests__/helpers/native-mocks";
import { flat, isHost, render, waitFor } from "@/__tests__/helpers/render";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";
import { Tappable } from "@/components/tappable";
import NotFoundScreen from "@/app/+not-found";
import TabsLayout from "@/app/(tabs)/_layout";
import AboutScreen from "@/app/about";
import AccountScreen from "@/app/account";
import DeviceAlertSettingsScreen from "@/app/device-alerts/[deviceId]";
import DeviceSafetySettingsScreen from "@/app/device-safety/[deviceId]";
import HelpScreen from "@/app/help";
import LegalDocScreen from "@/app/legal/[doc]";

jest.mock("@/global.css", () => ({}));
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
jest.mock("expo-router", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .expoRouterMock(),
);
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
const mockExpoConfig: { current: { version?: string } | null } = {
  current: { version: "1.2.3" },
};
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig.current;
    },
  },
}));
jest.mock("react-native-webview", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { WebView: (props: Record<string, unknown>) => h("WebView", props) };
});
jest.mock("@/components/device-settings-page", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return {
    DeviceSettingsPage: (props: Record<string, unknown>) =>
      h("DeviceSettingsPage", props),
  };
});
jest.mock("@/components/app-tabs", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { __esModule: true, default: () => h("AppTabs") };
});
jest.mock("@/components/keepalive-tip", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { KeepAliveTip: () => h("KeepAliveTip") };
});
const mockApiBase = { current: "https://dev-api.example.com/api/v1" };
jest.mock("@/constants/api", () => ({
  get API_BASE_URL() {
    return mockApiBase.current;
  },
}));
const mockWatcher = jest.fn();
jest.mock("@/hooks/use-switch-reminder", () => ({
  useSwitchHelmetWatcher: () => mockWatcher(),
}));

/** 只有一个按钮的提示统一走 services/notice 的 showNotice：第三个参数是一个「确定」 */
const NOTICE_OK = [{ text: translate("common.confirm", undefined, "zh-CN") }];
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
let alertSpy: ReturnType<typeof jest.spyOn>;
let openSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  routerState.params = {};
  routerState.pathname = "/";
  mockExpoConfig.current = { version: "1.2.3" };
  mockApiBase.current = "https://dev-api.example.com/api/v1";
  alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  openSpy = jest
    .spyOn(Linking, "openURL")
    .mockImplementation(() => Promise.resolve(true));
});
afterEach(() => {
  alertSpy.mockRestore();
  openSpy.mockRestore();
  jest.clearAllMocks();
});

describe("找不到页面（+not-found）", () => {
  it("说明打不开，按钮回首页（replace，不在栈里留这一页）", () => {
    const r = render(<NotFoundScreen />);
    expect(r.texts()).toEqual([
      tr("notFound.title"),
      tr("notFound.body"),
      tr("notFound.home"),
    ]);
    expect(r.icons()).toContain("unlink-outline");
    r.press(tr("notFound.home"));
    expect(mockRouter.replace).toHaveBeenCalledWith("/");
  });
});

describe("帮助与关于（about）", () => {
  it("五个入口各跳各的页面", () => {
    const r = render(<AboutScreen />);
    r.press(tr("profile.help"));
    r.press(tr("profile.privacy"));
    r.press(tr("profile.terms"));
    r.press(tr("profile.collection"));
    r.press(tr("profile.sharing"));
    expect(mockRouter.navigate.mock.calls.map((c) => c[0])).toEqual([
      "/help",
      "/legal/privacy",
      "/legal/terms",
      "/legal/collection",
      "/legal/sharing",
    ]);
  });

  it("关于：右边写版本号，点开弹窗里也写版本", () => {
    const r = render(<AboutScreen />);
    expect(r.allText()).toContain("1.2.3");
    r.press(tr("profile.about"));
    expect(alertSpy).toHaveBeenCalledWith(
      translate("profile.about"),
      `${translate("profile.version", { v: "1.2.3" })}\n\n${translate("profile.aboutBody")}`,
      NOTICE_OK,
    );
  });

  it("读不到版本号时显示一横", () => {
    mockExpoConfig.current = null;
    const r = render(<AboutScreen />);
    expect(r.texts()).toContain("—");
  });
});

describe("帮助与反馈（help）", () => {
  it("八个常见问题默认收起；点一下展开答案，再点收起；可以同时展开多个", () => {
    const r = render(<HelpScreen />);
    for (let i = 1; i <= 8; i++)
      expect(r.allText()).toContain(tr(`help.q${i}` as MessageKey));
    expect(r.allText()).not.toContain(tr("help.a1"));
    r.press(tr("help.q1"));
    r.press(tr("help.q3"));
    expect(r.allText()).toContain(tr("help.a1"));
    expect(r.allText()).toContain(tr("help.a3"));
    const expanded = r.root
      .findAll(
        (n) => n.type === Tappable && n.props.accessibilityRole === "button",
      )
      .map((n) => n.props.accessibilityState.expanded);
    expect(expanded).toEqual([
      true,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    r.press(tr("help.q1"));
    expect(r.allText()).not.toContain(tr("help.a1"));
    expect(r.allText()).toContain(tr("help.a3"));
  });

  it("反馈邮件带上版本号作主题；官网用浏览器打开", () => {
    const r = render(<HelpScreen />);
    r.press(tr("help.email"));
    expect(openSpy).toHaveBeenCalledWith(
      `mailto:zhongqilong@01weichuang.com?subject=${encodeURIComponent(translate("help.emailSubject", { v: "1.2.3" }))}`,
    );
    r.press(tr("help.site"));
    expect(openSpy).toHaveBeenLastCalledWith("https://www.01weichuang.com");
    expect(r.allText()).toContain("www.01weichuang.com");
  });

  it("打不开链接（没装邮件 App）时提示", async () => {
    openSpy.mockImplementation(() => Promise.reject(new Error("no handler")));
    const r = render(<HelpScreen />);
    r.press(tr("help.site"));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        translate("help.openFailed"),
        undefined,
        NOTICE_OK,
      ),
    );
  });
});

describe("协议阅读页（legal/[doc]）", () => {
  const webview = (r: ReturnType<typeof render>) =>
    r.root.find((n) => isHost(n, "WebView"));
  const title = (r: ReturnType<typeof render>) =>
    (
      r.root.find((n) => isHost(n, "StackScreen")).props.options as {
        title: string;
      }
    ).title;

  it("按参数打开对应文档；认不出的参数回隐私政策", () => {
    routerState.params = { doc: "terms" };
    let r = render(<LegalDocScreen />);
    expect(webview(r).props.source).toEqual({
      uri: "https://dev-api.example.com/legal/terms",
    });
    expect(title(r)).toBe(tr("legal.terms.title"));
    routerState.params = { doc: "../../etc" };
    r = render(<LegalDocScreen />);
    expect(webview(r).props.source).toEqual({
      uri: "https://dev-api.example.com/legal/privacy",
    });
    expect(title(r)).toBe(tr("legal.privacy.title"));
  });

  // 慢网下 WebView 出来之前整屏空白；库自带的加载视图是白底，深色主题下会闪白
  it("页面出来之前画加载中（底色跟主题，铺满盖住 WebView）", () => {
    routerState.params = { doc: "privacy" };
    for (const mode of ["dark", "light"] as const) {
      act(() => useThemeStore.setState({ mode }));
      const r = render(<LegalDocScreen />);
      const view = webview(r);
      expect(view.props.startInLoadingState).toBe(true);
      const loading = render(
        (view.props.renderLoading as () => React.ReactElement)(),
      );
      const box = loading.root.find(
        (n) => isHost(n, "View") && n.props.style !== undefined,
      );
      expect(flat(box.props.style)).toMatchObject({
        backgroundColor: Colors[mode].background,
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
      });
      expect(loading.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    }
  });

  it("加载失败：显示重试和用浏览器打开；重试换一个新的 WebView", () => {
    routerState.params = { doc: "privacy" };
    const r = render(<LegalDocScreen />);
    const uri = (webview(r).props.source as { uri: string }).uri;
    act(() => (webview(r).props.onHttpError as () => void)());
    expect(r.allText()).toContain(tr("legal.loadError"));
    r.press(tr("legal.openInBrowser"));
    expect(openSpy).toHaveBeenCalledWith(uri);
    r.press(tr("legal.retry"));
    const again = webview(r);
    expect(again).toBeTruthy();
    act(() => (again.props.onError as () => void)());
    expect(r.allText()).toContain(tr("legal.loadError"));
  });

  it("后端地址配错（拿不到站点根）：一进来就是打不开，不给浏览器按钮，重试也还是打不开", () => {
    mockApiBase.current = "not a url";
    const r = render(<LegalDocScreen />);
    expect(r.root.findAll((n) => isHost(n, "WebView"))).toHaveLength(0);
    expect(r.allText()).toContain(tr("legal.loadError"));
    expect(r.allText()).not.toContain(tr("legal.openInBrowser"));
    r.press(tr("legal.retry"));
    expect(r.allText()).toContain(tr("legal.loadError"));
  });
});

describe("账号与安全（account）", () => {
  afterEach(() => {
    act(() => useAuthStore.setState({ user: null }));
  });

  it("手机号脱敏显示；三个入口各跳各的", () => {
    useAuthStore.setState({
      user: { id: "u1", phone: "13900000042" } as never,
    });
    const r = render(<AccountScreen />);
    expect(r.allText()).toContain("139****0042");
    r.press(tr("profile.changePassword"));
    r.press(tr("profile.changePhone"));
    r.press(tr("profile.deleteAccount"));
    expect(mockRouter.navigate.mock.calls.map((c) => c[0])).toEqual([
      "/account/change-password",
      "/account/change-phone",
      "/account/delete",
    ]);
  });

  it("还没有用户档案时手机号显示一横", () => {
    const r = render(<AccountScreen />);
    expect(r.texts()).toContain("—");
  });
});

describe("设备设置分类页", () => {
  it("提醒方式：振动 / 蜂鸣 / 断连蜂鸣一组，底部说明音量在详情页", () => {
    routerState.params = { deviceId: "h1" };
    const r = render(<DeviceAlertSettingsScreen />);
    const page = r.root.find((n) => isHost(n, "DeviceSettingsPage"));
    expect(page.props.deviceId).toBe("h1");
    expect(page.props.groups).toEqual([
      { keys: ["vibration", "buzzer", "disconnectBeep"] },
    ]);
    expect(page.props.note).toBe("device.alerts.volumeNote");
  });

  it("安全检测与预警：摔倒相关一组、骑行预警一组（带标题）", () => {
    routerState.params = { deviceId: "h2" };
    const r = render(<DeviceSafetySettingsScreen />);
    const page = r.root.find((n) => isHost(n, "DeviceSettingsPage"));
    expect(page.props.deviceId).toBe("h2");
    expect(page.props.groups).toEqual([
      { keys: ["fallDetect", "fallSensitivity", "sosButton"] },
      {
        title: "device.safety.rideGroup",
        keys: ["radar", "radarDistance", "obstacleWarn"],
      },
    ]);
  });
});

describe("标签页布局", () => {
  it("挂上标签条和「App 别关」提示，并启动更换头盔提醒的观察", () => {
    const r = render(<TabsLayout />);
    expect(r.root.findAll((n) => isHost(n, "AppTabs"))).toHaveLength(1);
    expect(r.root.findAll((n) => isHost(n, "KeepAliveTip"))).toHaveLength(1);
    expect(mockWatcher).toHaveBeenCalled();
  });
});
