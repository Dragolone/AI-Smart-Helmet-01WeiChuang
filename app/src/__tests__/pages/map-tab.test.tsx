// 地图标签页：实时位置（在线 / 离线 / 没位置 / (0,0) 占位）、骑行中屏幕常亮、分享与导航、跟随与回中、
// 地图异常重新加载、多顶头盔切换、行程列表 → 一趟 → 回放、按日期找、Android 返回键一层层退与布局、
// 从设备页 / 安全记录 / 外部链接带参数进来。行程数据的钩子替换成可控的值，地图组件替换成记录命令的替身。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { DevicePublic, LocationPoint, RideSummary } from "@helmet/shared";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  Animated as RNAnimated,
  AppState,
  BackHandler,
  Platform,
  Share,
} from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import {
  mockRouter,
  routerState,
  type RecordedGesture,
} from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  makeQueryClient,
  render,
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { devicesApi } from "@/api/devices";
import { HelmetPicker } from "@/components/map/helmet-picker";
import { openAmapNavigation } from "@/components/map/nav-links";
import { RideCalendar } from "@/components/map/ride-calendar";
import { RideList } from "@/components/map/ride-list";
import { RideReplay } from "@/components/map/ride-replay";
import { Tappable } from "@/components/tappable";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { formatKm, monthTitle } from "@/i18n/format";
import { dayKeyOf } from "@/services/rides";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";
import MapScreen from "@/app/(tabs)/map";

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
jest.mock("react-native-gesture-handler", () =>
  jest
    .requireActual<typeof import("@/__tests__/helpers/native-mocks")>(
      "@/__tests__/helpers/native-mocks",
    )
    .gestureMock(),
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
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(() => Promise.resolve()),
  deactivateKeepAwake: jest.fn(() => Promise.resolve()),
}));
const mockMap = {
  setHelmet: jest.fn(),
  hideHelmet: jest.fn(),
  setTrack: jest.fn(),
  setTrackTip: jest.fn(),
  clearTrack: jest.fn(),
  setCenter: jest.fn(),
  setHelmetOnline: jest.fn(),
  setHelmetReplay: jest.fn(),
  setMarks: jest.fn(),
  reload: jest.fn(),
};
const mockMapProps: { current: Record<string, unknown> } = { current: {} };
jest.mock("@/components/map/amap-view", () => {
  const { createElement: h, useEffect } =
    jest.requireActual<typeof import("react")>("react");
  return {
    AmapView: (
      props: { controllerRef: { current: unknown } } & Record<string, unknown>,
    ) => {
      useEffect(() => {
        props.controllerRef.current = mockMap;
      });
      mockMapProps.current = props;
      return h("AmapView", props);
    },
  };
});
jest.mock("@/components/map/nav-links", () => ({
  openAmapNavigation: jest.fn(() => Promise.resolve()),
}));
const mockWs: ((up: boolean) => void)[] = [];
jest.mock("@/api/realtime", () => ({
  realtimeClient: {
    subscribeState: (l: (up: boolean) => void) => {
      mockWs.push(l);
      l(true);
      return () => undefined;
    },
  },
}));
jest.mock("@/api/devices", () => ({
  devicesApi: { list: jest.fn(), latestLocation: jest.fn() },
}));
const mockRides = {
  /** undefined = 最近的行程还没拉到 */
  recent: [] as RideSummary[] | undefined,
  pages: [] as RideSummary[],
  /** 行程列表第一页没拉到 */
  pagesError: false,
  /** 最后一页说还有更早的（翻到哪个月） */
  pagesNext: null as { year: number; month: number } | null,
  track: [] as LocationPoint[],
  /** 轨迹还在拉 */
  trackLoading: false,
  /** 轨迹接口用全部点算的统计（只知道一个时刻、又不在任何一趟里时用来写小结） */
  trackSummary: null as {
    distanceMeters: number;
    movingSeconds: number;
    maxSpeed: number | null;
    pointCount: number;
    firstAt: string | null;
    lastAt: string | null;
  } | null,
  events: [] as { eventId: string; eventType: string; timestamp: string }[],
  /** 事件接口报的总数（比拿回来的多 = 还有没列出来的）；null = 和拿回来的一样多 */
  eventsTotal: null as number | null,
  trackError: false,
  /** 事件一次都没拉到（data 没有、isError 为 true） */
  eventsError: false,
  /** undefined = 这个月的行程还在拉 */
  month: [] as RideSummary[] | undefined,
  monthError: false,
  at: null as RideSummary | null,
  /** 查「那一刻落在哪一趟」失败了 */
  atError: false,
  /** 还在查「那一刻落在哪一趟」 */
  atLoading: false,
  /** 轨迹拉到过、之后后台刷新失败（data 还在、isError 也是 true） */
  trackRefetchError: false,
};
const mockRefetch = {
  track: jest.fn(),
  events: jest.fn(),
  at: jest.fn(),
  pages: jest.fn(),
  older: jest.fn(),
  month: jest.fn(),
};
jest.mock("@/hooks/use-rides", () => ({
  useRecentRides: () => ({
    data: mockRides.recent,
    isSuccess: mockRides.recent !== undefined,
  }),
  useRidePages: (_d: unknown, _s: unknown, enabled: boolean) => ({
    data:
      enabled && !mockRides.pagesError
        ? { pages: [{ rides: mockRides.pages, next: mockRides.pagesNext }] }
        : undefined,
    isError: enabled && mockRides.pagesError,
    refetch: mockRefetch.pages,
    fetchNextPage: mockRefetch.older,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
  }),
  useRideTrack: (_d: unknown, window: unknown) => ({
    data:
      window && !mockRides.trackError && !mockRides.trackLoading
        ? { points: mockRides.track, summary: mockRides.trackSummary }
        : undefined,
    isError: mockRides.trackError || mockRides.trackRefetchError,
    isPending: !window || mockRides.trackLoading,
    refetch: mockRefetch.track,
  }),
  useRideEvents: (_d: unknown, window: unknown) => ({
    data:
      window && !mockRides.eventsError
        ? {
            items: mockRides.events,
            total: mockRides.eventsTotal ?? mockRides.events.length,
          }
        : undefined,
    isError: mockRides.eventsError,
    refetch: mockRefetch.events,
  }),
  useRideMonth: () => ({
    data: mockRides.monthError ? undefined : mockRides.month,
    isError: mockRides.monthError,
    refetch: mockRefetch.month,
  }),
  useRideAt: (_d: unknown, atMs: number | null) => ({
    data:
      atMs === null || mockRides.atError || mockRides.atLoading
        ? undefined
        : mockRides.at,
    isPending: atMs === null || mockRides.atLoading,
    isError: atMs !== null && mockRides.atError,
    isFetching: atMs !== null && mockRides.atLoading,
    refetch: mockRefetch.at,
  }),
}));
const mockSafety = {
  chosenId: null as string | null,
  links: {} as Record<string, string>,
};
jest.mock("@/hooks/use-safety", () => ({
  useCurrentHelmetChoice: () => ({
    chosenId: mockSafety.chosenId,
    ready: true,
    choose: jest.fn(),
  }),
  useHelmetLinks: () => mockSafety.links,
}));

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const dev = (id: string, over: Partial<DevicePublic> = {}) =>
  ({
    deviceId: id,
    name: null,
    online: true,
    battery: 80,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: new Date().toISOString(),
    ...over,
  }) as DevicePublic;
const loc = (over: Partial<LocationPoint> = {}) =>
  ({
    latitude: 22.5431,
    longitude: 113.9345,
    speed: 0,
    altitude: 30,
    timestamp: new Date().toISOString(),
    ...over,
  }) as LocationPoint;
const ride = (h: number, over: Partial<RideSummary> = {}): RideSummary => ({
  startAt: new Date(2026, 9, 15, h, 0).toISOString(),
  endAt: new Date(2026, 9, 15, h, 30).toISOString(),
  distanceMeters: 6000,
  movingSeconds: 1500,
  maxSpeed: 8,
  ongoing: false,
  ...over,
});
const mount = async (client = makeQueryClient()) => {
  const r = render(
    <QueryClientProvider client={client}>
      <MapScreen />
    </QueryClientProvider>,
  );
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
  return r;
};
const round = (r: Rendered, label: string) =>
  r.root.find(
    (n) => n.type === Tappable && n.props.accessibilityLabel === label,
  );
/** 抽屉里一格数据（名字为 label 的那一格）的值和单位 */
const statOf = (r: Rendered, label: string) =>
  r.root.find(
    (n) =>
      typeof n.type !== "string" &&
      n.props.label === label &&
      "unit" in n.props,
  ).props as { value: string; unit: string };
