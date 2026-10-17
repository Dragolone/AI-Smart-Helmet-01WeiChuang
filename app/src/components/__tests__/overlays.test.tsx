// 浮层 / 提示类组件：全局轻提示、连接中断细条、深浅色软过渡、「App 别关」一次性提示、
// 隐私同意弹窗、更换当前头盔面板、对讲小条、底部标签。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import { Animated as RNAnimated, Platform, Text } from "react-native";
import { act } from "react-test-renderer";

import {
  mockInsets,
  mockRouter,
  routerState,
} from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  makeQueryClient,
  render,
  rootJson,
} from "@/__tests__/helpers/render";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useBleStore } from "@/stores/ble-store";
import { useConsentStore } from "@/stores/consent-store";
import { useIntercomStore } from "@/stores/intercom-store";
import { useSwitchReminderStore } from "@/stores/switch-reminder-store";
import { useThemeStore } from "@/stores/theme-store";
import AppTabs from "../app-tabs";
import { ConnectionBanner } from "../connection-banner";
import { IntercomMiniBar } from "../intercom-mini-bar";
import { KeepAliveTip } from "../keepalive-tip";
import { PrivacyConsentModal } from "../privacy-consent-modal";
import { SwitchHelmetPrompt } from "../switch-helmet-prompt";
import { ThemeFade } from "../theme-fade";
import { ToastHost, showToast } from "../toast";

jest.mock("@/global.css", () => ({}));
jest.mock("@expo/vector-icons", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .iconsMock(),
);
jest.mock("@expo/vector-icons/Ionicons", () => ({
  __esModule: true,
  default: jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .iconsMock().Ionicons,
}));
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
jest.mock("expo-router/unstable-native-tabs", () => {
  const { createElement, useEffect } =
    jest.requireActual<typeof import("react")>("react");
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: unknown }) =>
      createElement(name, props, children as never);
  const Trigger = Object.assign(host("Trigger"), {
    Label: host("TriggerLabel"),
    Icon: host("TriggerIcon"),
  });
  // 记挂载次数：切语言时标签栏要不要整个重建（key 变了 = 卸掉重挂）
  const mounts = { n: 0 };
  const Tabs = ({ children, ...props }: { children?: unknown }) => {
    useEffect(() => {
      mounts.n += 1;
    }, []);
    return createElement("NativeTabs", props, children as never);
  };
  return { NativeTabs: Object.assign(Tabs, { Trigger, mounts }) };
});
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  selectionAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
  AFTER_FIRST_UNLOCK: 0,
}));
const mockStateListeners: ((connected: boolean) => void)[] = [];
const mockRealtime = { connected: false };
jest.mock("@/api/realtime", () => ({
  realtimeClient: {
    // 和真的一样：订阅时先回放一次当前状态，退订就不再收到
    subscribeState: (l: (connected: boolean) => void) => {
      mockStateListeners.push(l);
      l(mockRealtime.connected);
      return () => {
        const i = mockStateListeners.indexOf(l);
        if (i >= 0) mockStateListeners.splice(i, 1);
      };
    },
  },
}));
const mockChoose = jest.fn();
jest.mock("@/hooks/use-safety", () => ({
  useCurrentHelmetChoice: () => ({
    choose: (...a: unknown[]) => mockChoose(...a),
  }),
}));

const dark = Colors.dark;
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
/** 改 store 时可能有树挂着：包在 act 里 */
const set = (fn: () => void) =>
  act(() => {
    fn();
  });
const authed = () =>
  set(() =>
    useAuthStore.setState({
      tokens: { accessToken: "a", refreshToken: "r" } as never,
      user: { id: "u1" } as never,
    }),
  );

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  routerState.pathname = "/";
  routerState.focused = true;
});
afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  act(() => {
    useAuthStore.setState({ tokens: null, user: null });
    useIntercomStore.setState({ session: null });
    useBleStore.setState({ links: {} });
    useSwitchReminderStore.setState({ prompt: null, asked: {}, enabled: {} });
    useConsentStore.setState({ hydrated: false, privacyAccepted: false });
  });
  mockStateListeners.length = 0;
  mockRealtime.connected = false;
});

