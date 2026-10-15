// 地图标签页：实时位置（在线 / 离线 / 没位置 / (0,0) 占位）、骑行中屏幕常亮、分享与导航、跟随与回中、
// 地图异常重新加载、多顶头盔切换、行程列表 → 一趟 → 回放、按日期找、Android 返回键一层层退、
// 从设备页 / 安全记录带参数进来。行程数据的钩子替换成可控的值，地图组件替换成记录命令的替身。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import type { DevicePublic, LocationPoint, RideSummary } from "@helmet/shared";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  Animated as RNAnimated,
  AppState,
  BackHandler,
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
import { openAmapNavigation } from "@/components/map/nav-links";
import { RideReplay } from "@/components/map/ride-replay";
import { Tappable } from "@/components/tappable";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
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
  setTrack: jest.fn(),
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
  recent: [] as RideSummary[],
  pages: [] as RideSummary[],
  track: [] as LocationPoint[],
  events: [] as { eventId: string; eventType: string; timestamp: string }[],
  /** 事件接口报的总数（比拿回来的多 = 还有没列出来的）；null = 和拿回来的一样多 */
  eventsTotal: null as number | null,
  trackError: false,
  eventsError: false,
  month: [] as RideSummary[],
  at: null as RideSummary | null,
};
const mockRefetch = { track: jest.fn(), events: jest.fn() };
jest.mock("@/hooks/use-rides", () => ({
  useRecentRides: () => ({ data: mockRides.recent }),
  useRidePages: (_d: unknown, _s: unknown, enabled: boolean) => ({
    data: enabled
      ? { pages: [{ rides: mockRides.pages, next: null }] }
      : undefined,
    isError: false,
    refetch: jest.fn(),
    fetchNextPage: jest.fn(),
    isFetchingNextPage: false,
    isFetchNextPageError: false,
  }),
  useRideTrack: (_d: unknown, window: unknown) => ({
    data:
      window && !mockRides.trackError
        ? { points: mockRides.track, summary: null }
        : undefined,
    isError: mockRides.trackError,
    isPending: !window,
    refetch: mockRefetch.track,
  }),
  useRideEvents: (_d: unknown, window: unknown) => ({
    data: window
      ? {
          items: mockRides.events,
          total: mockRides.eventsTotal ?? mockRides.events.length,
        }
      : undefined,
    isError: mockRides.eventsError,
    refetch: mockRefetch.events,
  }),
  useRideMonth: () => ({
    data: mockRides.month,
    isError: false,
    refetch: jest.fn(),
  }),
  useRideAt: (_d: unknown, atMs: number | null) => ({
    data: atMs === null ? undefined : mockRides.at,
    isPending: false,
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
const mount = async () => {
  const r = render(
    <QueryClientProvider client={makeQueryClient()}>
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
let backHandler: (() => boolean) | null;
let backSpy: ReturnType<typeof jest.spyOn>;
let appSpy: ReturnType<typeof jest.spyOn>;
let appListener: ((s: string) => void) | null;
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
    track: [],
    events: [],
    eventsTotal: null,
    trackError: false,
    eventsError: false,
    month: [],
    at: null,
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
  springSpy.mockRestore();
  jest.clearAllMocks();
  jest.useRealTimers();
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
    expect(m(mockMap.setTrack).mock.calls.pop()![0]).toHaveLength(3);
    r.unmount();
    expect(deactivateKeepAwake).toHaveBeenCalledWith("map-riding");
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
      expect.objectContaining({ kind: "event", label: "2" }),
      expect.objectContaining({ kind: "event", label: undefined }),
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
});