const replayOf = (r: Rendered) => r.root.findByType(RideReplay).props;
/** 重渲染用：每次给新元素，同一个元素对象 React 会直接跳过 */
const screenOf = (client: QueryClient) => (
  <QueryClientProvider client={client}>
    <MapScreen />
  </QueryClientProvider>
);
/** 打开行程列表，点第一趟 */
const openFirstRide = (r: Rendered) => {
  r.press(tr("map.rides.title"));
  const row = r.root.findAll(
    (n) =>
      n.type === Tappable &&
      String(n.props.accessibilityLabel ?? "").includes("公里"),
  )[0];
  act(() => {
    row.props.onPress();
  });
};
/** 上个月 10 号 9:00 开始的半小时 */
const lastMonthRide = () => {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth() - 1, 10, 9);
  return ride(9, {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
  });
};
/** 上个月（月历的写法：月份从 0 起） */
const lastMonth = () => {
  const d = new Date();
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return { year: first.getFullYear(), month: first.getMonth() };
};
let backHandler: (() => boolean) | null;
let backSpy: ReturnType<typeof jest.spyOn>;
let appSpy: ReturnType<typeof jest.spyOn>;
let appListener: ((s: string) => void) | null;
let appStateDesc: PropertyDescriptor | undefined;
let springSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  useAuthStore.setState({ user: { id: "u1", avatarUrl: null } as never });
  routerState.params = {};
  routerState.focused = true;
  Object.assign(mockRides, {
    recent: [],
    pages: [],
    pagesError: false,
    pagesNext: null,
    track: [],
    trackLoading: false,
    trackSummary: null,
    events: [],
    eventsTotal: null,
    trackError: false,
    eventsError: false,
    month: [],
    monthError: false,
    at: null,
    atError: false,
    atLoading: false,
    trackRefetchError: false,
  });
  Object.assign(mockSafety, { chosenId: null, links: { h1: "connected" } });
  m(devicesApi.list).mockImplementation(() =>
    Promise.resolve([dev("h1", { name: "通勤" })]),
  );
  m(devicesApi.latestLocation).mockImplementation(() =>
    Promise.resolve({ location: loc() }),
  );
  mockWs.length = 0;
  backHandler = null;
  backSpy = jest
    .spyOn(BackHandler, "addEventListener")
    .mockImplementation((_e, h) => {
      backHandler = h as () => boolean;
      return { remove: () => (backHandler = null) } as never;
    });
  // 底部卡进场的 RN Animated 弹簧：start 时直接到位（不依赖 jest 里 Animated 的计时）
  springSpy = jest.spyOn(RNAnimated, "spring").mockImplementation(
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
  // jest 里 AppState.currentState 不是 active：默认按 App 在前台来（地图页看得见时才干活）
  appStateDesc = Object.getOwnPropertyDescriptor(AppState, "currentState");
  Object.defineProperty(AppState, "currentState", {
    value: "active",
    configurable: true,
  });
  appSpy = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_e, l) => {
      appListener = l as (s: string) => void;
      return { remove: jest.fn() } as never;
    });
});
afterEach(() => {
  backSpy.mockRestore();
  appSpy.mockRestore();
  if (appStateDesc)
    Object.defineProperty(AppState, "currentState", appStateDesc);
  else delete (AppState as { currentState?: unknown }).currentState;
  springSpy.mockRestore();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("地图页看不见时不干活", () => {
  const KEY = ["device-location", "h1"];
  const point = (latitude: number) => loc({ latitude });
  const hide = (r: Rendered, qc: QueryClient) => {
    routerState.focused = false;
    r.rerender(screenOf(qc));
  };
  const show = (r: Rendered, qc: QueryClient) => {
    routerState.focused = true;
    r.rerender(screenOf(qc));
  };
  /** 实时通道写一个新定位点（use-realtime 就是这样写缓存的） */
  const wsPoint = (qc: QueryClient, latitude: number) =>
    act(() => {
      qc.setQueryData(KEY, point(latitude));
    });
  /** 最近一次把头盔放在了哪个纬度 */
  const lastHelmetLat = () =>
    (m(mockMap.setHelmet).mock.calls.at(-1)![0] as { latitude: number })
      .latitude;
  const mountVisible = async () => {
    const qc = makeQueryClient();
    const r = await mount(qc);
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalled());
    return { qc, r };
  };

  it("切到别的标签：定位不注入地图、不重渲染；缓存照写（换头盔提醒读这一份）", async () => {
    mockRides.recent = [ride(9, { ongoing: true })];
    mockRides.track = [loc({ latitude: 22.5 }), loc({ latitude: 22.51 })];
    const { qc, r } = await mountVisible();
    hide(r, qc);
    jest.clearAllMocks();
    const propsBefore = mockMapProps.current;
    wsPoint(qc, 23.1);
    wsPoint(qc, 23.2);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(mockMap.setHelmet).not.toHaveBeenCalled();
    expect(mockMap.setTrackTip).not.toHaveBeenCalled();
    expect(mockMap.setTrack).not.toHaveBeenCalled();
    // AmapView 的 onReady 闭包跟着位置变：地图页重渲染过的话，这份 props 就换了
    expect(mockMapProps.current).toBe(propsBefore);
    expect(qc.getQueryData<LocationPoint>(KEY)?.latitude).toBe(23.2);
    // 别的原因让这一页重渲染了（设备列表刷新之类）：渲染拿到了新的点和新的线，也不往地图推
    mockRides.track = [loc({ latitude: 22.5 }), loc({ latitude: 22.52 })];
    r.rerender(screenOf(qc));
    expect(mockMapProps.current).not.toBe(propsBefore);
    expect(mockMap.setHelmet).not.toHaveBeenCalled();
    expect(mockMap.setTrackTip).not.toHaveBeenCalled();
    expect(mockMap.setTrack).not.toHaveBeenCalled();
  });

  it("切回来：把隐藏期间最新的点补上（头盔、线头、线），不用等下一个定位", async () => {
    mockRides.recent = [ride(9, { ongoing: true })];
    mockRides.track = [loc({ latitude: 22.5 }), loc({ latitude: 22.51 })];
    const { qc, r } = await mountVisible();
    hide(r, qc);
    wsPoint(qc, 23.1);
    wsPoint(qc, 23.2);
    jest.clearAllMocks();
    show(r, qc);
    expect(mockMap.setHelmet).toHaveBeenCalledTimes(1);
    expect(mockMap.setHelmet).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: expect.any(Number) }),
      { follow: true, jump: true },
    );
    expect(lastHelmetLat()).toBeCloseTo(23.2, 1);
    expect(mockMap.setTrackTip).toHaveBeenCalledTimes(1);
    expect(mockMap.setTrack).toHaveBeenCalledTimes(1);
    // 回到可见后新的点照常推
    jest.clearAllMocks();
    wsPoint(qc, 23.3);
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalledTimes(1));
    expect(lastHelmetLat()).toBeCloseTo(23.3, 1);
  });

  it("一直没打开过地图页：第一个点放上地图（打开时位置已就位），后面的点不再推", async () => {
    routerState.focused = false;
    const qc = makeQueryClient();
    await mount(qc);
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalledTimes(1));
    expect(mockMap.setHelmet).toHaveBeenCalledWith(expect.any(Object), {
      follow: true,
    });
    const propsBefore = mockMapProps.current;
    jest.clearAllMocks();
    wsPoint(qc, 23.1);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(mockMap.setHelmet).not.toHaveBeenCalled();
    expect(mockMapProps.current).toBe(propsBefore);
  });

  it("隐藏时第一个点是后来才到的（接口还没回、WS 先推）：一到就放上地图", async () => {
    routerState.focused = false;
    m(devicesApi.latestLocation).mockImplementation(() =>
      Promise.resolve({ location: null }),
    );
    const qc = makeQueryClient();
    await mount(qc);
    await waitFor(() => expect(mockMap.hideHelmet).toHaveBeenCalled());
    expect(mockMap.setHelmet).not.toHaveBeenCalled();
    wsPoint(qc, 23.1);
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalledTimes(1));
    expect(lastHelmetLat()).toBeCloseTo(23.1, 1);
    wsPoint(qc, 23.2);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(mockMap.setHelmet).toHaveBeenCalledTimes(1);
  });

  it("切回来那一次镜头直接到位，只这一次；之后的点照旧平滑跟随", async () => {
    const { qc, r } = await mountVisible();
    hide(r, qc);
    wsPoint(qc, 30.1);
    jest.clearAllMocks();
    show(r, qc);
    expect(mockMap.setHelmet).toHaveBeenCalledTimes(1);
    expect(m(mockMap.setHelmet).mock.calls[0][1]).toEqual({
      follow: true,
      jump: true,
    });
    jest.clearAllMocks();
    wsPoint(qc, 30.2);
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalledTimes(1));
    expect(m(mockMap.setHelmet).mock.calls[0][1]).toEqual({ follow: true });
  });

  it("从没打开过地图页、第一次打开：同样直接到位（第一个点之后骑了很远）", async () => {
    routerState.focused = false;
    const qc = makeQueryClient();
    const r = await mount(qc);
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalledTimes(1));
    // 隐藏时放的第一个点不用 jump：页内第一次跟随本来就直接到位
    expect(m(mockMap.setHelmet).mock.calls[0][1]).toEqual({ follow: true });
    wsPoint(qc, 30.1);
    jest.clearAllMocks();
    show(r, qc);
    expect(mockMap.setHelmet).toHaveBeenCalledTimes(1);
    expect(lastHelmetLat()).toBeCloseTo(30.1, 1);
    expect(m(mockMap.setHelmet).mock.calls[0][1]).toEqual({
      follow: true,
      jump: true,
    });
  });

  it("锁屏回前台那一次也直接到位", async () => {
    const { qc } = await mountVisible();
    act(() => appListener!("background"));
    wsPoint(qc, 30.1);
    jest.clearAllMocks();
    act(() => appListener!("active"));
    expect(m(mockMap.setHelmet).mock.calls.at(-1)![1]).toEqual({
      follow: true,
      jump: true,
    });
  });

  it("用户拖开过地图（不跟随）：切回来只挪头盔，镜头不跟", async () => {
    const { qc, r } = await mountVisible();
    act(() => {
      (mockMapProps.current.onUserPan as () => void)();
    });
    hide(r, qc);
    wsPoint(qc, 30.1);
    jest.clearAllMocks();
    show(r, qc);
    expect(m(mockMap.setHelmet).mock.calls.at(-1)![1]).toMatchObject({
      follow: false,
    });
  });

  it("停在地图页锁屏：同样不推不重渲染；回到前台补上最新的点", async () => {
    const { qc } = await mountVisible();
    act(() => appListener!("background"));
    jest.clearAllMocks();
    const propsBefore = mockMapProps.current;
    wsPoint(qc, 23.1);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(mockMap.setHelmet).not.toHaveBeenCalled();
    expect(mockMapProps.current).toBe(propsBefore);
    act(() => appListener!("active"));
    expect(mockMap.setHelmet).toHaveBeenCalledTimes(1);
    expect(lastHelmetLat()).toBeCloseTo(23.1, 1);
  });

  it("隐藏时不轮询位置，切回来补拉一次、恢复轮询", async () => {
    const { qc, r } = await mountVisible();
    const observer = () =>
      qc.getQueryCache().find({ queryKey: KEY })!.observers[0];
    expect(observer().options.refetchInterval).toBe(30_000);
    hide(r, qc);
    // setOptions 在 effect 里：hide 的 rerender 已经包在 act 里
    expect(observer().options.refetchInterval).toBe(false);
    m(devicesApi.latestLocation).mockClear();
    // 隐藏期间最后一个点是 5 秒前（超过「2 秒内刚拉过」的间隔）
    act(() => {
      qc.setQueryData(KEY, point(23.1), { updatedAt: Date.now() - 5000 });
    });
    show(r, qc);
    expect(observer().options.refetchInterval).toBe(30_000);
    await waitFor(() =>
      expect(devicesApi.latestLocation).toHaveBeenCalledTimes(1),
    );
  });

  it("隐藏时、锁屏时 10 秒时钟都停，回来再走", async () => {
    const setSpy = jest.spyOn(global, "setInterval");
    const clearSpy = jest.spyOn(global, "clearInterval");
    const clocks = () =>
      setSpy.mock.calls.filter((c) => c[1] === 10_000).length;
    const { qc, r } = await mountVisible();
    expect(clocks()).toBe(1);

    clearSpy.mockClear();
    hide(r, qc);
    expect(clearSpy).toHaveBeenCalled();
    setSpy.mockClear();
    show(r, qc);
    expect(clocks()).toBe(1);

    clearSpy.mockClear();
    act(() => appListener!("background"));
    expect(clearSpy).toHaveBeenCalled();
    setSpy.mockClear();
    act(() => appListener!("active"));
    expect(clocks()).toBe(1);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});