// 轻提示用的 RN Animated：换成「start 时直接跳到终值并回调」的假动画：不依赖 jest 里 Animated 的计时，只看逻辑
let spy: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  spy = jest.spyOn(RNAnimated, "timing").mockImplementation(
    (value, config) =>
      ({
        start: (cb?: (r: { finished: boolean }) => void) => {
          (value as RNAnimated.Value).setValue(
            (config as { toValue: number }).toValue,
          );
          cb?.({ finished: true });
        },
        stop: jest.fn(),
        reset: jest.fn(),
      }) as never,
  );
});
afterEach(() => spy.mockRestore());

describe("ToastHost / showToast", () => {
  it("没挂 Host 时静默丢弃；挂上后显示，2 秒后收起", () => {
    jest.useFakeTimers();
    expect(() => showToast("丢掉")).not.toThrow();
    const r = render(<ToastHost />);
    expect(r.tree.toJSON()).toBeNull();
    act(() => showToast("已保存"));
    expect(r.texts()).toEqual(["已保存"]);
    const s = flat(rootJson(r).props.style);
    // 底部让开安全区 + 标签栏
    expect(s.bottom).toBe(mockInsets.bottom + 96);
    expect(s.backgroundColor).toBe(dark.backgroundSelected);
    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(r.texts()).toEqual(["已保存"]);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(r.tree.toJSON()).toBeNull();
  });

  it("连着弹两条：第二条重新计时，不会被第一条的计时器提前收掉", () => {
    jest.useFakeTimers();
    const r = render(<ToastHost />);
    act(() => showToast("第一条"));
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    act(() => showToast("第二条"));
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(r.texts()).toEqual(["第二条"]);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(r.tree.toJSON()).toBeNull();
  });

  it("Host 卸掉后再调用不再显示、不抛错", () => {
    const r = render(<ToastHost />);
    r.unmount();
    expect(() => showToast("x")).not.toThrow();
  });
});

describe("ConnectionBanner", () => {
  const drop = (connected: boolean) =>
    act(() => {
      mockRealtime.connected = connected;
      [...mockStateListeners].forEach((l) => l(connected));
    });

  it("登录着、在标签根页：断开超过 4 秒才出现，恢复即收", () => {
    jest.useFakeTimers();
    authed();
    const r = render(<ConnectionBanner />);
    drop(true);
    drop(false);
    act(() => {
      jest.advanceTimersByTime(3999);
    });
    expect(r.tree.toJSON()).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(r.texts()).toEqual([tr("map.reconnecting")]);
    expect(r.icons()).toEqual(["cloud-offline-outline"]);
    expect(flat(rootJson(r).props.style).top).toBe(mockInsets.top + 6);
    drop(true);
    expect(r.tree.toJSON()).toBeNull();
  });

  it("4 秒内恢复：不闪；断开期间再报一次断开不重新计时", () => {
    jest.useFakeTimers();
    authed();
    const r = render(<ConnectionBanner />);
    drop(false);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    drop(false);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    // 第二次「断开」沿用第一次的时刻：4 秒到了就出现
    expect(r.texts()).toHaveLength(1);
    drop(true);
    drop(false);
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(r.tree.toJSON()).toBeNull();
  });

  it("没登录、地图页、二级页都不显示", () => {
    jest.useFakeTimers();
    const r = render(<ConnectionBanner />);
    drop(false);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(r.tree.toJSON()).toBeNull();
    authed();
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(r.texts()).toHaveLength(1);
    routerState.pathname = "/map";
    r.rerender(<ConnectionBanner />);
    expect(r.tree.toJSON()).toBeNull();
    routerState.pathname = "/device/h1";
    r.rerender(<ConnectionBanner />);
    expect(r.tree.toJSON()).toBeNull();
    for (const p of ["/intercom", "/safety", "/profile"]) {
      routerState.pathname = p;
      r.rerender(<ConnectionBanner />);
      expect(r.texts()).toHaveLength(1);
    }
  });

  // 没登录时通道本来就断着：原来宽限期在登录页上就耗完了，一登录就闪「连接中断，重连中…」（10-17 评审）
  it("刚登录：宽限期从登录那一刻起算，4 秒内连上就不出现；登出再登录也重新计", () => {
    jest.useFakeTimers();
    const r = render(<ConnectionBanner />);
    act(() => {
      jest.advanceTimersByTime(60_000); // 在登录页上停了一分钟
    });
    authed();
    expect(r.tree.toJSON()).toBeNull();
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(r.tree.toJSON()).toBeNull();
    drop(true);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(r.tree.toJSON()).toBeNull();
    // 断开显示出来之后登出，过一会儿再登录：不沿用上一次的断开时刻
    drop(false);
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(r.texts()).toHaveLength(1);
    set(() => useAuthStore.setState({ tokens: null, user: null }));
    expect(r.tree.toJSON()).toBeNull();
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    authed();
    expect(r.tree.toJSON()).toBeNull();
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(r.texts()).toHaveLength(1);
  });

  it("对讲页在房间里：房间有自己的重连条，全局这条不显示（压在频道名上，10-16 iPhone）；别的标签页照常", () => {
    jest.useFakeTimers();
    authed();
    act(() =>
      useIntercomStore.getState().setSession({
        channelId: "c1",
        channelName: "emutest",
        micOpen: false,
        reconnecting: true,
      }),
    );
    routerState.pathname = "/intercom";
    const r = render(<ConnectionBanner />);
    drop(false);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(r.tree.toJSON()).toBeNull();
    routerState.pathname = "/safety";
    r.rerender(<ConnectionBanner />);
    expect(r.texts()).toHaveLength(1);
    act(() => useIntercomStore.getState().setSession(null));
    routerState.pathname = "/intercom";
    r.rerender(<ConnectionBanner />);
    expect(r.texts()).toHaveLength(1);
  });
});

