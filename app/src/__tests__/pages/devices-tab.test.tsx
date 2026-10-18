// 设备标签页（首页）：列表没拉到 ≠ 没绑头盔、从没绑过的账号走三步指引、绑过又解绑的只给绑定那一张、
// 「绑过没有」读出来之前先画骨架、指引进行中绑上了头盔接着走、指引收尾交给衔接动画、
// 当前头盔大图（名字 / 连接状态 / 去详情 / 电量环和光晕的颜色 / 光晕铺多大）、两格摘要（安全 / 今日骑行）、
// 其他设备（连着的才能设为当前、电量分档上色、充电中）、下拉刷新。
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
import { act, type ReactTestInstance } from "react-test-renderer";
import { mockRouter, routerState } from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  makeQueryClient,
  render,
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { BatteryArc } from "@/components/battery-arc";
import { DeviceGuide } from "@/components/device-guide";
import { Skeleton } from "@/components/skeleton";
import { releaseSplashHold } from "@/components/splash/bus";
import { prepareGuideHandover } from "@/components/splash/guide-handover";
import { Tappable } from "@/components/tappable";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { formatKm } from "@/i18n/format";
import { withAlpha } from "@/services/color";
import { heroRingSize } from "@/services/device-home";
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
/** 读盘慢：设了 until 时，读要等它放行 */
const mockKvHold = { until: null as Promise<void> | null };
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => {
    if (mockKvHold.until) await mockKvHold.until;
    return mockKv.get(k) ?? null;
  },
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
const mount = async (qc = makeQueryClient()) => {
  const r = render(
    <QueryClientProvider client={qc}>
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

/** 宿主 Text 的全部文字（嵌套的拼在一起） */
const textOf = (n: ReactTestInstance | string): string =>
  typeof n === "string"
    ? n
    : n.children.map((c) => textOf(c as ReactTestInstance | string)).join("");
/** 文字正好是 s 的那个 Text 此刻的字色 */
const colorOfText = (r: Rendered, s: string) =>
  flat(r.root.find((n) => isHost(n, "Text") && textOf(n) === s).props.style)
    .color;
/** 名字为 name 的图标各自的颜色 */
const iconColors = (r: Rendered, name: string) =>
  r.root
    .findAll((n) => isHost(n, "Ionicons") && n.props.name === name)
    .map((n) => n.props.color);
/** 大图上的径向渐变：光晕三层写 46%，头盔背后的柔光底写 62% */
const gradients = (r: Rendered, mark: " 46%" | " 62%") =>
  r.root
    .findAll(
      (n) =>
        typeof n.type === "string" &&
        String(flat(n.props.style).experimental_backgroundImage ?? "").includes(
          mark,
        ),
    )
    .map((n) => flat(n.props.style));
/** 大图的三层光晕里亮着的那几层的颜色 */
const glowsOn = (r: Rendered) =>
  r.root
    .findAll(
      (n) =>
        typeof n.type === "function" &&
        n.props.breathe !== undefined &&
        n.props.on === true,
    )
    .map((n) => n.props.color);
/** 当前头盔大图（整块可点，读屏读「名字，状态，查看详情」） */
const heroes = (r: Rendered) => {
  const tail = tr("devices.heroA11y", { name: "", status: "" }).slice(2);
  return r.root.findAll(
    (n) =>
      n.type === Tappable &&
      String(n.props.accessibilityLabel ?? "").endsWith(tail),
  );
};

beforeAll(() => {
  // 冷启动开屏还在播时页面先画骨架；测试里直接放行
  releaseSplashHold();
});
beforeEach(() => {
  routerState.focused = true;
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

  it("手机蓝牙关着、别的手机正带着在线的那顶：写「未连接」，不写「离线 · 刚刚」（10-16 iPhone）", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤" }),
        dev("h2", { name: "滑雪" }),
      ]),
    );
    mockSafety.links = { h1: "bluetoothOff", h2: "bluetoothOff" };
    const r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("devices.otherDevices")),
    );
    expect(r.allText()).not.toContain(tr("common.offline"));
    expect(r.allText()).toContain(tr("devices.link.notConnected"));
  });

  it("回到设备页时重拉一次设备列表（不等 30 秒轮询）；2 秒内刚拉过不拉（10-16 iPhone 指引卡在第一件）", async () => {
    m(devicesApi.list).mockImplementation(() => Promise.resolve([dev("h1")]));
    const qc = makeQueryClient();
    const r = await mount(qc);
    await waitFor(() => expect(devicesApi.list).toHaveBeenCalledTimes(1));
    const el = () => (
      <QueryClientProvider client={qc}>
        <DevicesScreen />
      </QueryClientProvider>
    );
    // 刚拉过：切走再回来不拉
    routerState.focused = false;
    r.rerender(el());
    routerState.focused = true;
    r.rerender(el());
    await act(async () => {
      await Promise.resolve();
    });
    expect(devicesApi.list).toHaveBeenCalledTimes(1);
    // 上次拉取已是 5 秒前（哪怕还在新鲜期里，比如地图页刚拉过的那份）：回来就拉
    act(() => {
      qc.getQueryCache()
        .find({ queryKey: ["devices"] })!
        .setState({ dataUpdatedAt: Date.now() - 5_000 });
    });
    routerState.focused = false;
    r.rerender(el());
    routerState.focused = true;
    r.rerender(el());
    await waitFor(() => expect(devicesApi.list).toHaveBeenCalledTimes(2));
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

describe("没有头盔时走哪一种、指引和页面的衔接", () => {
  it("「绑过没有」的记录还没读出来（读盘慢）：先画骨架，不开指引；读出来了才开", async () => {
    let release!: () => void;
    mockKvHold.until = new Promise<void>((res) => {
      release = res;
    });
    try {
      m(devicesApi.list).mockImplementation(() => Promise.resolve([]));
      const qc = makeQueryClient();
      const r = await mount(qc);
      await waitFor(() => expect(qc.getQueryData(["devices"])).toEqual([]));
      // 查询结果要再过一个宏任务才通知到页面：等它真的画上「列表是空的」那一帧
      await act(async () => {
        await new Promise((res) => setTimeout(res, 10));
      });
      expect(useHelmetHistoryStore.getState().hydrated).toBe(false);
      expect(r.root.findAllByType(Skeleton).length).toBeGreaterThan(0);
      expect(r.root.findAllByType(DeviceGuide)).toHaveLength(0);
      expect(useGuideStore.getState().active).toBe(false);
      await act(async () => {
        release();
      });
      await waitFor(() => expect(useGuideStore.getState().active).toBe(true));
      expect(r.root.findAllByType(DeviceGuide)).toHaveLength(1);
    } finally {
      mockKvHold.until = null;
    }
  });

  it("账号信息已清空（退出登录那一下、页面还没卸下）：不给空账号开指引，也不把头盔记到空账号名下", async () => {
    act(() => useAuthStore.setState({ user: null }));
    m(devicesApi.list).mockImplementation(() => Promise.resolve([]));
    const qc = makeQueryClient();
    await mount(qc);
    await waitFor(() => expect(qc.getQueryData(["devices"])).toEqual([]));
    await waitFor(() =>
      expect(useHelmetHistoryStore.getState().hydrated).toBe(true),
    );
    expect(useGuideStore.getState().active).toBe(false);
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([dev("h1", { name: "通勤头盔" })]),
    );
    const r = await mount();
    await waitFor(() => expect(heroes(r)).toHaveLength(1));
    expect(useHelmetHistoryStore.getState().users).toEqual([]);
  });

  it("指引进行中、头盔在别的手机上绑上了：指引接着走（这一件写已连上），不直接变成设备页", async () => {
    useGuideStore.getState().begin("u1");
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([dev("h1", { name: "通勤头盔" })]),
    );
    mockSafety.links = { h1: "connected" };
    const r = await mount();
    await waitFor(() =>
      expect(r.root.findAllByType(DeviceGuide)).toHaveLength(1),
    );
    layoutGuide(r);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("guide.helmet.linkedTitle")),
    );
    expect(r.root.findByType(DeviceGuide).props).toMatchObject({
      helmet: { deviceId: "h1" },
      link: "connected",
      bindOnly: false,
    });
    expect(heroes(r)).toHaveLength(0);
  });

  it("指引收尾：量到了卡片和徽标的位置就先备好衔接动画、再变成设备页；量不到直接变过去，不播衔接", async () => {
    useGuideStore.getState().begin("u1");
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([dev("h1", { name: "通勤头盔" })]),
    );
    mockSafety.links = { h1: "connected" };
    const r = await mount();
    await waitFor(() =>
      expect(r.root.findAllByType(DeviceGuide)).toHaveLength(1),
    );
    const from = {
      card: { x: 16, y: 200, w: 358, h: 252 },
      emblem: { x: 36, y: 220, w: 36, h: 36 },
    };
    act(() => r.root.findByType(DeviceGuide).props.onFinished(from));
    expect(prepareGuideHandover).toHaveBeenCalledWith(from);
    expect(useGuideStore.getState()).toMatchObject({
      active: false,
      handover: from,
      armed: true,
    });
    await waitFor(() => expect(heroes(r)).toHaveLength(1));
    // 衔接播完了（衔接层自己收掉）
    act(() => useGuideStore.getState().endHandover());

    // 再走一遍指引，这次量不到位置
    act(() => useGuideStore.getState().begin("u1"));
    await waitFor(() =>
      expect(r.root.findAllByType(DeviceGuide)).toHaveLength(1),
    );
    act(() => r.root.findByType(DeviceGuide).props.onFinished(null));
    expect(prepareGuideHandover).toHaveBeenCalledTimes(1);
    expect(useGuideStore.getState()).toMatchObject({
      active: false,
      handover: null,
      armed: false,
    });
    await waitFor(() => expect(heroes(r)).toHaveLength(1));
  });
});