describe("没有头盔", () => {
  it("拉到了、一顶都没有：引导去绑定", async () => {
    m(devicesApi.list).mockImplementation(() => Promise.resolve([]));
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.emptyTitle")));
    r.press(tr("map.bindNew"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/bind-device");
  });
});

describe("实时位置", () => {
  it("在线：药丸写名字、位置更新时间、静止；头盔跟随镜头；分享发高德链接；侧边导航按钮去高德", async () => {
    const share = jest
      .spyOn(Share, "share")
      .mockImplementation(() => Promise.resolve({ action: "sharedAction" }));
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.still")));
    expect(r.texts()).toContain("通勤");
    expect(r.allText()).toContain(
      tr("map.updatedAgo", { ago: "" }).slice(0, 4),
    );
    expect(mockMap.setHelmet).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: expect.any(Number) }),
      { follow: true },
    );
    expect(mockMap.setHelmetOnline).toHaveBeenCalledWith(true);
    r.press(tr("map.share"));
    await act(async () => undefined);
    const msg = (share.mock.calls[0][0] as { message: string }).message;
    expect(msg).toContain("https://uri.amap.com/marker?position=");
    expect(msg).toContain(encodeURIComponent("通勤"));
    act(() => {
      round(r, tr("map.navigate")).props.onPress();
    });
    expect(openAmapNavigation).toHaveBeenCalledWith(
      expect.objectContaining({ longitude: expect.any(Number) }),
      "通勤",
    );
    share.mockRestore();
  });

  it("用户拖了地图：退出跟随；点回中按钮回到头盔并重新跟随", async () => {
    const r = await mount();
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalled());
    act(() => {
      (mockMapProps.current.onUserPan as () => void)();
    });
    expect(round(r, tr("map.followBack"))).toBeTruthy();
    act(() => {
      round(r, tr("map.followBack")).props.onPress();
    });
    expect(mockMap.setCenter).toHaveBeenCalledWith(expect.any(Object), 15);
    expect(round(r, tr("map.following"))).toBeTruthy();
  });

  it("离线：写上次位置、离线；主按钮变成导航到上次位置；侧边是分享上次位置", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([dev("h1", { name: "通勤", online: false })]),
    );
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("common.offline")));
    expect(r.allText()).toContain(
      tr("map.lastPosition", { ago: "" }).slice(0, 4),
    );
    expect(mockMap.setHelmetOnline).toHaveBeenCalledWith(false);
    r.press(tr("map.navigateLast"));
    expect(openAmapNavigation).toHaveBeenCalled();
    expect(round(r, tr("map.shareLast"))).toBeTruthy();
  });

  it("还没有位置 / (0,0) 占位：写等待位置，导航分享回中都不可点，不画头盔", async () => {
    m(devicesApi.latestLocation).mockImplementation(() =>
      Promise.resolve({ location: loc({ latitude: 0, longitude: 0 }) }),
    );
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.waiting")));
    expect(round(r, tr("map.navigate")).props.disabled).toBe(true);
    expect(round(r, tr("map.following")).props.disabled).toBe(true);
    expect(mockMap.setHelmet).not.toHaveBeenCalled();
  });

  it("骑行中（有一趟还没结束）：写骑行中、屏幕常亮，离开页面时放掉；实时那条线接在头盔后面", async () => {
    mockRides.recent = [ride(10, { ongoing: true })];
    mockRides.track = [loc({ latitude: 22.54 }), loc({ latitude: 22.541 })];
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.riding")));
    expect(activateKeepAwakeAsync).toHaveBeenCalledWith("map-riding");
    expect(mockMap.setTrack).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(Object)]),
      { fit: false },
    );
    // 整条线只有服务端的点；头盔此刻的位置作为线头单独接上
    expect(m(mockMap.setTrack).mock.calls.at(-1)![0]).toHaveLength(2);
    expect(m(mockMap.setTrackTip).mock.calls.at(-1)![0]).toEqual(
      expect.objectContaining({
        latitude: expect.any(Number),
        longitude: expect.any(Number),
      }),
    );
    r.unmount();
    expect(deactivateKeepAwake).toHaveBeenCalledWith("map-riding");
  });

  it("骑行中实时定位来了新点：只发线头，不把整条线重发一遍（长时间开着地图页内存一直涨，10-20）", async () => {
    const qc = makeQueryClient();
    mockRides.recent = [ride(10, { ongoing: true })];
    mockRides.track = [loc({ latitude: 22.54 }), loc({ latitude: 22.541 })];
    const r = await mount(qc);
    await waitFor(() => expect(r.allText()).toContain(tr("map.riding")));
    const tracks = m(mockMap.setTrack).mock.calls.length;
    const tips = m(mockMap.setTrackTip).mock.calls.length;
    for (const lat of [22.6, 22.601, 22.602])
      await act(async () => {
        qc.setQueryData(
          ["device-location", "h1"],
          loc({ latitude: lat, timestamp: new Date().toISOString() }),
        );
        await new Promise((res) => setTimeout(res, 0));
      });
    expect(m(mockMap.setTrack).mock.calls.length).toBe(tracks);
    expect(m(mockMap.setTrackTip).mock.calls.length).toBeGreaterThanOrEqual(
      tips + 3,
    );
    expect(m(mockMap.setTrackTip).mock.calls.at(-1)![0]).toEqual(
      expect.objectContaining({ latitude: expect.any(Number) }),
    );
  });

  it("加速通道断了：药丸下面写重连中", async () => {
    const r = await mount();
    act(() => {
      mockWs.forEach((l) => l(false));
    });
    expect(r.allText()).toContain(tr("map.reconnecting"));
  });

  it("地图异常：横幅说明并可重新加载；回到前台自动重来一次", async () => {
    const r = await mount();
    act(() => {
      (mockMapProps.current.onError as (m: string) => void)("脚本加载失败");
    });
    expect(r.allText()).toContain(tr("map.error", { msg: "脚本加载失败" }));
    act(() => {
      round(r, tr("map.errorRetry")).props.onPress();
    });
    expect(mockMap.reload).toHaveBeenCalledTimes(1);
    act(() => {
      (mockMapProps.current.onError as (m: string) => void)("还是不行");
    });
    act(() => {
      appListener!("active");
    });
    expect(mockMap.reload).toHaveBeenCalledTimes(2);
  });

  it("地图就绪时重推当前状态（WebView 重挂载后 effect 不会重发）", async () => {
    await mount();
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalled());
    jest.clearAllMocks();
    act(() => {
      (mockMapProps.current.onReady as () => void)();
    });
    expect(mockMap.setHelmet).toHaveBeenCalledWith(expect.any(Object), {
      follow: true,
    });
    expect(mockMap.setMarks).toHaveBeenCalledWith([]);
  });

  it("Android：内容区不含标签条，抽屉底边距只留 18、浮层底部不让玻璃标签条（iOS 才让）", async () => {
    const card = (r: Rendered) =>
      r.root.findAll(
        (n) =>
          typeof n.type === "string" &&
          flat(n.props.style).maxHeight !== undefined,
      )[0];
    const overlay = (r: Rendered) =>
      r.root.findAll(
        (n) => typeof n.type === "string" && flat(n.props.style).zIndex === 10,
      )[0];
    const os = Platform.OS;
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    try {
      let r = await mount();
      await waitFor(() => expect(r.allText()).toContain(tr("map.still")));
      expect(flat(card(r).props.style).paddingBottom).toBe(18 + 34);
      expect(flat(overlay(r).props.style).paddingBottom).toBe(34 + 62);
      r.unmount();
      Object.defineProperty(Platform, "OS", {
        value: "android",
        configurable: true,
      });
      r = await mount();
      await waitFor(() => expect(r.allText()).toContain(tr("map.still")));
      expect(flat(card(r).props.style).paddingBottom).toBe(18);
      expect(flat(overlay(r).props.style).paddingBottom).toBeUndefined();
    } finally {
      Object.defineProperty(Platform, "OS", { value: os, configurable: true });
    }
  });

  it("地图异常时只是切到后台：不重载，回到前台才重来", async () => {
    const r = await mount();
    act(() => {
      (mockMapProps.current.onError as (m: string) => void)("脚本加载失败");
    });
    act(() => {
      appListener!("background");
    });
    expect(mockMap.reload).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("map.error", { msg: "脚本加载失败" }));
    act(() => {
      appListener!("active");
    });
    expect(mockMap.reload).toHaveBeenCalledTimes(1);
  });

  describe("地图在隐藏页就失败了（安卓断网冷启动）", () => {
    const fail = (msg = "脚本加载失败") =>
      act(() => {
        (mockMapProps.current.onError as (m: string) => void)(msg);
      });
    const ws = (up: boolean) =>
      act(() => {
        mockWs.forEach((l) => l(up));
      });
    const setFocused = (r: Rendered, qc: QueryClient, focused: boolean) => {
      routerState.focused = focused;
      r.rerender(screenOf(qc));
    };

    it("切到地图页：重来一次，红条收起；还是失败就停在红条，不接着重来", async () => {
      routerState.focused = false;
      const qc = makeQueryClient();
      const r = await mount(qc);
      fail();
      expect(mockMap.reload).not.toHaveBeenCalled();
      setFocused(r, qc, true);
      expect(mockMap.reload).toHaveBeenCalledTimes(1);
      expect(r.allText()).not.toContain(
        tr("map.error", { msg: "脚本加载失败" }),
      );
      fail("还是不行");
      r.rerender(screenOf(qc));
      expect(mockMap.reload).toHaveBeenCalledTimes(1);
      expect(r.allText()).toContain(tr("map.error", { msg: "还是不行" }));
    });

    it("实时通道连上：看不见时不重载（切过来再试）；断开那一下不算", async () => {
      routerState.focused = false;
      const qc = makeQueryClient();
      const r = await mount(qc);
      ws(false);
      fail();
      ws(true);
      ws(false);
      ws(true);
      expect(mockMap.reload).not.toHaveBeenCalled();
      setFocused(r, qc, true);
      expect(mockMap.reload).toHaveBeenCalledTimes(1);
      fail("还是不行");
      ws(false);
      expect(mockMap.reload).toHaveBeenCalledTimes(1);
    });

    it("停在地图页锁屏时实时通道连上：同样不重载", async () => {
      await mount();
      act(() => appListener!("background"));
      ws(false);
      fail();
      ws(true);
      expect(mockMap.reload).not.toHaveBeenCalled();
    });

    describe("实时通道反复断连（隧道、弱网）", () => {
      let now: number;
      let nowSpy: ReturnType<typeof jest.spyOn>;
      const flap = () => {
        ws(false);
        ws(true);
      };
      beforeEach(() => {
        now = Date.now();
        nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
      });
      afterEach(() => nowSpy.mockRestore());

      it("30 秒内连抖只重载一次，过了 30 秒再抖可以再重载", async () => {
        const r = await mount();
        ws(false);
        fail();
        ws(true);
        expect(mockMap.reload).toHaveBeenCalledTimes(1);
        fail("还是不行");
        flap();
        now += 29_999;
        flap();
        expect(mockMap.reload).toHaveBeenCalledTimes(1);
        // 没重载就不收红条：用户看得到，也能自己点
        expect(r.allText()).toContain(tr("map.error", { msg: "还是不行" }));
        now += 1;
        flap();
        expect(mockMap.reload).toHaveBeenCalledTimes(2);
      });

      it("手机时间往回拨：放行，不会被卡住", async () => {
        await mount();
        ws(false);
        fail();
        ws(true);
        expect(mockMap.reload).toHaveBeenCalledTimes(1);
        fail("还是不行");
        now -= 3_600_000;
        flap();
        expect(mockMap.reload).toHaveBeenCalledTimes(2);
      });

      it("点「重新加载」和切过来都不受限，也不占这 30 秒", async () => {
        const qc = makeQueryClient();
        const r = await mount(qc);
        const retry = () =>
          act(() => {
            round(r, tr("map.errorRetry")).props.onPress();
          });
        ws(false);
        fail();
        ws(true);
        expect(mockMap.reload).toHaveBeenCalledTimes(1);
        // 刚因为通道连上重载过：人点按钮、切过来，照样马上试
        fail("还是不行");
        now += 20_000;
        retry();
        expect(mockMap.reload).toHaveBeenCalledTimes(2);
        fail("还是不行");
        setFocused(r, qc, false);
        setFocused(r, qc, true);
        expect(mockMap.reload).toHaveBeenCalledTimes(3);
        // 30 秒从上一次通道引起的重载算起，人点过、切过都不重新计时
        fail("还是不行");
        now += 10_000;
        flap();
        expect(mockMap.reload).toHaveBeenCalledTimes(4);
      });
    });

    it("切走那一下不重来；同一次渲染里切回来又连上：只重来一次", async () => {
      const qc = makeQueryClient();
      const r = await mount(qc);
      ws(false);
      fail();
      setFocused(r, qc, false);
      expect(mockMap.reload).not.toHaveBeenCalled();
      await act(async () => {
        mockWs.forEach((l) => l(true));
        routerState.focused = true;
        r.rerender(screenOf(qc));
      });
      expect(mockMap.reload).toHaveBeenCalledTimes(1);
    });

    it("没有错误时切页面、连上实时通道都不重载", async () => {
      const qc = makeQueryClient();
      const r = await mount(qc);
      setFocused(r, qc, false);
      setFocused(r, qc, true);
      ws(false);
      ws(true);
      expect(mockMap.reload).not.toHaveBeenCalled();
    });
  });

  it("点第一行（状态和更新时间那一行）也能收起 / 展开抽屉", async () => {
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.still")));
    const grabber = () =>
      r.root.findAll(
        (c) =>
          typeof c.type !== "string" &&
          c.props.hitSlop !== undefined &&
          typeof c.props.onPress === "function",
      )[0];
    r.press(tr("map.still"));
    expect(grabber().props.accessibilityState).toEqual({ expanded: false });
    r.press(tr("map.still"));
    expect(grabber().props.accessibilityState).toEqual({ expanded: true });
  });

  it("本趟里程：今天还没骑写 0.0，最近的行程还没拉到写 —；头盔没报过电量写 —", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([dev("h1", { name: "通勤", battery: null })]),
    );
    const qc = makeQueryClient();
    const r = await mount(qc);
    await waitFor(() => expect(r.allText()).toContain(tr("map.still")));
    expect(statOf(r, tr("map.rideDistance")).value).toBe("0.0");
    expect(statOf(r, tr("map.battery")).value).toBe("—");
    mockRides.recent = undefined;
    r.rerender(screenOf(qc));
    expect(statOf(r, tr("map.rideDistance")).value).toBe("—");
  });

  it("电量数字：正常用正文色（品牌黄写在浅色面板上对比度只有 1.46:1），≤20% 黄、≤10% 红，离线灰（10-31）", async () => {
    for (const [battery, online, color] of [
      [80, true, undefined],
      [15, true, Colors.dark.warning],
      [8, true, Colors.dark.danger],
      [80, false, Colors.dark.textSecondary],
    ] as const) {
      m(devicesApi.list).mockImplementation(() =>
        Promise.resolve([dev("h1", { name: "通勤", battery, online })]),
      );
      const r = await mount();
      const label = tr(online ? "map.battery" : "map.batteryLast");
      await waitFor(() => expect(statOf(r, label).value).toBe(String(battery)));
      expect(
        (statOf(r, label) as unknown as { valueColor?: string }).valueColor,
      ).toBe(color);
    }
  });

  it("骑行中地图重新就绪：把实时那条线也重推（不收视野）", async () => {
    mockRides.recent = [ride(10, { ongoing: true })];
    mockRides.track = [loc({ latitude: 22.54 }), loc({ latitude: 22.541 })];
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.riding")));
    jest.clearAllMocks();
    act(() => (mockMapProps.current.onReady as () => void)());
    expect(mockMap.setTrack).toHaveBeenCalledTimes(1);
    expect(mockMap.setTrack).toHaveBeenCalledWith(expect.any(Array), {
      fit: false,
    });
    // 整条线是两个轨迹点；此刻位置作为线头一并重推
    expect(m(mockMap.setTrack).mock.calls[0][0]).toHaveLength(2);
    expect(mockMap.setTrackTip).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: expect.any(Number) }),
    );
  });

  it("骑行中开 / 关屏幕常亮本身报错：吞掉，照常显示骑行中", async () => {
    m(activateKeepAwakeAsync).mockImplementationOnce(() =>
      Promise.reject(new Error("no activity")),
    );
    m(deactivateKeepAwake).mockImplementationOnce(() =>
      Promise.reject(new Error("no activity")),
    );
    mockRides.recent = [ride(10, { ongoing: true })];
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.riding")));
    expect(activateKeepAwakeAsync).toHaveBeenCalledTimes(1);
    r.unmount();
    expect(deactivateKeepAwake).toHaveBeenCalledTimes(1);
  });
});

