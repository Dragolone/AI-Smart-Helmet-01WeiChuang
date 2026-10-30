// 行程回放（读数那一行的各种说法、事件条、播放 / 倍速 / 进度条）和首次连接引导（三步状态、
// 第一次进详情页弹一次、关掉 / 做完就记住、硬阻塞横幅）。引导只测不改（蓝牙链路相关）。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { LocationPoint } from "@helmet/shared";
import * as SecureStore from "expo-secure-store";
import { AppState, Linking, Modal, Platform, Text } from "react-native";
import { act } from "react-test-renderer";

import { flat, render, type Rendered } from "@/__tests__/helpers/render";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { shortTime } from "@/i18n/format";
import { useBleStore, type BleAdapterState } from "@/stores/ble-store";
import { useThemeStore } from "@/stores/theme-store";
import {
  BleBlockerBanner,
  BleFirstConnectGuide,
  useBleOnboardingSteps,
} from "../ble-onboarding";
import { RideReplay, type ReplayEvent } from "../map/ride-replay";
import { Tappable } from "../tappable";

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
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));
const mockLink = { available: true, whitelisted: false, request: jest.fn() };
jest.mock("helmet-link-service", () => ({
  HelmetLinkService: {
    get available() {
      return mockLink.available;
    },
    isIgnoringBatteryOptimizations: () => mockLink.whitelisted,
    requestIgnoreBatteryOptimizations: () => mockLink.request(),
  },
}));

const dark = Colors.dark;
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");

beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
});
afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("RideReplay", () => {
  const pt = (min: number, over: Partial<LocationPoint> = {}): LocationPoint =>
    ({
      timestamp: new Date(2026, 9, 16, 8, min).toISOString(),
      latitude: 22.5,
      longitude: 113.9,
      speed: 5,
      altitude: null,
      ...over,
    }) as LocationPoint;
  const points = [pt(0), pt(10, { altitude: 123.4 }), pt(20)];
  const events: ReplayEvent[] = [
    { key: "e1", index: 1, time: "08:10", name: "碰撞风险", count: 1 },
    { key: "e2", index: 2, time: "08:20", name: "障碍物", count: 3 },
  ];
  const props = () => ({
    status: "ready" as const,
    points,
    clipped: false,
    events: [] as ReplayEvent[],
    moreEvents: 0,
    eventsFailed: false,
    activeEventKey: null as string | null,
    replayIdx: null as number | null,
    playing: false,
    speed: 2 as const,
    onTogglePlay: jest.fn(),
    onCycleSpeed: jest.fn(),
    onSeek: jest.fn(),
    onRetry: jest.fn(),
    onRetryEvents: jest.fn(),
  });
  const readout = (r: Rendered) => r.texts()[0];
  const control = (r: Rendered, label: string) =>
    r.root.find(
      (n) => n.type === Tappable && n.props.accessibilityLabel === label,
    );

  it("读数那一行：加载中 / 失败（带重试）/ 点不够 / 有备注时用备注", () => {
    const p = props();
    expect(readout(render(<RideReplay {...p} status="loading" />))).toBe(
      tr("map.ride.trackLoading"),
    );
    const r = render(<RideReplay {...p} status="error" />);
    expect(readout(r)).toBe(tr("map.ride.trackFailed"));
    r.press(tr("map.retry"));
    expect(p.onRetry).toHaveBeenCalled();
    expect(readout(render(<RideReplay {...p} points={[points[0]]} />))).toBe(
      tr("map.ride.trackEmpty"),
    );
    const noted = render(
      <RideReplay {...p} status="error" note="正在找这个时刻的行程…" />,
    );
    expect(readout(noted)).toBe("正在找这个时刻的行程…");
    expect(noted.allText()).not.toContain(tr("map.retry"));
  });

  it("还没回放：提示怎么用；超过 24 小时的写只显示最后 24 小时；两端时刻", () => {
    let r = render(<RideReplay {...props()} />);
    expect(readout(r)).toBe(tr("map.ride.hint"));
    expect(r.texts()).toContain(shortTime(points[0].timestamp, "zh-CN"));
    expect(r.texts()).toContain(shortTime(points[2].timestamp, "zh-CN"));
    r = render(<RideReplay {...props()} clipped />);
    expect(readout(r)).toBe(tr("map.ride.clipped"));
    r = render(<RideReplay {...props()} status="loading" />);
    expect(r.texts().filter((x) => x === "--:--")).toHaveLength(2);
  });

  it("回放中：读数写时刻和时速（有海拔加海拔），进度条在对应位置、气泡写时刻", () => {
    let r = render(<RideReplay {...props()} replayIdx={0} />);
    expect(readout(r)).toBe(
      tr("map.ride.readout", {
        time: shortTime(points[0].timestamp, "zh-CN"),
        speed: 18,
      }),
    );
    r = render(<RideReplay {...props()} replayIdx={1} />);
    expect(readout(r)).toBe(
      tr("map.ride.readoutAlt", {
        time: shortTime(points[1].timestamp, "zh-CN"),
        speed: 18,
        alt: 123,
      }),
    );
    const seek = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityRole === "adjustable",
    );
    expect(seek.props.accessibilityValue).toEqual({
      now: 50,
      min: 0,
      max: 100,
    });
    expect(
      r.texts().filter((x) => x === shortTime(points[1].timestamp, "zh-CN"))
        .length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("事件条：一条 / 多条合并的写法；点了跳到那一处；停在事件上时读数换成事件、用提醒色；没标全写另有几条", () => {
    const p = props();
    const r = render(
      <RideReplay
        {...p}
        events={events}
        moreEvents={4}
        activeEventKey="e2"
        replayIdx={2}
      />,
    );
    expect(r.allText()).toContain(
      tr("map.ride.eventChip", { time: "08:10", name: "碰撞风险" }),
    );
    expect(r.allText()).toContain(
      tr("map.ride.eventChipMany", { time: "08:20", name: "障碍物", n: 3 }),
    );
    expect(r.allText()).toContain(tr("map.ride.moreEvents", { n: 4 }));
    expect(readout(r)).toBe(
      tr("map.ride.eventAtMany", { time: "08:20", name: "障碍物", n: 3 }),
    );
    expect(flat(r.root.findAllByType(Text)[0].props.style).color).toBe(
      dark.warning,
    );
    r.press(tr("map.ride.eventChip", { time: "08:10", name: "碰撞风险" }));
    expect(p.onSeek).toHaveBeenCalledWith(1);
    const single = render(
      <RideReplay {...p} events={events} activeEventKey="e1" />,
    );
    expect(readout(single)).toBe(
      tr("map.ride.eventAt", { time: "08:10", name: "碰撞风险" }),
    );
  });

  it("事件条和进度条上的点：碰撞这类用红色、障碍物用提醒色，和安全记录列表一个口径（10-31）", () => {
    const p = props();
    const r = render(
      <RideReplay
        {...p}
        events={[{ ...events[0], danger: true }, events[1]]}
      />,
    );
    const colorOf = (s: string) =>
      flat(
        r.root.find(
          (n) => (n.type as unknown) === "Text" && n.children.join("") === s,
        ).props.style,
      ).color;
    expect(
      colorOf(tr("map.ride.eventChip", { time: "08:10", name: "碰撞风险" })),
    ).toBe(dark.danger);
    expect(
      colorOf(
        tr("map.ride.eventChipMany", { time: "08:20", name: "障碍物", n: 3 }),
      ),
    ).toBe(dark.warning);
    const marks = r.root
      .findAll(
        (n) =>
          (n.type as unknown) === "View" &&
          flat(n.props.style).borderColor === dark.backgroundElement &&
          String(flat(n.props.style).left ?? "").endsWith("%"),
      )
      .map((n) => flat(n.props.style).backgroundColor);
    // 最后一个是进度条上的圆点，不是事件
    expect(marks).toEqual([dark.danger, dark.warning, dark.brand]);
    // 停在碰撞事件上时，读数也用红色（提醒色那种情况见上一条用例）
    const onDanger = render(
      <RideReplay
        {...p}
        events={[{ ...events[0], danger: true }, events[1]]}
        activeEventKey="e1"
      />,
    );
    expect(flat(onDanger.root.findAllByType(Text)[0].props.style).color).toBe(
      dark.danger,
    );
  });

  it("事件没取到：说出来并可重试（不让人以为这一趟什么都没发生）", () => {
    const p = props();
    const r = render(<RideReplay {...p} eventsFailed />);
    r.press(tr("map.ride.eventsFailed"));
    expect(p.onRetryEvents).toHaveBeenCalled();
  });

  it("播放 / 暂停、倍速；轨迹不可用时控制区禁用", () => {
    const p = props();
    let r = render(<RideReplay {...p} />);
    act(() => control(r, tr("map.play")).props.onPress());
    act(() => control(r, tr("map.ride.speedA11y", { n: 2 })).props.onPress());
    expect(p.onTogglePlay).toHaveBeenCalled();
    expect(p.onCycleSpeed).toHaveBeenCalled();
    expect(r.texts()).toContain("×2");
    r = render(<RideReplay {...p} playing />);
    expect(r.icons()).toContain("pause");
    r = render(<RideReplay {...p} status="error" />);
    expect(control(r, tr("map.play")).props.disabled).toBe(true);
  });

  it("进度条：按下 / 拖动换算到第几个点（两端各内缩圆点半径），轨迹不可用时不响应", () => {
    const p = props();
    let r = render(<RideReplay {...p} />);
    const seek = () =>
      r.root.find(
        (n) =>
          typeof n.type === "string" &&
          n.props.accessibilityRole === "adjustable",
      );
    act(() =>
      seek().props.onLayout({ nativeEvent: { layout: { width: 222 } } }),
    );
    expect(seek().props.onStartShouldSetResponder()).toBe(true);
    expect(seek().props.onResponderTerminationRequest()).toBe(false);
    act(() =>
      seek().props.onResponderGrant({ nativeEvent: { locationX: 111 } }),
    );
    expect(p.onSeek).toHaveBeenLastCalledWith(1);
    act(() =>
      seek().props.onResponderMove({ nativeEvent: { locationX: 500 } }),
    );
    expect(p.onSeek).toHaveBeenLastCalledWith(2);
    act(() => seek().props.onResponderMove({ nativeEvent: { locationX: 0 } }));
    expect(p.onSeek).toHaveBeenLastCalledWith(0);
    p.onSeek.mockClear();
    r = render(<RideReplay {...p} status="loading" />);
    act(() =>
      seek().props.onResponderGrant({ nativeEvent: { locationX: 111 } }),
    );
    expect(p.onSeek).not.toHaveBeenCalled();
  });

  it("读数里的时速过一遍漂移把关：超过 200 km/h、负数、NaN 写「—」", () => {
    for (const speed of [80, -1, Number.NaN]) {
      const drift = [pt(0, { speed }), pt(10), pt(20)];
      const r = render(
        <RideReplay {...props()} points={drift} replayIdx={0} />,
      );
      expect(readout(r)).toBe(
        tr("map.ride.readout", {
          time: shortTime(drift[0].timestamp, "zh-CN"),
          speed: "—",
        }),
      );
    }
    const alt = [pt(0, { speed: 99, altitude: 50 }), pt(10)];
    expect(
      readout(render(<RideReplay {...props()} points={alt} replayIdx={0} />)),
    ).toBe(
      tr("map.ride.readoutAlt", {
        time: shortTime(alt[0].timestamp, "zh-CN"),
        speed: "—",
        alt: 50,
      }),
    );
  });

  it("失败时可以换一句话（查不到这一刻在哪一趟），仍带重试", () => {
    const p = props();
    const r = render(
      <RideReplay {...p} status="error" failText="行程查询失败" />,
    );
    expect(readout(r)).toBe("行程查询失败");
    r.press(tr("map.retry"));
    expect(p.onRetry).toHaveBeenCalled();
  });

  it("读屏：进度条接得住增 / 减（每次全程的 5%，短轨迹至少一个点，夹在两头）；轨迹不可用时不响应", () => {
    const p = props();
    const seekOf = (r: Rendered) =>
      r.root.find(
        (n) =>
          typeof n.type === "string" &&
          n.props.accessibilityRole === "adjustable",
      );
    const act11y = (r: Rendered, actionName: string) =>
      act(() =>
        seekOf(r).props.onAccessibilityAction({ nativeEvent: { actionName } }),
      );
    // 3 个点：5% 不到一个点，按一个点走；没开始回放从起点算
    let r = render(<RideReplay {...p} />);
    expect(seekOf(r).props.accessibilityActions).toEqual([
      { name: "increment" },
      { name: "decrement" },
    ]);
    act11y(r, "increment");
    expect(p.onSeek).toHaveBeenLastCalledWith(1);
    act11y(r, "decrement");
    expect(p.onSeek).toHaveBeenLastCalledWith(0);
    r = render(<RideReplay {...p} replayIdx={2} />);
    act11y(r, "increment");
    expect(p.onSeek).toHaveBeenLastCalledWith(2);
    // 41 个点：一步走 2 个点
    const long = Array.from({ length: 41 }, (_, i) => pt(i));
    r = render(<RideReplay {...p} points={long} replayIdx={10} />);
    act11y(r, "increment");
    expect(p.onSeek).toHaveBeenLastCalledWith(12);
    act11y(r, "decrement");
    expect(p.onSeek).toHaveBeenLastCalledWith(8);
    p.onSeek.mockClear();
    act11y(r, "activate");
    expect(p.onSeek).not.toHaveBeenCalled();
    r = render(<RideReplay {...p} status="loading" />);
    act11y(r, "increment");
    expect(p.onSeek).not.toHaveBeenCalled();
  });
});

describe("首次连接引导", () => {
  const original = Platform.OS;
  const setAdapter = (a: BleAdapterState) =>
    act(() => useBleStore.setState({ adapter: a }));
  // jest 里 RN 的 AppState.addEventListener 不返回订阅对象：给一个能 remove 的
  let appState: ReturnType<typeof jest.spyOn>;
  let appListener: ((s: string) => void) | null = null;
  beforeEach(() => {
    mockLink.available = true;
    mockLink.whitelisted = false;
    useBleStore.setState({ adapter: "unknown" });
    appState = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_e, l) => {
        appListener = l as (s: string) => void;
        return { remove: jest.fn() } as never;
      });
  });
  afterEach(() => {
    Object.defineProperty(Platform, "OS", {
      value: original,
      configurable: true,
    });
    act(() => useBleStore.setState({ adapter: "unknown" }));
    appState.mockRestore();
  });

  it("三步的状态：蓝牙开没开、权限给没给；Android 才有白名单那一步", () => {
    let steps: ReturnType<typeof useBleOnboardingSteps> = [];
    function Probe() {
      steps = useBleOnboardingSteps();
      return null;
    }
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    useBleStore.setState({ adapter: "off" });
    render(<Probe />);
    expect(steps.map((s) => [s.key, s.done, s.blocking])).toEqual([
      ["bluetooth", false, true],
      ["permission", true, false],
    ]);
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    setAdapter("unauthorized");
    render(<Probe />);
    expect(steps.map((s) => [s.key, s.done, s.blocking])).toEqual([
      ["bluetooth", false, false],
      ["permission", false, true],
      ["whitelist", false, false],
    ]);
    steps[2].action();
    expect(mockLink.request).toHaveBeenCalled();
  });

  it("白名单状态在回到前台时重查", () => {
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    let steps: ReturnType<typeof useBleOnboardingSteps> = [];
    function Probe() {
      steps = useBleOnboardingSteps();
      return null;
    }
    useBleStore.setState({ adapter: "on" });
    render(<Probe />);
    expect(steps[2].done).toBe(false);
    mockLink.whitelisted = true;
    act(() => appListener!("background"));
    expect(steps[2].done).toBe(false);
    act(() => appListener!("active"));
    expect(steps[2].done).toBe(true);
  });

  it("去设置：Android 蓝牙走系统蓝牙面板（失败退回 App 设置）；iOS 只能到 App 设置；权限一律到 App 设置", async () => {
    const intent = jest
      .spyOn(Linking, "sendIntent")
      .mockImplementation(() => Promise.reject(new Error("no")));
    const settings = jest
      .spyOn(Linking, "openSettings")
      .mockImplementation(() => Promise.resolve());
    let steps: ReturnType<typeof useBleOnboardingSteps> = [];
    function Probe() {
      steps = useBleOnboardingSteps();
      return null;
    }
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    useBleStore.setState({ adapter: "off" });
    render(<Probe />);
    await act(async () => {
      steps[0].action();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(intent).toHaveBeenCalledWith("android.settings.BLUETOOTH_SETTINGS");
    expect(settings).toHaveBeenCalledTimes(1);
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    await act(async () => {
      steps[0].action();
      steps[1].action();
    });
    expect(settings).toHaveBeenCalledTimes(3);
    intent.mockRestore();
    settings.mockRestore();
  });

  it("弹窗：等进场动画走完、读到没关过、还有没做的步才弹；关掉就记住", async () => {
    jest.useFakeTimers();
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    useBleStore.setState({ adapter: "off" });
    const r = render(<BleFirstConnectGuide />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(r.root.findByType(Modal).props.visible).toBe(false);
    act(() => {
      jest.advanceTimersByTime(450);
    });
    expect(r.root.findByType(Modal).props.visible).toBe(true);
    expect(r.allText()).toContain(tr("ble.onboarding.bluetoothHint"));
    expect(r.allText()).not.toContain(tr("ble.onboarding.permissionHint"));
    expect(r.icons()).toContain("checkmark");
    r.press(tr("keepalive.ok"));
    expect(r.root.findByType(Modal).props.visible).toBe(false);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "ble_onboarding_dismissed",
      "1",
    );
  });

  it("关过的不再弹；蓝牙状态还没确定 / 没有蓝牙硬件不弹；三步都做完记为看过", async () => {
    jest.useFakeTimers();
    (SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(() =>
      Promise.resolve("1"),
    );
    useBleStore.setState({ adapter: "off" });
    let r = render(<BleFirstConnectGuide />);
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(500);
    });
    expect(r.root.findByType(Modal).props.visible).toBe(false);
    r.unmount();
    for (const a of ["unknown", "unsupported"] as const) {
      setAdapter(a);
      r = render(<BleFirstConnectGuide />);
      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(500);
      });
      expect(r.root.findByType(Modal).props.visible).toBe(false);
      r.unmount();
    }
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    setAdapter("on");
    r = render(<BleFirstConnectGuide />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(500);
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "ble_onboarding_dismissed",
      "1",
    );
    expect(r.root.findByType(Modal).props.visible).toBe(false);
  });

  it("读存储失败按没关过；三种关法（右上角、遮罩、返回键）都记住", async () => {
    jest.useFakeTimers();
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    (SecureStore.getItemAsync as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("locked")),
    );
    useBleStore.setState({ adapter: "unauthorized" });
    const r = render(<BleFirstConnectGuide />);
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(450);
    });
    expect(r.root.findByType(Modal).props.visible).toBe(true);
    r.press(tr("ble.onboarding.go"));
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("common.close"),
        )
        .props.onPress(),
    );
    expect(r.root.findByType(Modal).props.visible).toBe(false);
    act(() => r.root.findByType(Modal).props.onRequestClose());
    expect(
      (SecureStore.setItemAsync as jest.Mock).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("硬阻塞横幅：只在蓝牙关 / 权限拒时出现，文案各不相同，点了回调", () => {
    const onPress = jest.fn();
    let r = render(<BleBlockerBanner onPress={onPress} />);
    expect(r.tree.toJSON()).toBeNull();
    setAdapter("off");
    r = render(<BleBlockerBanner onPress={onPress} />);
    expect(r.texts()).toEqual([tr("ble.banner.off")]);
    r.press(tr("ble.banner.off"));
    expect(onPress).toHaveBeenCalled();
    setAdapter("unauthorized");
    expect(r.texts()).toEqual([tr("ble.banner.unauthorized")]);
    setAdapter("on");
    expect(r.tree.toJSON()).toBeNull();
  });

  it("硬阻塞横幅：安卓 12 以下没权限时说位置信息（系统设置里没有单独的蓝牙权限）", () => {
    const os = Platform.OS;
    const version = Platform.Version;
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    Object.defineProperty(Platform, "Version", {
      value: 29,
      configurable: true,
    });
    try {
      setAdapter("unauthorized");
      const r = render(<BleBlockerBanner onPress={jest.fn()} />);
      expect(r.texts()).toEqual([tr("ble.banner.unauthorizedLocation")]);
    } finally {
      Object.defineProperty(Platform, "OS", { value: os, configurable: true });
      Object.defineProperty(Platform, "Version", {
        value: version,
        configurable: true,
      });
    }
  });
});
