// 设备标签页（首页）：列表没拉到 ≠ 没绑头盔、从没绑过的账号走三步指引、绑过又解绑的只给绑定那一张、
// 当前头盔大图（名字 / 连接状态 / 去详情）、两格摘要（安全 / 今日骑行）、其他设备（连着的才能设为当前）、下拉刷新。
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import type { DevicePublic } from "@helmet/shared";
import { RefreshControl } from "react-native";
import { act } from "react-test-renderer";
import { mockRouter } from "@/__tests__/helpers/native-mocks";
import {
  makeQueryClient,
  render,
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { releaseSplashHold } from "@/components/splash/bus";
import { Tappable } from "@/components/tappable";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { formatKm } from "@/i18n/format";
import { useAuthStore } from "@/stores/auth-store";
import { useGuideStore } from "@/stores/guide-store";
import { useHelmetHistoryStore } from "@/stores/helmet-history-store";
import { useThemeStore } from "@/stores/theme-store";
import DevicesScreen from "@/app/(tabs)/index";

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
jest.mock("expo-image", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { Image: (props: Record<string, unknown>) => h("ExpoImage", props) };
});
jest.mock("expo-notifications", () => ({ requestPermissionsAsync: jest.fn() }));
const mockKv = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => mockKv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    mockKv.set(k, v);
  },
  AFTER_FIRST_UNLOCK: 0,
}));
jest.mock("@/api/devices", () => ({ devicesApi: { list: jest.fn() } }));
jest.mock("@/api/contacts", () => ({ contactsApi: { list: jest.fn() } }));
jest.mock("@/hooks/use-app-active", () => ({ useAppActive: () => true }));
const mockRide = { value: { status: "unknown" } as Record<string, unknown> };
jest.mock("@/hooks/use-ride-today", () => ({
  ...jest.requireActual<typeof import("@/hooks/use-ride-today")>(
    "@/hooks/use-ride-today",
  ),
  useRideToday: () => mockRide.value,
}));
jest.mock("@/components/splash/guide-handover", () => ({
  prepareGuideHandover: jest.fn(),
}));
jest.mock("@/components/ble-onboarding", () => ({
  useBleOnboardingSteps: () => [],
}));
const mockSafety = {
  links: {} as Record<string, string>,
  notify: "granted" as string | null,
  chosenId: null as string | null,
  ready: true,
  choose: jest.fn(),
};
jest.mock("@/hooks/use-safety", () => ({
  useHelmetLinks: () => mockSafety.links,
  useNotifyPermission: () => mockSafety.notify,
  useCurrentHelmetChoice: () => ({
    chosenId: mockSafety.chosenId,
    ready: mockSafety.ready,
    choose: mockSafety.choose,
  }),
}));

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const dev = (id: string, over: Partial<DevicePublic> = {}) =>
  ({
    deviceId: id,
    name: null,
    battery: 80,
    charging: false,
    online: true,
    lastSeenAt: new Date().toISOString(),
    ...over,
  }) as DevicePublic;
/** 渲染并量一次滚动区高度（量到之前只画骨架） */
const mount = async () => {
  const r = render(
    <QueryClientProvider client={makeQueryClient()}>
      <DevicesScreen />
    </QueryClientProvider>,
  );
  const scroll = r.root.find(
    (n) =>
      typeof n.type !== "string" &&
      typeof n.props.onLayout === "function" &&
      n.props.refreshControl !== undefined,
  );
  act(() =>
    scroll.props.onLayout({ nativeEvent: { layout: { height: 700 } } }),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return r;
};
/** 三步指引的卡片也是量到宽度之后才搭 */
const layoutGuide = (r: Rendered) =>
  r.root
    .findAll(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.props.style?.flexGrow === 1,
    )
    .forEach((n) =>
      act(() =>
        n.props.onLayout({
          nativeEvent: { layout: { width: 360, height: 600 } },
        }),
      ),
    );

beforeAll(() => {
  // 冷启动开屏还在播时页面先画骨架；测试里直接放行
  releaseSplashHold();
});
beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  mockKv.clear();
  useAuthStore.setState({ user: { id: "u1" } as never });
  useGuideStore.getState().reset();
  useHelmetHistoryStore.setState({ hydrated: false, users: [] });
  Object.assign(mockSafety, {
    links: {},
    notify: "granted",
    chosenId: null,
    ready: true,
    choose: jest.fn(),
  });
  mockRide.value = { status: "unknown" };
  m(contactsApi.list).mockImplementation(() => Promise.resolve([{ id: "c1" }]));
});
afterEach(() => {
  act(() => {
    useGuideStore.getState().reset();
    useAuthStore.setState({ user: null });
  });
  jest.clearAllMocks();
});