describe("多顶头盔", () => {
  it("药丸可点：标当前、写切换；在面板里选另一顶只换地图看哪顶", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤" }),
        dev("h2", { name: "滑雪" }),
      ]),
    );
    mockSafety.links = { h1: "connected", h2: "connected" };
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.pill.switch")));
    expect(r.allText()).toContain(tr("map.pill.current"));
    // 名字放不下时截中间：默认名都是「helmet_」开头，后几位才分得出是哪一顶（10-17 英文下截成「helme…」）
    const pillName = r.root.findAll(
      (n) => n.props.ellipsizeMode === "middle",
    )[0];
    expect(pillName.props.numberOfLines).toBe(1);
    expect(pillName.props.children).toBe("通勤");
    act(() => {
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel ===
              tr("map.pill.a11y", { name: "通勤" }),
        )
        .props.onPress();
    });
    expect(r.allText()).toContain(tr("map.picker.title"));
    r.press("滑雪");
    expect(
      r.root.find(
        (n) =>
          n.type === Tappable &&
          n.props.accessibilityLabel === tr("map.pill.a11y", { name: "滑雪" }),
      ),
    ).toBeTruthy();
    expect(r.allText()).not.toContain(tr("map.pill.current"));
  });

  it("看一趟时换头盔：退回这一顶的行程列表；换回当前那顶，药丸又标「当前」；面板能关", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤" }),
        dev("h2", { name: "滑雪" }),
      ]),
    );
    mockSafety.links = { h1: "connected", h2: "connected" };
    mockRides.pages = [ride(9)];
    mockRides.track = [
      loc({ latitude: 22.5 }),
      loc({ latitude: 22.51 }),
      loc({ latitude: 22.52 }),
    ];
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.pill.switch")));
    openFirstRide(r);
    expect(r.allText()).toContain(tr("map.ride.duration"));
    const picker = () => r.root.findByType(HelmetPicker).props;
    act(() => round(r, tr("map.pill.a11y", { name: "通勤" })).props.onPress());
    r.press("滑雪");
    expect(picker().visible).toBe(false);
    expect(r.allText()).toContain(tr("map.rides.pickDate"));
    expect(r.allText()).not.toContain(tr("map.ride.duration"));
    expect(r.allText()).not.toContain(tr("map.pill.current"));

    act(() => round(r, tr("map.pill.a11y", { name: "滑雪" })).props.onPress());
    r.press("通勤");
    expect(r.allText()).toContain(tr("map.pill.current"));

    act(() => round(r, tr("map.pill.a11y", { name: "通勤" })).props.onPress());
    expect(picker().visible).toBe(true);
    act(() => round(r, tr("common.close")).props.onPress());
    expect(picker().visible).toBe(false);
  });
});