describe("ThemeFade", () => {
  it("首次挂上不盖；切换后用旧主题底色盖一层再淡出（替身里直接淡到 0）", () => {
    const r = render(<ThemeFade scheme="dark" />);
    let s = flat(rootJson(r).props.style);
    expect(s.opacity).toBe(0);
    expect(s.backgroundColor).toBe(dark.background);
    expect(rootJson(r).props.pointerEvents).toBe("none");
    r.rerender(<ThemeFade scheme="light" />);
    r.rerender(<ThemeFade scheme="light" />);
    s = flat(rootJson(r).props.style);
    // 盖的是切换前（深色）的底色
    expect(s.backgroundColor).toBe(dark.background);
    expect(s.opacity).toBe(0);
    r.rerender(<ThemeFade scheme="dark" />);
    r.rerender(<ThemeFade scheme="dark" />);
    expect(flat(rootJson(r).props.style).backgroundColor).toBe(
      Colors.light.background,
    );
  });
});

describe("KeepAliveTip", () => {
  const original = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, "OS", {
      value: original,
      configurable: true,
    });
  });
  const connect = () =>
    act(() =>
      useBleStore.setState({
        links: { h1: { phase: "connected", eventsReceived: 0, resent: 0 } },
      }),
    );
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  it("从没展示过、第一次连上头盔：弹出；点「知道了」关掉并记住", async () => {
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    const r = render(<KeepAliveTip />);
    await flush();
    expect(r.tree.toJSON()).toBeNull();
    connect();
    expect(r.allText()).toContain(tr("keepalive.title"));
    // iOS 不显示华为那句
    expect(r.allText()).not.toContain(tr("keepalive.androidTip"));
    r.press(tr("keepalive.ok"));
    expect(r.tree.toJSON()).toBeNull();
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "keepalive_tip_shown",
      "1",
    );
  });

  it("Android 多一句锁定最近任务；点遮罩也算关", async () => {
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    const r = render(<KeepAliveTip />);
    await flush();
    connect();
    expect(r.allText()).toContain(tr("keepalive.androidTip"));
    const mask = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        typeof n.props.onPress === "function" &&
        n.props.style !== undefined &&
        !n.props.accessibilityState,
    );
    act(() => mask.props.onPress());
    expect(r.tree.toJSON()).toBeNull();
  });

  it("展示过就不再弹；读存储失败按没展示过", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(() =>
      Promise.resolve("1"),
    );
    let r = render(<KeepAliveTip />);
    await flush();
    connect();
    expect(r.tree.toJSON()).toBeNull();
    r.unmount();
    act(() => useBleStore.setState({ links: {} }));
    (SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("locked")),
    );
    r = render(<KeepAliveTip />);
    await flush();
    connect();
    expect(r.allText()).toContain(tr("keepalive.title"));
  });

  it("头盔只在连接中（没连上）不弹", async () => {
    const r = render(<KeepAliveTip />);
    await flush();
    act(() =>
      useBleStore.setState({
        links: { h1: { phase: "connecting", eventsReceived: 0, resent: 0 } },
      }),
    );
    expect(r.tree.toJSON()).toBeNull();
  });
});