describe("大图与其他设备的颜色、电量", () => {
  it("连着时电量 ≤20% 电量环和光晕变黄、≤10% 变红，电量数字跟着变色", async () => {
    mockSafety.links = { h1: "connected" };
    for (const [battery, color] of [
      [15, Colors.dark.warning],
      [8, Colors.dark.danger],
    ] as const) {
      m(devicesApi.list).mockImplementation(() =>
        Promise.resolve([dev("h1", { battery })]),
      );
      const r = await mount();
      await waitFor(() =>
        expect(r.root.findAllByType(BatteryArc)).toHaveLength(1),
      );
      expect(r.root.findByType(BatteryArc).props.color).toBe(color);
      expect(glowsOn(r)).toEqual([color]);
      expect(colorOfText(r, `${battery}%`)).toBe(color);
    }
  });

  it("电量还没上报（null）：大图和其他设备那一行都写「—」，不带 %", async () => {
    mockRide.value = { status: "none" };
    mockSafety.links = { h1: "connected", h2: "connected" };
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { battery: null }),
        dev("h2", { name: "备用", battery: null }),
      ]),
    );
    const r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("devices.otherDevices")),
    );
    expect(r.texts().filter((x) => x === "—")).toHaveLength(2);
    expect(r.texts().some((x) => /^\d+%$/.test(x))).toBe(false);
  });

  it("头盔身份不符：安全那一格写身份不符、整格标红（红色只给这一种）", async () => {
    mockSafety.links = { h1: "mismatch" };
    m(devicesApi.list).mockImplementation(() => Promise.resolve([dev("h1")]));
    const r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("safety.link.mismatch")),
    );
    expect(iconColors(r, "alert-circle-outline")).toEqual([Colors.dark.danger]);
    expect(iconColors(r, "shield-outline")).toEqual([Colors.dark.danger]);
  });

  it("其他设备的电量：≤10% 写红色、≤20% 写黄色；充电中数字前加一道闪电，读屏读「充电中」", async () => {
    mockSafety.links = { h1: "connected", h2: "connected", h3: "connected" };
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤" }),
        dev("h2", { name: "滑雪", battery: 8, charging: true }),
        dev("h3", { name: "备用", battery: 18 }),
      ]),
    );
    const r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("devices.otherDevices")),
    );
    expect(colorOfText(r, "8%")).toBe(Colors.dark.danger);
    expect(colorOfText(r, "18%")).toBe(Colors.dark.warning);
    expect(iconColors(r, "flash")).toEqual([Colors.dark.danger]);
    expect(
      r.root.findAll(
        (n) =>
          typeof n.type === "string" &&
          n.props.accessibilityLabel === `${tr("devices.charging")} 8%`,
      ),
    ).toHaveLength(1);
  });

  it("疑似缺陷：充电中但电量没上报时，读屏读成「充电中 —%」（多了个 %，屏幕上只写「—」）", async () => {
    mockSafety.links = { h1: "connected", h2: "connected" };
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤" }),
        dev("h2", { name: "滑雪", battery: null, charging: true }),
      ]),
    );
    const r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("devices.otherDevices")),
    );
    const labels = r.root
      .findAll(
        (n) =>
          typeof n.type === "string" &&
          String(n.props.accessibilityLabel ?? "").startsWith(
            tr("devices.charging"),
          ),
      )
      .map((n) => n.props.accessibilityLabel);
    expect(labels).toEqual([`${tr("devices.charging")} —%`]);
  });

  it("大图的光晕：上方留白够时铺到大图边长的 1.05 倍；不够时缩到刚好碰到滚动区上沿（不被齐齐裁出一条边）", async () => {
    mockSafety.links = { h1: "connected" };
    m(devicesApi.list).mockImplementation(() => Promise.resolve([dev("h1")]));
    const r = await mount();
    await waitFor(() => expect(gradients(r, " 46%")).toHaveLength(3));
    // 滚动区量到 700、没有其他设备
    const ring = heroRingSize(700, 0);
    // 上方留白还没量到时按 4 算：标题栏 48 + 4 + 半个大图
    expect(gradients(r, " 46%")[0].width).toBe(2 * (48 + 4 + ring / 2));
    const spaceAbove = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        flat(n.props.style).flex === 3,
    );
    act(() =>
      spaceAbove.props.onLayout({ nativeEvent: { layout: { height: 300 } } }),
    );
    expect(gradients(r, " 46%").map((st) => st.width)).toEqual(
      Array(3).fill(2 * ring * 1.05),
    );
  });

  it("浅色模式：头盔背后的柔光底用卡片底色、光晕更浓（浅色底上同样的浓度几乎看不出来）", async () => {
    useThemeStore.setState({ mode: "light" });
    mockSafety.links = { h1: "connected" };
    m(devicesApi.list).mockImplementation(() => Promise.resolve([dev("h1")]));
    const r = await mount();
    await waitFor(() => expect(gradients(r, " 62%")).toHaveLength(1));
    const L = Colors.light;
    expect(gradients(r, " 62%")[0].experimental_backgroundImage).toBe(
      `radial-gradient(50% 50% at 50% 50%, ${L.backgroundElement} 0%, ${withAlpha(L.backgroundElement, 0.7)} 62%, ${withAlpha(L.backgroundElement, 0)} 100%)`,
    );
    expect(
      gradients(r, " 46%").map((st) => st.experimental_backgroundImage),
    ).toContain(
      `radial-gradient(50% 50% at 50% 50%, ${withAlpha(L.success, 0.34)} 0%, ${withAlpha(L.success, 0.17)} 46%, ${withAlpha(L.success, 0)} 100%)`,
    );
  });
});