describe("行程", () => {
  it("打开行程列表 → 点一趟看回放（小结、播放走到头停下）→ 返回键一层层退回实时", async () => {
    mockRides.pages = [ride(9), ride(14)];
    mockRides.track = [
      loc({ latitude: 22.5 }),
      loc({ latitude: 22.51 }),
      loc({ latitude: 22.52 }),
    ];
    const r = await mount();
    // 回放的计时器在点「播放」之后才建：到那时换成假计时器
    jest.useFakeTimers();
    r.press(tr("map.rides.title"));
    expect(r.allText()).toContain(tr("map.rides.pickDate"));
    expect(backHandler).not.toBeNull();
    const rows = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        String(n.props.accessibilityLabel ?? "").includes("公里"),
    );
    expect(rows.length).toBe(2);
    act(() => {
      rows[0].props.onPress();
    });
    expect(r.allText()).toContain(tr("map.ride.duration"));
    expect(r.allText()).toContain(tr("map.ride.max"));
    // 标题最多两行：英文「Yesterday 01:00 – 00:59 next day」一行放不下（10-15 iPhone 截成「…ne…」）
    expect(
      r.root.findAll(
        (n) =>
          n.props.accessibilityRole === "header" && n.props.numberOfLines === 2,
      ).length,
    ).toBeGreaterThan(0);
    expect(mockMap.setTrack).toHaveBeenLastCalledWith(
      expect.any(Array),
      expect.objectContaining({ pad: expect.any(Array) }),
    );
    expect(mockMap.setHelmetReplay).toHaveBeenLastCalledWith(true);
    expect(mockMap.setMarks).toHaveBeenLastCalledWith([
      expect.objectContaining({ kind: "start" }),
      expect.objectContaining({ kind: "end" }),
    ]);
    act(() => {
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("map.play"),
        )
        .props.onPress();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(
      r.root.find(
        (n) =>
          n.type === Tappable && n.props.accessibilityLabel === tr("map.play"),
      ),
    ).toBeTruthy();
    act(() => {
      backHandler!();
    });
    expect(r.allText()).toContain(tr("map.rides.pickDate"));
    act(() => {
      backHandler!();
    });
    expect(backHandler).toBeNull();
    expect(r.allText()).toContain(tr("map.rides.title"));
    jest.useRealTimers();
  });

  it("进行中的那一趟就是「现在」：点了回到实时", async () => {
    mockRides.recent = [ride(10, { ongoing: true })];
    const r = await mount();
    r.press(tr("map.rides.title"));
    const rows = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        String(n.props.accessibilityLabel ?? "").includes("公里"),
    );
    act(() => {
      rows[0].props.onPress();
    });
    expect(r.allText()).not.toContain(tr("map.rides.pickDate"));
  });

  it("按日期找：打开月历选一天，列表只看那一天；返回键先收月历；查看全部回到全部", async () => {
    const d = new Date();
    const today = ride(8, {
      startAt: new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        8,
      ).toISOString(),
      endAt: new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        8,
        30,
      ).toISOString(),
    });
    mockRides.pages = [today];
    mockRides.month = [today];
    const r = await mount();
    r.press(tr("map.rides.title"));
    act(() => {
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("map.rides.pickDateA11y"),
        )
        .props.onPress();
    });
    expect(r.allText()).toContain(tr("map.rides.calendarTitle"));
    act(() => {
      backHandler!();
    });
    expect(r.allText()).not.toContain(tr("map.rides.calendarTitle"));
    act(() => {
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("map.rides.pickDateA11y"),
        )
        .props.onPress();
    });
    const day = r.root.find(
      (n) =>
        n.type === Tappable &&
        n.props.accessibilityState?.selected !== undefined &&
        String(n.props.accessibilityLabel).includes("1"),
    );
    act(() => {
      day.props.onPress();
    });
    expect(r.allText()).toContain(tr("map.rides.showAll"));
    r.press(tr("map.rides.showAll"));
    expect(r.allText()).toContain(tr("map.rides.pickDate"));
    act(() => {
      round(r, tr("map.rides.close")).props.onPress();
    });
    expect(r.allText()).not.toContain(tr("map.rides.pickDate"));
  });

  it("按日期找：翻到上个月选一天；再打开月历停在那个月、那一天标着选中；月历的返回键收起月历", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤", createdAt: "2020-01-01T00:00:00.000Z" }),
      ]),
    );
    const old = lastMonthRide();
    mockRides.pages = [old];
    mockRides.month = [old];
    const r = await mount();
    r.press(tr("map.rides.title"));
    act(() => round(r, tr("map.rides.pickDateA11y")).props.onPress());
    const calendar = () => r.root.findByType(RideCalendar).props;
    const now = new Date();
    expect(calendar().month).toEqual({
      year: now.getFullYear(),
      month: now.getMonth(),
    });
    expect(calendar().selectedDayKey).toBeNull();
    act(() => round(r, tr("map.rides.prevMonth")).props.onPress());
    expect(calendar().month).toEqual(lastMonth());
    const day = r.root.find(
      (n) =>
        n.type === Tappable && n.props.accessibilityState?.selected === false,
    );
    act(() => day.props.onPress());
    expect(r.root.findAllByType(RideCalendar)).toHaveLength(0);

    // 日期按钮写着正在看哪一天，再点打开月历
    const prefix = tr("map.rides.filteredA11y", { label: "@" }).split("@")[0];
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            String(n.props.accessibilityLabel ?? "").startsWith(prefix),
        )
        .props.onPress(),
    );
    expect(calendar().month).toEqual(lastMonth());
    expect(calendar().selectedDayKey).toBe(dayKeyOf(old.startAt));
    act(() => round(r, tr("map.ride.back")).props.onPress());
    expect(r.root.findAllByType(RideCalendar)).toHaveLength(0);
    expect(r.allText()).toContain(tr("map.rides.showAll"));
  });

  it("按日期找：选整月，列表只看那个月，日期按钮写着月份", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤", createdAt: "2020-01-01T00:00:00.000Z" }),
      ]),
    );
    const old = lastMonthRide();
    mockRides.pages = [old];
    mockRides.month = [old];
    const r = await mount();
    r.press(tr("map.rides.title"));
    act(() => round(r, tr("map.rides.pickDateA11y")).props.onPress());
    act(() => round(r, tr("map.rides.prevMonth")).props.onPress());
    const { year, month } = lastMonth();
    const title = monthTitle(year, month, "zh-CN");
    act(() =>
      round(r, tr("map.rides.monthAllA11y", { month: title })).props.onPress(),
    );
    expect(r.root.findAllByType(RideCalendar)).toHaveLength(0);
    expect(r.texts()).toContain(title);
    const list = r.root.findByType(RideList).props;
    expect(list.status).toBe("ready");
    expect(list.onShowAll).toBeDefined();
  });

  it("月历里这个月的行程还在拉 / 没拉到：写加载中 / 加载失败，点重试重拉这个月", async () => {
    mockRides.month = undefined;
    const qc = makeQueryClient();
    const r = await mount(qc);
    r.press(tr("map.rides.title"));
    act(() => round(r, tr("map.rides.pickDateA11y")).props.onPress());
    expect(r.root.findByType(RideCalendar).props.status).toBe("loading");
    mockRides.monthError = true;
    r.rerender(screenOf(qc));
    expect(r.root.findByType(RideCalendar).props.status).toBe("error");
    r.press(tr("map.retry"));
    expect(mockRefetch.month).toHaveBeenCalledTimes(1);
  });

  it("按天看时这个月的行程不在手上（还在拉 / 没拉到）：列表写加载中 / 加载失败，重试重拉这个月", async () => {
    const d = new Date();
    const today = ride(8, {
      startAt: new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        8,
      ).toISOString(),
      endAt: new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        8,
        30,
      ).toISOString(),
    });
    mockRides.pages = [today];
    mockRides.month = [today];
    const qc = makeQueryClient();
    const r = await mount(qc);
    r.press(tr("map.rides.title"));
    act(() => round(r, tr("map.rides.pickDateA11y")).props.onPress());
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityState?.selected === false,
        )
        .props.onPress(),
    );
    expect(r.root.findByType(RideList).props.status).toBe("ready");
    mockRides.month = undefined;
    r.rerender(screenOf(qc));
    expect(r.root.findByType(RideList).props.status).toBe("loading");
    mockRides.monthError = true;
    r.rerender(screenOf(qc));
    expect(r.root.findByType(RideList).props.status).toBe("error");
    r.press(tr("map.retry"));
    expect(mockRefetch.month).toHaveBeenCalledTimes(1);
    expect(mockRefetch.pages).not.toHaveBeenCalled();
  });

  it("行程列表第一页没拉到：写失败，点重试重拉；还有更早的可以接着往前加载", async () => {
    mockRides.pagesError = true;
    const qc = makeQueryClient();
    const r = await mount(qc);
    r.press(tr("map.rides.title"));
    expect(r.root.findByType(RideList).props.status).toBe("error");
    r.press(tr("map.retry"));
    expect(mockRefetch.pages).toHaveBeenCalledTimes(1);
    mockRides.pagesError = false;
    mockRides.pages = [ride(9)];
    mockRides.pagesNext = { year: 2026, month: 8 };
    r.rerender(screenOf(qc));
    expect(r.root.findByType(RideList).props.status).toBe("ready");
    r.press(tr("map.rides.loadOlder"));
    expect(mockRefetch.older).toHaveBeenCalledTimes(1);
  });

  it("一趟超过一小时：时长写「时:分」，单位是小时", async () => {
    mockRides.pages = [
      ride(9, { endAt: new Date(2026, 9, 15, 11, 15).toISOString() }),
    ];
    mockRides.track = [loc({ latitude: 22.5 }), loc({ latitude: 22.51 })];
    const r = await mount();
    openFirstRide(r);
    expect(statOf(r, tr("map.ride.duration"))).toEqual(
      expect.objectContaining({ value: "2:15", unit: tr("ride.hours") }),
    );
  });

  it("轨迹还在拉：回放写加载中，点播放没反应", async () => {
    mockRides.pages = [ride(9)];
    mockRides.trackLoading = true;
    const r = await mount();
    openFirstRide(r);
    expect(replayOf(r).status).toBe("loading");
    act(() => replayOf(r).onTogglePlay());
    expect(replayOf(r).playing).toBe(false);
  });

  it("轨迹到了、事件没拉到：照样能回放，地图上只标起点终点，提示事件没拉到", async () => {
    mockRides.pages = [ride(9)];
    mockRides.track = [
      loc({ latitude: 22.5 }),
      loc({ latitude: 22.51 }),
      loc({ latitude: 22.52 }),
    ];
    mockRides.eventsError = true;
    const r = await mount();
    openFirstRide(r);
    expect(replayOf(r).status).toBe("ready");
    expect(replayOf(r).events).toEqual([]);
    expect(replayOf(r).eventsFailed).toBe(true);
    expect(mockMap.setMarks).toHaveBeenLastCalledWith([
      expect.objectContaining({ kind: "start" }),
      expect.objectContaining({ kind: "end" }),
    ]);
    act(() => replayOf(r).onTogglePlay());
    expect(replayOf(r).playing).toBe(true);
  });
});