describe("PrivacyConsentModal", () => {
  const show = () => {
    authed();
    set(() =>
      useConsentStore.setState({ hydrated: true, privacyAccepted: false }),
    );
  };

  it("已登录、读到「没同意过」：弹出；不勾选时「同意」不可点", () => {
    show();
    const r = render(<PrivacyConsentModal />);
    expect(r.allText()).toContain(tr("consent.title"));
    const agree = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityState?.busy !== undefined,
    );
    expect(agree.props.accessibilityState.disabled).toBe(true);
    expect(r.icons()).toContain("square-outline");
  });

  it("勾选后可同意：同意写进 store；协议链接跳到对应页面", () => {
    show();
    const r = render(<PrivacyConsentModal />);
    const box = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        n.props.accessibilityRole === "checkbox" &&
        typeof n.props.onPress === "function",
    );
    act(() => box.props.onPress());
    expect(r.icons()).toContain("checkbox");
    r.press(tr("auth.consentTerms"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/legal/terms");
    r.press(tr("auth.consentPrivacy"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/legal/privacy");
    r.press(tr("consent.agree"));
    expect(useConsentStore.getState().privacyAccepted).toBe(true);
    expect(r.tree.toJSON()).toBeNull();
  });

  it("不同意就退出登录", () => {
    show();
    const signOut = jest.fn(() => Promise.resolve());
    set(() => useAuthStore.setState({ signOut }));
    const r = render(<PrivacyConsentModal />);
    r.press(tr("consent.signOut"));
    expect(signOut).toHaveBeenCalled();
  });

  it("没登录 / 还没读完 / 已同意 / 在协议页或求救倒计时页：都不弹", () => {
    expect(render(<PrivacyConsentModal />).tree.toJSON()).toBeNull();
    authed();
    expect(render(<PrivacyConsentModal />).tree.toJSON()).toBeNull();
    set(() =>
      useConsentStore.setState({ hydrated: true, privacyAccepted: true }),
    );
    expect(render(<PrivacyConsentModal />).tree.toJSON()).toBeNull();
    set(() => useConsentStore.setState({ privacyAccepted: false }));
    routerState.pathname = "/legal/privacy";
    expect(render(<PrivacyConsentModal />).tree.toJSON()).toBeNull();
    routerState.pathname = "/sos-active";
    expect(render(<PrivacyConsentModal />).tree.toJSON()).toBeNull();
  });
});

describe("SwitchHelmetPrompt", () => {
  const client = () => {
    const qc = makeQueryClient();
    qc.setQueryData(
      ["devices"],
      [
        { deviceId: "h1", name: "通勤头盔" },
        { deviceId: "h2", name: null },
      ],
    );
    return qc;
  };
  const mount = (qc = client()) =>
    render(
      <QueryClientProvider client={qc}>
        <SwitchHelmetPrompt />
        <ToastHost />
      </QueryClientProvider>,
    );
  const ask = () => {
    authed();
    set(() =>
      useSwitchReminderStore.setState({
        enabled: { u1: true },
        prompt: { currentId: "h1", otherId: "h2" },
      }),
    );
  };

  it("没有要问的、没登录：不弹", () => {
    expect(mount().allText()).toBe("");
    set(() =>
      useSwitchReminderStore.setState({
        prompt: { currentId: "h1", otherId: "h2" },
      }),
    );
    expect(mount().allText()).toBe("");
  });

  it("名字从缓存里取：起过名的用名字、没起名的用设备号；底部让出安全区", () => {
    ask();
    const r = mount();
    expect(r.allText()).toContain(tr("switchReminder.title", { name: "h2" }));
    expect(r.allText()).toContain(
      tr("switchReminder.body", { current: "通勤头盔" }),
    );
    const sheet = r.root.find(
      (n) =>
        typeof n.type === "string" && n.props.accessibilityViewIsModal === true,
    );
    expect(flat(sheet.props.style).paddingBottom).toBe(
      Math.max(mockInsets.bottom, 12) + 8,
    );
  });

  it("点「换成 X」：设为当前、弹提示、记为问过；不勾不再提醒时开关不动", () => {
    ask();
    const r = mount();
    r.press(tr("switchReminder.switch", { name: "h2" }));
    expect(mockChoose).toHaveBeenCalledWith("h2");
    expect(r.allText()).toContain(
      tr("switchReminder.switched", { name: "h2" }),
    );
    const st = useSwitchReminderStore.getState();
    expect(st.prompt).toBeNull();
    expect(st.enabled.u1).toBe(true);
    expect(Object.keys(st.asked)).toEqual(["u1:h1>h2"]);
  });

  it("勾「以后不再提醒」再点保持不变：不换，并把开关关掉", () => {
    ask();
    const r = mount();
    const box = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        n.props.accessibilityRole === "checkbox" &&
        typeof n.props.onPress === "function",
    );
    act(() => box.props.onPress());
    expect(r.icons()).toContain("checkmark");
    r.press(tr("switchReminder.keep"));
    expect(mockChoose).not.toHaveBeenCalled();
    expect(useSwitchReminderStore.getState().enabled.u1).toBe(false);
  });

  it("点面板外、按返回键都算不换；不在当前页时面板不可见", () => {
    ask();
    const r = mount();
    const modal = r.root.find(
      (n) => typeof n.props.onRequestClose === "function",
    );
    expect(modal.props.visible).toBe(true);
    act(() => modal.props.onRequestClose());
    expect(useSwitchReminderStore.getState().prompt).toBeNull();
    expect(mockChoose).not.toHaveBeenCalled();
    ask();
    routerState.focused = false;
    const r2 = mount();
    expect(
      r2.root.find((n) => typeof n.props.onRequestClose === "function").props
        .visible,
    ).toBe(false);
    expect(r2.allText()).toBe("");
  });

  it("设备列表缓存里没有这台：退回设备号", () => {
    ask();
    set(() =>
      useSwitchReminderStore.setState({
        prompt: { currentId: "hx", otherId: "h1" },
      }),
    );
    const r = mount(makeQueryClient());
    expect(r.allText()).toContain(tr("switchReminder.body", { current: "hx" }));
  });
});

describe("IntercomMiniBar", () => {
  const session = (over = {}) => ({
    channelId: "c1",
    channelName: "车队",
    micOpen: true,
    reconnecting: false,
    ...over,
  });

  it("不在房间里不占位置", () => {
    expect(render(<IntercomMiniBar />).tree.toJSON()).toBeNull();
  });

  it("开着麦：品牌色麦克风、副标题「麦克风已开启」；点了回对讲页", () => {
    set(() => useIntercomStore.setState({ session: session() }));
    const r = render(<IntercomMiniBar />);
    expect(r.icons()).toEqual(["mic"]);
    expect(r.texts()).toEqual([
      tr("intercom.mini.title", { name: "车队" }),
      tr("intercom.mini.micOn"),
      tr("intercom.mini.back"),
    ]);
    const sub = r.root.findAllByType(Text)[1];
    expect(flat(sub.props.style).color).toBe(dark.brand);
    const label = `${tr("intercom.mini.title", { name: "车队" })}，${tr("intercom.mini.micOn")}，${tr("intercom.mini.back")}`;
    const btn = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === "function",
    );
    act(() => btn.props.onPress());
    expect(mockRouter.navigate).toHaveBeenCalledWith("/intercom");
  });

  it("静音：灰色描边麦克风；掉线重连时副标题写重连中、不用品牌色", () => {
    set(() =>
      useIntercomStore.setState({ session: session({ micOpen: false }) }),
    );
    let r = render(<IntercomMiniBar />);
    expect(r.icons()).toEqual(["mic-outline"]);
    expect(r.texts()[1]).toBe(tr("intercom.mini.micOff"));
    set(() =>
      useIntercomStore.setState({ session: session({ reconnecting: true }) }),
    );
    r = render(<IntercomMiniBar />);
    expect(r.texts()[1]).toBe(tr("intercom.reconnecting"));
    expect(flat(r.root.findAllByType(Text)[1].props.style).color).toBe(
      dark.textSecondary,
    );
  });
});