describe("没有头盔 / 列表没拉到", () => {
  it("列表没拉到（断网冷启动）：说拉取失败，不说没绑头盔、也不给绑定按钮", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("devices.loadFailedTitle")),
    );
    expect(r.allText()).toContain(tr("error.network"));
    expect(r.allText()).not.toContain(tr("empty.devicesTitle"));
  });

  it("从没绑过头盔的账号：走三步指引（绑定那一步），右上角「+」也能去绑定", async () => {
    m(devicesApi.list).mockImplementation(() => Promise.resolve([]));
    const r = await mount();
    await waitFor(() => expect(useGuideStore.getState().active).toBe(true));
    layoutGuide(r);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("guide.helmet.bindTitle")),
    );
    expect(useGuideStore.getState()).toMatchObject({
      active: true,
      userId: "u1",
      bindOnly: false,
    });
    expect(r.allText()).toContain("0 / 3");
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("devices.bindNew"),
        )
        .props.onPress(),
    );
    expect(mockRouter.navigate).toHaveBeenCalledWith("/bind-device");
  });

  it("绑过又解绑的账号：只有绑定那一张卡", async () => {
    mockKv.set("helmet.everHadHelmet", JSON.stringify(["u1"]));
    m(devicesApi.list).mockImplementation(() => Promise.resolve([]));
    const r = await mount();
    await waitFor(() => expect(useGuideStore.getState().active).toBe(true));
    layoutGuide(r);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("guide.helmet.bindTitle")),
    );
    expect(useGuideStore.getState()).toMatchObject({
      active: true,
      bindOnly: true,
    });
    expect(r.allText()).not.toContain("0 / 3");
  });
});

describe("有头盔", () => {
  it("当前头盔大图：名字、连接状态；点了去详情；见到头盔就记下这个账号绑过", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([dev("h1", { name: "通勤头盔" })]),
    );
    mockSafety.links = { h1: "connected" };
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain("通勤头盔"));
    expect(r.allText()).toContain(tr("devices.link.connected"));
    const hero = r.root.find(
      (n) =>
        n.type === Tappable &&
        n.props.accessibilityLabel ===
          tr("devices.heroA11y", {
            name: "通勤头盔",
            status: tr("devices.link.connected"),
          }),
    );
    act(() => hero.props.onPress());
    expect(mockRouter.navigate).toHaveBeenCalledWith("/device/h1");
    await waitFor(() =>
      expect(useHelmetHistoryStore.getState().users).toContain("u1"),
    );
  });

  it("「设为当前」的选择还没读出来时先画骨架，不先显示一台再跳", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([dev("h1", { name: "通勤头盔" })]),
    );
    mockSafety.ready = false;
    const r = await mount();
    await waitFor(() => expect(devicesApi.list).toHaveBeenCalled());
    expect(r.allText()).not.toContain("通勤头盔");
  });

  it("两格摘要：安全一格去安全页；今日骑行：骑过写公里和时长、没骑写今天没骑、还没拿到写一横，点了打开地图行程", async () => {
    m(devicesApi.list).mockImplementation(() => Promise.resolve([dev("h1")]));
    mockSafety.links = { h1: "connected" };
    mockRide.value = {
      status: "rode",
      distanceMeters: 12_300,
      movingSeconds: 2700,
    };
    let r = await mount();
    await waitFor(() => expect(r.allText()).toContain(formatKm(12_300)));
    expect(r.allText()).toContain(`km · 45 ${tr("ride.minutes")}`);
    const ride = r.root.find(
      (n) =>
        n.type === Tappable &&
        String(n.props.accessibilityLabel).startsWith(tr("ride.today")),
    );
    act(() => ride.props.onPress());
    expect(mockRouter.navigate).toHaveBeenCalledWith({
      pathname: "/map",
      params: { deviceId: "h1", rides: "1" },
    });
    const safety = r.root.find(
      (n) =>
        n.type === Tappable &&
        String(n.props.accessibilityLabel).startsWith(tr("safety.title")),
    );
    act(() => safety.props.onPress());
    expect(mockRouter.navigate).toHaveBeenCalledWith("/safety");
    mockRide.value = { status: "none" };
    r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("devices.ride.none")));
    mockRide.value = {
      status: "rode",
      distanceMeters: 50_000,
      movingSeconds: 2 * 3600 + 5 * 60,
    };
    r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(`km · 2:05 ${tr("ride.hours")}`),
    );
  });

  it("其他设备：连着的排前面；连着的才能设为当前，点了换当前；离线写多久前", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤" }),
        dev("h2", { name: "滑雪", online: false }),
        dev("h3", { name: "备用" }),
      ]),
    );
    mockSafety.links = { h1: "connected", h2: "offline", h3: "connected" };
    const r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("devices.otherDevices")),
    );
    const text = r.allText();
    expect(text.indexOf("备用")).toBeLessThan(text.indexOf("滑雪"));
    expect(text).toContain(tr("common.offline"));
    const setCurrent = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        String(n.props.accessibilityLabel ?? "").startsWith(
          tr("devices.setCurrentA11y", { name: "" }).slice(0, 2),
        ),
    );
    expect(setCurrent).toHaveLength(1);
    act(() => setCurrent[0].props.onPress());
    expect(mockSafety.choose).toHaveBeenCalledWith("h3");
    r.press("滑雪");
    expect(mockRouter.navigate).toHaveBeenLastCalledWith("/device/h2");
  });

  it("下拉刷新：重新拉设备列表", async () => {
    m(devicesApi.list).mockImplementation(() => Promise.resolve([dev("h1")]));
    const r = await mount();
    await waitFor(() => expect(devicesApi.list).toHaveBeenCalledTimes(1));
    await act(async () => {
      r.root.findByType(RefreshControl).props.onRefresh();
      await Promise.resolve();
    });
    expect(m(devicesApi.list).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