describe("带参数进来", () => {
  it("rides=1：直接打开行程列表；用完清掉参数", async () => {
    routerState.params = { deviceId: "h1", rides: "1" };
    const r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("map.rides.pickDate")),
    );
    expect(mockRouter.setParams).toHaveBeenCalledWith({
      deviceId: undefined,
      at: undefined,
      rides: undefined,
    });
  });

  it("at=某时刻：打开那一刻所在的那一趟，回放停在那一刻；那一刻前后没有定位记录时说出来", async () => {
    const at = new Date(2026, 9, 15, 9, 10).toISOString();
    mockRides.at = ride(9);
    mockRides.track = [
      loc({ timestamp: new Date(2026, 9, 15, 9, 0).toISOString() }),
      loc({
        timestamp: new Date(2026, 9, 15, 9, 10).toISOString(),
        latitude: 22.55,
      }),
      loc({
        timestamp: new Date(2026, 9, 15, 9, 20).toISOString(),
        latitude: 22.56,
      }),
    ];
    routerState.params = { deviceId: "h1", at };
    let r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.ride.duration")));
    expect(r.allText()).toContain(tr("map.moment.mark"));
    r.unmount();
    mockRides.at = null;
    mockRides.track = [];
    routerState.params = { deviceId: "h1", at };
    r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.moment.none")));
  });

  it("只带 deviceId（外部链接）：地图换看那一顶，停在实时位置", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤" }),
        dev("h2", { name: "滑雪" }),
      ]),
    );
    routerState.params = { deviceId: "h2" };
    const r = await mount();
    await waitFor(() =>
      expect(round(r, tr("map.pill.a11y", { name: "滑雪" }))).toBeTruthy(),
    );
    expect(r.allText()).not.toContain(tr("map.pill.current"));
    expect(r.allText()).not.toContain(tr("map.rides.pickDate"));
    expect(mockRouter.setParams).toHaveBeenCalledWith({
      deviceId: undefined,
      at: undefined,
      rides: undefined,
    });
  });

  it("只带 rides=1（不指定哪一顶）：打开当前那顶的行程列表", async () => {
    routerState.params = { rides: "1" };
    const r = await mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("map.rides.pickDate")),
    );
    expect(r.texts()).toContain("通勤");
  });

  it("at=某时刻、还在查它落在哪一趟：写「正在查找对应行程」，轨迹先不拉", async () => {
    mockRides.atLoading = true;
    routerState.params = {
      deviceId: "h1",
      at: new Date(2026, 9, 15, 9, 10).toISOString(),
    };
    const r = await mount();
    await waitFor(() =>
      expect(replayOf(r).note).toBe(tr("map.moment.finding")),
    );
    expect(replayOf(r).status).toBe("loading");
    expect(replayOf(r).points).toHaveLength(0);
  });

  it("at=某时刻、它不在任何一趟里：小结用那前后半小时的轨迹统计", async () => {
    const t = (min: number) => new Date(2026, 9, 15, 9, min).toISOString();
    mockRides.at = null;
    mockRides.track = [
      loc({ timestamp: t(0) }),
      loc({ timestamp: t(10), latitude: 22.55 }),
      loc({ timestamp: t(20), latitude: 22.56 }),
    ];
    mockRides.trackSummary = {
      distanceMeters: 3200,
      movingSeconds: 1100,
      maxSpeed: 6,
      pointCount: 3,
      firstAt: t(0),
      lastAt: t(20),
    };
    routerState.params = { deviceId: "h1", at: t(10) };
    const r = await mount();
    await waitFor(() => expect(replayOf(r).status).toBe("ready"));
    expect(statOf(r, tr("map.distance")).value).toBe(formatKm(3200));
    expect(statOf(r, tr("map.ride.duration"))).toEqual(
      expect.objectContaining({ value: "20", unit: tr("ride.minutes") }),
    );
    expect(statOf(r, tr("map.ride.max")).value).toBe("22");
    // 平均时速只对一趟行程算
    expect(statOf(r, tr("map.ride.avg")).value).toBe("—");
  });

  it("看一趟时外部链接只带 deviceId 换到另一顶：和面板里换头盔一样退回行程列表（不再停在上一顶那一趟）", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        dev("h1", { name: "通勤" }),
        dev("h2", { name: "滑雪" }),
      ]),
    );
    mockRides.pages = [ride(9)];
    mockRides.track = [loc({ latitude: 22.5 }), loc({ latitude: 22.51 })];
    const qc = makeQueryClient();
    const r = await mount(qc);
    openFirstRide(r);
    expect(r.allText()).toContain(tr("map.ride.duration"));
    routerState.params = { deviceId: "h2" };
    r.rerender(screenOf(qc));
    await waitFor(() =>
      expect(round(r, tr("map.pill.a11y", { name: "滑雪" }))).toBeTruthy(),
    );
    await waitFor(() =>
      expect(r.allText()).not.toContain(tr("map.ride.duration")),
    );
    expect(r.allText()).toContain(tr("map.rides.pickDate"));
  });
});