describe("AppTabs", () => {
  it("五个标签按定稿顺序，标签文字随语言，颜色随主题", () => {
    const r = render(<AppTabs />);
    const triggers = r.root.findAll((n) => isHost(n, "Trigger"));
    expect(triggers.map((n) => n.props.name)).toEqual([
      "index",
      "map",
      "intercom",
      "safety",
      "profile",
    ]);
    const labels = r.root
      .findAll((n) => isHost(n, "TriggerLabel"))
      .map((n) => n.props.children);
    expect(labels).toEqual(["设备", "地图", "对讲", "安全", "我的"]);
    const tabs = r.root.find((n) => isHost(n, "NativeTabs"));
    expect(tabs.props.tintColor).toBe(dark.brand);
    expect(tabs.props.backgroundColor).toBe(dark.background);
    // 对讲那个没有实心款：iOS 一个 SF 名字、Android 一张图
    const icons = r.root.findAll((n) => isHost(n, "TriggerIcon"));
    expect(icons[2].props.sf).toBe("dot.radiowaves.left.and.right");
    expect(icons[0].props.sf).toEqual({
      default: "house",
      selected: "house.fill",
    });
    act(() => useThemeStore.setState({ mode: "light" }));
    expect(r.root.find((n) => isHost(n, "NativeTabs")).props.tintColor).toBe(
      Colors.light.brand,
    );
  });

  const tabsMounts = () =>
    (
      jest.requireMock("expo-router/unstable-native-tabs") as {
        NativeTabs: { mounts: { n: number } };
      }
    ).NativeTabs.mounts.n;
  const labelsOf = (r: ReturnType<typeof render>) =>
    r.root
      .findAll((n) => isHost(n, "TriggerLabel"))
      .map((n) => n.props.children);

  it("iOS 切换语言：标签栏整个重建（原生标签项的读屏标签只在创建时取一次，10-16 iPhone），重建完回到原来那一页", () => {
    jest.useFakeTimers();
    routerState.pathname = "/profile";
    const r = render(<AppTabs />);
    const before = tabsMounts();
    act(() => useLocaleStore.setState({ locale: "en" }));
    expect(tabsMounts()).toBe(before + 1);
    expect(labelsOf(r)[0]).toBe(translate("tab.devices", undefined, "en"));
    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(mockRouter.navigate).toHaveBeenCalledWith("/profile");
    // 主题变了不重建
    act(() => useThemeStore.setState({ mode: "light" }));
    expect(tabsMounts()).toBe(before + 1);
  });

  it("在对讲房间里切语言：先不重建（重建会卸掉对讲页、通话就断了），出了房间再换", () => {
    jest.useFakeTimers();
    routerState.pathname = "/intercom";
    act(() =>
      useIntercomStore.getState().setSession({
        channelId: "c1",
        channelName: "emutest",
        micOpen: false,
        reconnecting: false,
      }),
    );
    const r = render(<AppTabs />);
    const before = tabsMounts();
    act(() => useLocaleStore.setState({ locale: "en" }));
    expect(tabsMounts()).toBe(before);
    // 文字照样换（只是读屏标签要等重建）
    expect(labelsOf(r)[0]).toBe(translate("tab.devices", undefined, "en"));
    act(() => useIntercomStore.getState().setSession(null));
    expect(tabsMounts()).toBe(before + 1);
  });

  it("首页切语言（已经在第一页）：重建后不用再跳；安卓不重建（只 iOS 有读屏标签不更新的问题）", () => {
    jest.useFakeTimers();
    routerState.pathname = "/";
    const r1 = render(<AppTabs />);
    const before = tabsMounts();
    act(() => useLocaleStore.setState({ locale: "en" }));
    expect(tabsMounts()).toBe(before + 1);
    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    r1.unmount();
    const original = Platform.OS;
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    try {
      const r2 = render(<AppTabs />);
      const mid = tabsMounts();
      act(() => useLocaleStore.setState({ locale: "zh-TW" }));
      expect(tabsMounts()).toBe(mid);
      expect(labelsOf(r2)[0]).toBe(
        translate("tab.devices", undefined, "zh-TW"),
      );
    } finally {
      Object.defineProperty(Platform, "OS", {
        value: original,
        configurable: true,
      });
    }
  });
});