describe("一趟里的回放、事件与抽屉", () => {
  /** 9 个点，9:00 起每 2 分钟一个 */
  const at = (min: number, sec = 0) =>
    new Date(2026, 9, 15, 9, min, sec).toISOString();
  const TRACK = Array.from({ length: 9 }, (_, i) =>
    loc({ timestamp: at(i * 2), latitude: 22.5 + i * 0.001 }),
  );
  const replay = (r: Rendered) => r.root.findByType(RideReplay).props;
  const openRide = async () => {
    mockRides.pages = [ride(9)];
    mockRides.track = TRACK;
    const r = await mount();
    r.press(tr("map.rides.title"));
    const row = r.root.find(
      (n) =>
        n.type === Tappable &&
        String(n.props.accessibilityLabel ?? "").includes("公里"),
    );
    act(() => {
      row.props.onPress();
    });
    return r;
  };

  it("事件落到轨迹上最近的点，名字按类型（不认识的写「标记」），挨得近的合成一处带数字；还有没列出来的写条数", async () => {
    mockRides.events = [
      { eventId: "e1", eventType: "collision_risk", timestamp: at(4) },
      { eventId: "e2", eventType: "obstacle_risk", timestamp: at(4, 30) },
      { eventId: "e3", eventType: "mystery", timestamp: at(12) },
    ];
    mockRides.eventsTotal = 5;
    const r = await openRide();
    const p = replay(r);
    expect(p.status).toBe("ready");
    expect(
      (
        p.events as {
          key: string;
          index: number;
          name: string;
          count: number;
        }[]
      ).map((e) => [e.key, e.index, e.name, e.count]),
    ).toEqual([
      ["e1", 2, tr("events.type.collision_risk"), 2],
      ["e3", 6, tr("map.moment.mark"), 1],
    ]);
    expect(p.moreEvents).toBe(2);
    expect(p.activeEventKey).toBeNull();
    expect(mockMap.setMarks).toHaveBeenLastCalledWith([
      expect.objectContaining({ kind: "start" }),
      expect.objectContaining({ kind: "end" }),
      // 碰撞标红；从安全记录跳进来的那一刻没对上事件，用提醒色
      expect.objectContaining({ kind: "event", label: "2", danger: true }),
      expect.objectContaining({
        kind: "event",
        label: undefined,
        danger: false,
      }),
    ]);
  });

  it("拖进度条：停在那一处（越界的夹回两头），走到事件附近把它标出来；倍速 1→2→4→1；播放中再点就暂停", async () => {
    mockRides.events = [
      { eventId: "e1", eventType: "collision_risk", timestamp: at(4) },
      { eventId: "e3", eventType: "possible_fall", timestamp: at(12) },
    ];
    const r = await openRide();
    act(() => replay(r).onSeek(4));
    expect(replay(r).replayIdx).toBe(4);
    expect(replay(r).activeEventKey).toBeNull();
    act(() => replay(r).onSeek(3));
    expect(replay(r).activeEventKey).toBe("e1");
    act(() => replay(r).onSeek(7));
    expect(replay(r).activeEventKey).toBe("e3");
    expect(replay(r).events[1].name).toBe(tr("safety.risk.fall"));
    act(() => replay(r).onSeek(-5));
    expect(replay(r).replayIdx).toBe(0);
    act(() => replay(r).onSeek(100));
    expect(replay(r).replayIdx).toBe(8);
    // 回放位置上画头盔
    expect(mockMap.setHelmet).toHaveBeenLastCalledWith(
      expect.objectContaining({ latitude: expect.any(Number) }),
    );

    expect(replay(r).speed).toBe(1);
    act(() => replay(r).onCycleSpeed());
    expect(replay(r).speed).toBe(2);
    act(() => replay(r).onCycleSpeed());
    expect(replay(r).speed).toBe(4);
    act(() => replay(r).onCycleSpeed());
    expect(replay(r).speed).toBe(1);

    // 停在最后一点时点播放：从头放
    act(() => replay(r).onTogglePlay());
    expect(replay(r).playing).toBe(true);
    expect(replay(r).replayIdx).toBe(0);
    act(() => replay(r).onTogglePlay());
    expect(replay(r).playing).toBe(false);
    // 拖的时候停下
    act(() => replay(r).onTogglePlay());
    act(() => replay(r).onSeek(5));
    expect(replay(r).playing).toBe(false);
  });

  it("从安全记录跳到某一刻、那一刻正好有个事件：单独标出来、用那个事件的名字，不和旁边的并在一起", async () => {
    const moment = at(8);
    mockRides.at = ride(9);
    mockRides.track = TRACK;
    mockRides.events = [
      { eventId: "e1", eventType: "collision_risk", timestamp: at(7, 50) },
      { eventId: "e2", eventType: "manual_sos", timestamp: at(8, 1) },
    ];
    routerState.params = { deviceId: "h1", at: moment };
    // 和真的路由一样：清参数之后下一次渲染就读不到了（不然头盔列表回来、effect 重跑时又会把参数用一遍）
    m(mockRouter.setParams).mockImplementation((p: unknown) => {
      routerState.params = {
        ...routerState.params,
        ...(p as Record<string, undefined>),
      };
    });
    const r = await mount();
    await waitFor(() => expect(replay(r).status).toBe("ready"));
    const events = replay(r).events as {
      key: string;
      name: string;
      index: number;
    }[];
    expect(events.map((e) => [e.key, e.name, e.index])).toEqual([
      ["e1", tr("events.type.collision_risk"), 4],
      ["moment", tr("safety.manualSos"), 4],
    ]);
    // 回放停在那一刻，标的是它
    expect(replay(r).replayIdx).toBe(4);
    expect(replay(r).activeEventKey).toBe("moment");
  });

  it("轨迹拉取失败：写失败、不能放；重试重拉轨迹，事件也失败时一起重拉；事件单独失败可单独重拉", async () => {
    mockRides.trackError = true;
    mockRides.eventsError = true;
    const r = await openRide();
    expect(replay(r).status).toBe("error");
    expect(replay(r).eventsFailed).toBe(true);
    act(() => replay(r).onTogglePlay());
    expect(replay(r).playing).toBe(false);
    act(() => replay(r).onSeek(3));
    expect(replay(r).replayIdx).toBeNull();
    act(() => replay(r).onRetry());
    expect(mockRefetch.track).toHaveBeenCalledTimes(1);
    expect(mockRefetch.events).toHaveBeenCalledTimes(1);
    act(() => replay(r).onRetryEvents());
    expect(mockRefetch.events).toHaveBeenCalledTimes(2);
    mockRides.eventsError = false;
    r.rerender(
      <QueryClientProvider client={makeQueryClient()}>
        <MapScreen />
      </QueryClientProvider>,
    );
    act(() => replay(r).onRetry());
    expect(mockRefetch.track).toHaveBeenCalledTimes(2);
    expect(mockRefetch.events).toHaveBeenCalledTimes(2);
  });

  it("看一趟时：抽屉变高按新高度再收一次视野，用户自己拖过地图就不再替他收（也不退出跟随）；地图重新就绪时把这一趟和回放位置重推", async () => {
    const r = await openRide();
    const content = r.root.findAll(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.findAll((c) => isHost(c, "GestureDetector")).length > 0,
    )[0];
    const fits = () => mockMap.setTrack.mock.calls.length;
    const before = fits();
    act(() =>
      content.props.onLayout({ nativeEvent: { layout: { height: 320 } } }),
    );
    expect(fits()).toBe(before + 1);
    act(() => (mockMapProps.current.onUserPan as () => void)());
    act(() =>
      content.props.onLayout({ nativeEvent: { layout: { height: 380 } } }),
    );
    expect(fits()).toBe(before + 1);
    // 高度没真变（不到半个点）不重排
    act(() =>
      content.props.onLayout({ nativeEvent: { layout: { height: 380.2 } } }),
    );
    act(() =>
      content.props.onLayout({ nativeEvent: { layout: { height: 0 } } }),
    );

    act(() => replay(r).onSeek(2));
    jest.clearAllMocks();
    act(() => (mockMapProps.current.onReady as () => void)());
    expect(mockMap.setTrack).toHaveBeenCalledWith(expect.any(Array), {
      pad: expect.any(Array),
    });
    expect(mockMap.setHelmet).toHaveBeenCalledTimes(1);
    expect(mockMap.setHelmetOnline).toHaveBeenCalledWith(true);
    expect(mockMap.setHelmetReplay).toHaveBeenCalledWith(true);
    // 还在看这一趟（没有退回实时）
    expect(r.allText()).toContain(tr("map.ride.duration"));
  });

  it("抽屉：点抓手 / 第一行收起、再点展开；拖着跟手，松手按速度和位置决定收还是展；收着时整张卡都能上滑展开；换内容时自动展开", async () => {
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.still")));
    const detectors = () =>
      r.root
        .findAll((n) => isHost(n, "GestureDetector"))
        .map((n) => n.props.gesture as RecordedGesture);
    // 外层 = 整张卡，里层 = 抓手 + 第一行 + 数据格
    const card = () => detectors()[0];
    const sheet = () => detectors()[1];
    const enabled = () => [card().config.enabled[0], sheet().config.enabled[0]];
    const maxHeight = () =>
      r.root
        .findAll(
          (n) =>
            typeof n.type === "string" &&
            flat(n.props.style).maxHeight !== undefined,
        )
        .map((n) => flat(n.props.style).maxHeight as number)[0];
    const isGrabber = (c: ReactTestInstance) =>
      typeof c.type !== "string" &&
      c.props.hitSlop !== undefined &&
      typeof c.props.onPress === "function";
    const withLayout = (n: ReactTestInstance) =>
      typeof n.type === "string" && typeof n.props.onLayout === "function";
    // 卡里内容那一层（里面套着抽屉手势区）、第一行（抓手所在、里面没有手势区）
    const content = r.root.findAll(
      (n) =>
        withLayout(n) &&
        n.findAll((c) => isHost(c, "GestureDetector")).length > 0,
    )[0];
    const header = r.root.findAll(
      (n) =>
        withLayout(n) &&
        n.findAll((c) => isHost(c, "GestureDetector")).length === 0 &&
        n.findAll(isGrabber).length > 0,
    )[0];
    act(() =>
      content.props.onLayout({ nativeEvent: { layout: { height: 300 } } }),
    );
    act(() =>
      header.props.onLayout({ nativeEvent: { layout: { height: 60 } } }),
    );
    expect(enabled()).toEqual([false, true]);
    const grabber = () => r.root.findAll(isGrabber)[0];

    act(() => grabber().props.onPress());
    expect(enabled()).toEqual([true, false]);
    const collapsed = maxHeight();
    act(() => grabber().props.onPress());
    expect(enabled()).toEqual([false, true]);
    // 展开 / 收起两种高度只差内容高度 − 第一行高度
    expect(maxHeight() - collapsed).toBeCloseTo(300 - 60);

    // 拖：往下拖 100（没过一半）松手 → 展开；拖 150（过了一半）→ 收起
    const drag = (g: () => RecordedGesture, dy: number, vy = 0) => {
      act(() => {
        g().handlers.onStart();
        g().handlers.onUpdate({ translationY: dy });
        g().handlers.onEnd({ velocityY: vy });
      });
    };
    drag(sheet, 100);
    expect(enabled()).toEqual([false, true]);
    drag(sheet, 150);
    expect(enabled()).toEqual([true, false]);
    // 收着：整张卡上滑（快速往上甩）展开
    drag(card, -20, -900);
    expect(enabled()).toEqual([false, true]);
    // 快速往下甩：哪怕只拖了一点也收起
    drag(sheet, 10, 900);
    expect(enabled()).toEqual([true, false]);
    // 收着时打开行程列表：抽屉自动展开
    r.press(tr("map.rides.title"));
    expect(enabled()).toEqual([false, true]);
  });

  it("刚进页面（抽屉自适应展开着）就往下拖：从内容的实际高度开始跟手，拖过一半松手收起", async () => {
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.still")));
    const withLayout = (n: ReactTestInstance) =>
      typeof n.type === "string" && typeof n.props.onLayout === "function";
    const isGrabber = (c: ReactTestInstance) =>
      typeof c.type !== "string" &&
      c.props.hitSlop !== undefined &&
      typeof c.props.onPress === "function";
    const content = r.root.findAll(
      (n) =>
        withLayout(n) &&
        n.findAll((c) => isHost(c, "GestureDetector")).length > 0,
    )[0];
    const header = r.root.findAll(
      (n) =>
        withLayout(n) &&
        n.findAll((c) => isHost(c, "GestureDetector")).length === 0 &&
        n.findAll(isGrabber).length > 0,
    )[0];
    act(() =>
      content.props.onLayout({ nativeEvent: { layout: { height: 300 } } }),
    );
    act(() =>
      header.props.onLayout({ nativeEvent: { layout: { height: 60 } } }),
    );
    const sheet = r.root
      .findAll((n) => isHost(n, "GestureDetector"))
      .map((n) => n.props.gesture as RecordedGesture)[1];
    // 展开态的上限是个很大的数：要从内容实际高度起算，拖 150（过了一半）才收得起来
    act(() => {
      sheet.handlers.onStart();
      sheet.handlers.onUpdate({ translationY: 150 });
      sheet.handlers.onEnd({ velocityY: 0 });
    });
    expect(r.root.findAll(isGrabber)[0].props.accessibilityState).toEqual({
      expanded: false,
    });
  });

  describe("松手后抽屉在 UI 线程上直接吸附（不等 JS 线程）", () => {
    // 展开态的 maxHeight 上限（map.tsx 的 SHEET_OPEN）
    const SHEET_OPEN = 4000;
    const setup = async () => {
      const client = makeQueryClient();
      const r = await mount(client);
      await waitFor(() => expect(r.allText()).toContain(tr("map.still")));
      const withLayout = (n: ReactTestInstance) =>
        typeof n.type === "string" && typeof n.props.onLayout === "function";
      const isGrabber = (c: ReactTestInstance) =>
        typeof c.type !== "string" &&
        c.props.hitSlop !== undefined &&
        typeof c.props.onPress === "function";
      const content = r.root.findAll(
        (n) =>
          withLayout(n) &&
          n.findAll((c) => isHost(c, "GestureDetector")).length > 0,
      )[0];
      const header = r.root.findAll(
        (n) =>
          withLayout(n) &&
          n.findAll((c) => isHost(c, "GestureDetector")).length === 0 &&
          n.findAll(isGrabber).length > 0,
      )[0];
      act(() =>
        content.props.onLayout({ nativeEvent: { layout: { height: 300 } } }),
      );
      act(() =>
        header.props.onLayout({ nativeEvent: { layout: { height: 60 } } }),
      );
      const detectors = () =>
        r.root
          .findAll((n) => isHost(n, "GestureDetector"))
          .map((n) => n.props.gesture as RecordedGesture);
      const card = () => detectors()[0];
      const sheet = () => detectors()[1];
      /** 手势区开关（React 状态 panelCollapsed 的结果）：[整张卡, 抓手那块] */
      const enabled = () => [
        card().config.enabled[0],
        sheet().config.enabled[0],
      ];
      /** 抽屉的 maxHeight（动画样式要再渲染一次才读得到共享值的最新值） */
      const maxHeight = () => {
        act(() => r.rerender(screenOf(client)));
        return r.root
          .findAll(
            (n) =>
              typeof n.type === "string" &&
              flat(n.props.style).maxHeight !== undefined,
          )
          .map((n) => flat(n.props.style).maxHeight as number)[0];
      };
      const drag = (g: () => RecordedGesture, dy: number, vy = 0) =>
        act(() => {
          g().handlers.onStart();
          g().handlers.onUpdate({ translationY: dy });
          g().handlers.onEnd({ velocityY: vy });
        });
      return {
        r,
        enabled,
        maxHeight,
        drag,
        card,
        sheet,
        grabber: () => r.root.findAll(isGrabber)[0],
      };
    };

    it("JS 线程还没处理排队的回调时，高度已经到位；回 JS 的只有手势区开关", async () => {
      const worklets = jest.requireMock<{
        scheduleOnRN: (fn: (...a: unknown[]) => void, ...a: unknown[]) => void;
      }>("react-native-worklets");
      const syncRN = worklets.scheduleOnRN;
      const queued: (() => void)[] = [];
      worklets.scheduleOnRN = (fn, ...a) => {
        queued.push(() => fn(...a));
      };
      try {
        const { enabled, maxHeight, drag, card, sheet, grabber } =
          await setup();
        // 用点抓手的路径量出「收起」「展开」两种高度（这条路径本来就不经 UI 线程回调）
        act(() => grabber().props.onPress());
        const collapsed = maxHeight();
        act(() => grabber().props.onPress());
        const expanded = maxHeight();
        expect(expanded - collapsed).toBeCloseTo(300 - 60);
        expect(enabled()).toEqual([false, true]);

        // 拖过一半松手 → 收起：JS 线程还没来得及处理，抽屉高度已经是收起的高度
        drag(sheet, 150);
        expect(maxHeight()).toBe(collapsed);
        expect(enabled()).toEqual([false, true]);
        // JS 线程空下来：手势区开关才跟着翻
        act(() => queued.splice(0).forEach((f) => f()));
        expect(enabled()).toEqual([true, false]);

        // 收着：整张卡快速上甩 → 展开，同样先到位、后翻开关
        drag(card, -20, -900);
        expect(maxHeight()).toBeCloseTo(expanded);
        expect(enabled()).toEqual([true, false]);
        act(() => queued.splice(0).forEach((f) => f()));
        expect(enabled()).toEqual([false, true]);
      } finally {
        worklets.scheduleOnRN = syncRN;
      }
    });

    it("展开到位后放开上限交还自适应；动画途中又被收起则不放开", async () => {
      const Reanimated = jest.requireMock<
        Record<"withTiming", (...a: unknown[]) => unknown>
      >("react-native-reanimated");
      const callbacks: ((finished: boolean) => void)[] = [];
      const timing = jest
        .spyOn(Reanimated, "withTiming")
        .mockImplementation((...a: unknown[]) => {
          const cb = a[2] as ((f: boolean) => void) | undefined;
          if (cb) callbacks.push(cb);
          return a[0];
        });
      try {
        const { maxHeight, drag, card, sheet } = await setup();
        // 收起，再上甩展开：动画还没走完，上限还是具体高度
        drag(sheet, 150);
        drag(card, -20, -900);
        expect(callbacks).toHaveLength(1);
        expect(maxHeight()).toBeLessThan(SHEET_OPEN);
        // 走完：放开上限
        act(() => callbacks[0](true));
        expect(maxHeight()).toBe(SHEET_OPEN);

        // 再收起、再展开，展开动画走到一半又被收起：之后展开那条的完成回调不能把上限放开
        drag(sheet, 150);
        drag(card, -20, -900);
        expect(callbacks).toHaveLength(2);
        drag(sheet, 150);
        const collapsedNow = maxHeight();
        expect(collapsedNow).toBeLessThan(SHEET_OPEN);
        act(() => callbacks[1](true));
        expect(maxHeight()).toBe(collapsedNow);
      } finally {
        timing.mockRestore();
      }
    });
  });
});

describe("2026-10-17 复审：头盔 Marker、视野、回放状态、定位缓存", () => {
  const at = (min: number) => new Date(2026, 9, 15, 9, min).toISOString();
  const TRACK = Array.from({ length: 5 }, (_, i) =>
    loc({ timestamp: at(i * 2), latitude: 22.5 + i * 0.001 }),
  );
  const replay = (r: Rendered) => r.root.findByType(RideReplay).props;
  const pickFirstRide = (r: Rendered) => {
    r.press(tr("map.rides.title"));
    const row = r.root.find(
      (n) =>
        n.type === Tappable &&
        String(n.props.accessibilityLabel ?? "").includes("公里"),
    );
    act(() => {
      row.props.onPress();
    });
  };
  const sheetContent = (r: Rendered) =>
    r.root.findAll(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.findAll((c) => isHost(c, "GestureDetector")).length > 0,
    )[0];

  it("实时没有位置：收起头盔 Marker（地图重新就绪时也收），不画在别处", async () => {
    m(devicesApi.latestLocation).mockImplementation(() =>
      Promise.resolve({ location: null }),
    );
    await mount();
    await waitFor(() => expect(mockMap.hideHelmet).toHaveBeenCalled());
    expect(mockMap.setHelmet).not.toHaveBeenCalled();
    jest.clearAllMocks();
    act(() => (mockMapProps.current.onReady as () => void)());
    expect(mockMap.hideHelmet).toHaveBeenCalledTimes(1);
    expect(mockMap.setHelmet).not.toHaveBeenCalled();
  });

  it("看一趟、轨迹还没有可画的点：头盔 Marker 收起，不停在实时位置上", async () => {
    mockRides.pages = [ride(9)];
    mockRides.track = [];
    const r = await mount();
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalled());
    pickFirstRide(r);
    jest.clearAllMocks();
    // 再推一次实时状态：仍然收着
    act(() => (mockMapProps.current.onReady as () => void)());
    expect(mockMap.hideHelmet).toHaveBeenCalled();
    expect(mockMap.setHelmet).not.toHaveBeenCalled();
  });

  it("看历史行程时实时定位来了新点：不重新收视野；捏合缩放过也算用户动过地图", async () => {
    const qc = makeQueryClient();
    mockRides.pages = [ride(9)];
    mockRides.track = TRACK;
    const r = await mount(qc);
    pickFirstRide(r);
    const fits = () => m(mockMap.setTrack).mock.calls.length;
    const helmetMoves = () => m(mockMap.setHelmet).mock.calls.length;
    const before = fits();
    const movesBefore = helmetMoves();
    // 查询库把通知攒到下一轮宏任务才发：等它重渲染完再看
    await act(async () => {
      qc.setQueryData(
        ["device-location", "h1"],
        loc({ latitude: 22.6, timestamp: new Date().toISOString() }),
      );
      await new Promise((res) => setTimeout(res, 0));
    });
    // 实时位置确实变了（Marker 的 effect 重跑过），但轨迹没有重新收视野
    expect(helmetMoves()).toBeGreaterThan(movesBefore);
    expect(fits()).toBe(before);
    // 抽屉变高本来会再收一次视野；用户捏合缩放过之后就不收了
    act(() => (mockMapProps.current.onUserZoom as () => void)());
    act(() =>
      sheetContent(r).props.onLayout({
        nativeEvent: { layout: { height: 333 } },
      }),
    );
    expect(fits()).toBe(before);
  });

  it("看实时位置时缩放地图：不退出跟随（只有拖动才退出）", async () => {
    const r = await mount();
    await waitFor(() => expect(mockMap.setHelmet).toHaveBeenCalled());
    act(() => (mockMapProps.current.onUserZoom as () => void)());
    expect(round(r, tr("map.following"))).toBeTruthy();
  });

  it("REST 轮询回来的点比 WS 先推来的旧：缓存里留着新的；REST 的更新才换上", async () => {
    const qc = makeQueryClient();
    await mount(qc);
    const key = ["device-location", "h1"];
    await waitFor(() => expect(qc.getQueryData(key)).toBeTruthy());
    const newer = loc({
      latitude: 22.6,
      timestamp: new Date(Date.now() + 60_000).toISOString(),
    });
    act(() => {
      qc.setQueryData(key, newer);
    });
    m(devicesApi.latestLocation).mockImplementation(() =>
      Promise.resolve({
        location: loc({
          latitude: 22.4,
          timestamp: new Date(Date.now() - 60_000).toISOString(),
        }),
      }),
    );
    await act(async () => {
      await qc.refetchQueries({ queryKey: key });
    });
    expect(qc.getQueryData(key)).toEqual(newer);
    const newest = loc({
      latitude: 22.7,
      timestamp: new Date(Date.now() + 120_000).toISOString(),
    });
    m(devicesApi.latestLocation).mockImplementation(() =>
      Promise.resolve({ location: newest }),
    );
    await act(async () => {
      await qc.refetchQueries({ queryKey: key });
    });
    expect(qc.getQueryData(key)).toEqual(newest);
  });

  it("轨迹已经画着、后台刷新失败：仍可回放，不写「轨迹加载失败」", async () => {
    mockRides.pages = [ride(9)];
    mockRides.track = TRACK;
    mockRides.trackRefetchError = true;
    const r = await mount();
    pickFirstRide(r);
    expect(replay(r).status).toBe("ready");
    act(() => replay(r).onTogglePlay());
    expect(replay(r).playing).toBe(true);
  });

  it("回放中离开地图页：停下；回来也不自己接着放", async () => {
    const qc = makeQueryClient();
    mockRides.pages = [ride(9)];
    mockRides.track = TRACK;
    const r = await mount(qc);
    pickFirstRide(r);
    act(() => replay(r).onTogglePlay());
    expect(replay(r).playing).toBe(true);
    const tree = (
      <QueryClientProvider client={qc}>
        <MapScreen />
      </QueryClientProvider>
    );
    routerState.focused = false;
    r.rerender(tree);
    expect(replay(r).playing).toBe(false);
    routerState.focused = true;
    r.rerender(tree);
    expect(replay(r).playing).toBe(false);
  });

  it("回放中轨迹变得不可用：停下", async () => {
    const qc = makeQueryClient();
    mockRides.pages = [ride(9)];
    mockRides.track = TRACK;
    const r = await mount(qc);
    pickFirstRide(r);
    act(() => replay(r).onTogglePlay());
    mockRides.trackError = true;
    r.rerender(
      <QueryClientProvider client={qc}>
        <MapScreen />
      </QueryClientProvider>,
    );
    expect(replay(r).status).toBe("error");
    expect(replay(r).playing).toBe(false);
  });

  it("「在地图上查看该时刻」查那一刻在哪一趟失败：写查询失败、给重试（重查那一刻），不退成看前后一段", async () => {
    mockRides.atError = true;
    mockRides.track = TRACK;
    routerState.params = { deviceId: "h1", at: at(4) };
    const r = await mount();
    await waitFor(() => expect(replay(r).status).toBe("error"));
    expect(replay(r).failText).toBe(tr("map.moment.findFailed"));
    expect(replay(r).points).toHaveLength(0);
    expect(r.allText()).toContain(tr("map.moment.findFailed"));
    expect(r.allText()).not.toContain(tr("map.moment.none"));
    act(() => replay(r).onRetry());
    expect(mockRefetch.at).toHaveBeenCalledTimes(1);
    expect(mockRefetch.track).not.toHaveBeenCalled();
  });

  it("抽屉抓手：读屏读得出是按钮、写着展开 / 收起", async () => {
    const r = await mount();
    await waitFor(() => expect(r.allText()).toContain(tr("map.still")));
    const grabber = () =>
      r.root.findAll(
        (c) =>
          typeof c.type !== "string" &&
          c.props.hitSlop !== undefined &&
          typeof c.props.onPress === "function",
      )[0];
    expect(grabber().props.accessibilityRole).toBe("button");
    expect(grabber().props.accessibilityLabel).toBe(tr("map.sheet.collapse"));
    expect(grabber().props.accessibilityState).toEqual({ expanded: true });
    act(() => grabber().props.onPress());
    expect(grabber().props.accessibilityLabel).toBe(tr("map.sheet.expand"));
    expect(grabber().props.accessibilityState).toEqual({ expanded: false });
  });
});
