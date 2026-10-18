// 设备详情页：头盔已不在本账号下的空态、状态卡（蓝牙行各状态与入口 / 在线行 / 低电量 / 后台受限）、
// 常用控制（前照灯 + 蜂鸣音量：拖动中节流即时下发并封顶、超过高音量线松手要确认、取消要把拖动前的值还回去；
// 乐观值只认自己那条命令的回执、没发出去 / 35 秒兜底回落；头盔没确认过音量时按「待确认的默认值」显示）、
// 设置分类入口与摘要、重命名、解除绑定。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CommandPublic, DevicePublic } from "@helmet/shared";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Text,
} from "react-native";
import { act } from "react-test-renderer";
import {
  mockNavigation,
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
import { ApiRequestError } from "@/api/client";
import { devicesApi } from "@/api/devices";
import { Tappable } from "@/components/tappable";
import { Colors } from "@/constants/theme";
import { useDeviceSettings } from "@/hooks/use-device-settings";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { retryBleLink } from "@/services/ble-link";
import { useBleStore } from "@/stores/ble-store";
import { useThemeStore } from "@/stores/theme-store";
import DeviceDetailScreen from "@/app/device/[deviceId]";

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
  selectionAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light" },
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve("1")),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));
const mockLink = { whitelisted: true };
jest.mock("helmet-link-service", () => ({
  HelmetLinkService: {
    available: true,
    isIgnoringBatteryOptimizations: () => mockLink.whitelisted,
    requestIgnoreBatteryOptimizations: jest.fn(),
  },
}));
jest.mock("@/services/ble-link", () => ({ retryBleLink: jest.fn() }));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("@/api/devices", () => ({
  devicesApi: {
    status: jest.fn(),
    detail: jest.fn(),
    batteryHistory: jest.fn(),
    rename: jest.fn(),
    unbind: jest.fn(),
    putSettings: jest.fn(),
  },
}));
jest.mock("@/hooks/use-device-settings", () => ({
  useDeviceSettings: jest.fn(),
}));

/** 只有一个按钮的提示统一走 services/notice 的 showNotice：第三个参数是一个「确定」 */
const NOTICE_OK = [{ text: translate("common.confirm", undefined, "zh-CN") }];
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const command = (over: Partial<CommandPublic>): CommandPublic => ({
  commandId: "v1",
  deviceId: "h1",
  type: "set_config",
  params: { volume: 40 },
  status: "pending",
  issuedAt: "2026-10-17T01:00:00.000Z",
  deliveredAt: null,
  ackResult: null,
  errorCode: null,
  executedAt: null,
  ...over,
});
/** 下发成功：交回新建的命令（页面按 commandId 认自己那条的回执） */
const sendOk = () =>
  jest.fn((key: string, value: unknown) =>
    Promise.resolve(command({ commandId: "v1", params: { [key]: value } })),
  );
const settings = {
  values: { volume: 60 } as Record<string, unknown> | undefined,
  lastCommand: null as CommandPublic | null,
  sending: false,
  send: sendOk() as jest.Mock,
  isError: false,
  error: null,
};
const STATUS = {
  online: true,
  battery: 80,
  charging: false,
  lastSeenAt: new Date().toISOString(),
};
const mount = (qc = makeQueryClient()) =>
  render(
    <QueryClientProvider client={qc}>
      <DeviceDetailScreen />
    </QueryClientProvider>,
  );
/** 音量滑杆的手势记录器（页面上唯一一个 Exclusive 手势） */
const volumeGesture = (r: Rendered) =>
  (
    r.root.find((n) => isHost(n, "GestureDetector")).props
      .gesture as RecordedGesture
  ).gestures!;

let alert: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  routerState.params = { deviceId: "h1" };
  useBleStore.setState({
    adapter: "on",
    links: { h1: { phase: "connected", eventsReceived: 0, resent: 0 } },
  });
  Object.assign(settings, {
    values: { volume: 60 },
    lastCommand: null,
    sending: false,
    send: sendOk(),
  });
  m(useDeviceSettings).mockImplementation(() => settings);
  m(devicesApi.status).mockImplementation(() => Promise.resolve(STATUS));
  m(devicesApi.detail).mockImplementation(() =>
    Promise.resolve({ deviceId: "h1", name: "通勤头盔" } as DevicePublic),
  );
  m(devicesApi.batteryHistory).mockImplementation(() =>
    Promise.resolve({ points: [], to: new Date().toISOString() }),
  );
  m(devicesApi.putSettings).mockImplementation(() => Promise.resolve({}));
  mockLink.whitelisted = true;
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
});
afterEach(() => {
  alert.mockRestore();
  act(() => useBleStore.setState({ adapter: "unknown", links: {} }));
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("头盔已不在本账号下", () => {
  it("状态或详情 404 DEVICE_NOT_FOUND：只给空态和回设备页，不画改名 / 控制 / 解绑", async () => {
    m(devicesApi.status).mockImplementation(() =>
      Promise.reject(new ApiRequestError(404, { code: "DEVICE_NOT_FOUND" })),
    );
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.goneTitle")));
    expect(r.allText()).toContain(tr("device.goneBody", { id: "h1" }));
    // 没有「解除绑定」按钮、没有常用控制（说明里那句「可能已在别的手机上解除绑定」不算）
    expect(r.texts()).not.toContain(tr("device.unbind"));
    expect(r.allText()).not.toContain(tr("device.quickControls"));
    r.press(tr("device.goneBack"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/");
  });
});

describe("状态卡", () => {
  it("名字 + 编号；在线、电量；蓝牙已连接；最近上报时间", async () => {
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain("通勤头盔"));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.status.online")),
    );
    const text = r.allText();
    expect(r.texts()).toContain("h1");
    expect(text).toContain(tr("devices.battery"));
    expect(text).toContain(tr("device.status.bleConnected"));
    expect(text).not.toContain(tr("device.status.offlineHint"));
  });

  it("离线：电量标题改口为上次电量、写离线说明；从没上报写从未上报", async () => {
    m(devicesApi.status).mockImplementation(() =>
      Promise.resolve({ ...STATUS, online: false, lastSeenAt: null }),
    );
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.status.offline")),
    );
    expect(r.allText()).toContain(tr("device.status.lastBattery"));
    expect(r.allText()).toContain(tr("device.status.offlineHint"));
    expect(r.allText()).toContain(tr("device.neverReported"));
  });

  it("拿到过在线、之后刷新失败（手机断网）：不再写「设备在线」，改写状态待确认、上次上报，和首页一致", async () => {
    const qc = makeQueryClient();
    const r = mount(qc);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.status.online")),
    );
    m(devicesApi.status).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    await act(async () => {
      await qc
        .refetchQueries({ queryKey: ["device-status", "h1"] })
        .catch(() => undefined);
    });
    await waitFor(() =>
      expect(r.allText()).toContain(tr("devices.link.unknown")),
    );
    const text = r.allText();
    expect(text).not.toContain(tr("device.status.online"));
    expect(text).toContain(tr("device.status.lastBattery"));
    expect(text).toContain(
      tr("device.status.lastReportOffline", { ago: "" }).replace(/\s*$/, ""),
    );
    // 恢复联网、刷新成功：回到在线
    m(devicesApi.status).mockImplementation(() => Promise.resolve(STATUS));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["device-status", "h1"] });
    });
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.status.online")),
    );
    expect(r.allText()).not.toContain(tr("devices.link.unknown"));
  });

  it("电量低且没在充电：提醒充电；在充电就不催", async () => {
    m(devicesApi.status).mockImplementation(() =>
      Promise.resolve({ ...STATUS, battery: 15 }),
    );
    let r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.status.batteryLow")),
    );
    m(devicesApi.status).mockImplementation(() =>
      Promise.resolve({ ...STATUS, battery: 15, charging: true }),
    );
    r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("devices.charging")));
    expect(r.allText()).not.toContain(tr("device.status.batteryLow"));
  });

  it("蓝牙没连上：写原因并可重试；手机蓝牙关着：去开蓝牙；没权限：去 App 设置", async () => {
    useBleStore.setState({
      adapter: "on",
      links: { h1: { phase: "scanning", eventsReceived: 0, resent: 0 } },
    });
    let r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.ble.scanning")),
    );
    r.press(tr("device.status.retry"));
    expect(retryBleLink).toHaveBeenCalledWith("h1");
    const settingsSpy = jest
      .spyOn(Linking, "openSettings")
      .mockImplementation(() => Promise.resolve());
    act(() => useBleStore.setState({ adapter: "unauthorized" }));
    r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.status.online")),
    );
    r.press(tr("ble.onboarding.go"));
    expect(settingsSpy).toHaveBeenCalled();
    act(() => useBleStore.setState({ adapter: "off" }));
    r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.ble.off")));
    r.press(tr("ble.onboarding.go"));
    settingsSpy.mockRestore();
  });

  it("Android 后台受限（没加省电白名单）：多一行并可去设置", async () => {
    const os = Platform.OS;
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    mockLink.whitelisted = false;
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.status.backgroundLimited")),
    );
    Object.defineProperty(Platform, "OS", { value: os, configurable: true });
  });

  it("状态拉不到（非 404）：写原因，不画骨架", async () => {
    m(devicesApi.status).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("error.network")));
  });
});

describe("常用控制：蜂鸣音量", () => {
  const drag = (r: Rendered, xs: number[]) => {
    const [pan] = volumeGesture(r);
    const hit = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.props.style?.height === 40,
    );
    act(() => hit.props.onLayout({ nativeEvent: { layout: { width: 100 } } }));
    act(() => pan.handlers.onBegin({ x: xs[0] }));
    act(() => pan.handlers.onStart({ x: xs[0] }));
    for (const x of xs.slice(1)) act(() => pan.handlers.onUpdate({ x }));
    act(() => pan.handlers.onFinalize({}, true));
  };

  it("拖动中每 200 ms 即时下发一次（封顶在高音量线），松手的普通值走设置命令；拖动时关掉返回手势", async () => {
    jest.useFakeTimers();
    const r = mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    const [pan] = volumeGesture(r);
    const hit = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.props.style?.height === 40,
    );
    act(() => hit.props.onLayout({ nativeEvent: { layout: { width: 100 } } }));
    act(() => pan.handlers.onStart({ x: 60 }));
    expect(mockNavigation.setOptions).toHaveBeenCalledWith({
      gestureEnabled: false,
    });
    act(() => pan.handlers.onUpdate({ x: 70 }));
    act(() => pan.handlers.onUpdate({ x: 75 }));
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(devicesApi.putSettings).toHaveBeenCalledTimes(1);
    expect(devicesApi.putSettings).toHaveBeenLastCalledWith("h1", {
      settings: { volume: 75 },
    });
    act(() => pan.handlers.onUpdate({ x: 95 }));
    act(() => {
      jest.advanceTimersByTime(200);
    });
    // 拖动阶段封顶在高音量线（80）
    expect(devicesApi.putSettings).toHaveBeenLastCalledWith("h1", {
      settings: { volume: 80 },
    });
    act(() => pan.handlers.onUpdate({ x: 40 }));
    act(() => pan.handlers.onFinalize({}, true));
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({
      gestureEnabled: true,
    });
    expect(settings.send).toHaveBeenCalledWith("volume", 40);
    // 松手时没发出去的中间值被丢掉，不再补发
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(devicesApi.putSettings).toHaveBeenCalledTimes(2);
  });

  it("超过高音量线松手：先确认；确认才下发", async () => {
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.volume")));
    drag(r, [60, 95]);
    expect(settings.send).not.toHaveBeenCalled();
    const [title, , buttons] = alert.mock.calls[0] as [
      string,
      string,
      { onPress?: () => void }[],
    ];
    expect(title).toBe(tr("device.volumeLoudTitle"));
    await act(async () => {
      buttons[1].onPress!();
      await Promise.resolve();
    });
    expect(settings.send).toHaveBeenCalledWith("volume", 95);
  });

  it("超过线又取消：拖动中已经即时下发过中间值的，把拖动前的音量发回去；没发过就什么都不做", async () => {
    jest.useFakeTimers();
    const r = mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    const [pan] = volumeGesture(r);
    const hit = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.props.style?.height === 40,
    );
    act(() => hit.props.onLayout({ nativeEvent: { layout: { width: 100 } } }));
    act(() => pan.handlers.onStart({ x: 60 }));
    act(() => pan.handlers.onUpdate({ x: 90 }));
    act(() => {
      jest.advanceTimersByTime(200);
    });
    act(() => pan.handlers.onFinalize({}, true));
    let buttons = alert.mock.calls[0][2] as { onPress?: () => void }[];
    await act(async () => {
      buttons[0].onPress!();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(settings.send).toHaveBeenCalledWith("volume", 60);
    // 第二次：拖得很快、没来得及即时下发
    settings.send.mockClear();
    act(() => pan.handlers.onStart({ x: 60 }));
    act(() => pan.handlers.onUpdate({ x: 99 }));
    act(() => pan.handlers.onFinalize({}, true));
    buttons = alert.mock.calls[1][2] as { onPress?: () => void }[];
    act(() => buttons[0].onPress!());
    expect(settings.send).not.toHaveBeenCalled();
  });

  it("乐观值：松手后显示新值并灰显「正在应用」，服务端值跟上后点亮；失败回落服务端值", async () => {
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.volume")));
    drag(r, [60, 40]);
    expect(r.allText()).toContain(`40% · ${tr("device.applying")}`);
    await act(async () => {
      await Promise.resolve();
    });
    settings.values = { volume: 40 };
    r.rerender(
      <QueryClientProvider client={makeQueryClient()}>
        <DeviceDetailScreen />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(r.allText()).toContain("40%"));
    expect(r.allText()).not.toContain(tr("device.applying"));
  });
});

describe("常用控制：音量乐观值只认自己那条命令", () => {
  const drag = (r: Rendered, xs: number[]) => {
    const [pan] = volumeGesture(r);
    const hit = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.props.style?.height === 40,
    );
    act(() => hit.props.onLayout({ nativeEvent: { layout: { width: 100 } } }));
    act(() => pan.handlers.onBegin({ x: xs[0] }));
    act(() => pan.handlers.onStart({ x: xs[0] }));
    for (const x of xs.slice(1)) act(() => pan.handlers.onUpdate({ x }));
    act(() => pan.handlers.onFinalize({}, true));
  };
  const again = (r: Rendered, qc: ReturnType<typeof makeQueryClient>) =>
    r.rerender(
      <QueryClientProvider client={qc}>
        <DeviceDetailScreen />
      </QueryClientProvider>,
    );
  /** 音量那一行的数字（「60%」或「40% · 正在应用设置…」） */
  const volumeText = (r: Rendered) =>
    r
      .texts()
      .find((x) => /^\d+%( · .*)?$/.test(x) && x !== "10%" && x !== "100%");
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  it("别的项的命令失败了不撤音量的乐观值；自己那条离线 / 失败才回落到头盔确认过的值", async () => {
    const qc = makeQueryClient();
    const r = mount(qc);
    await waitFor(() => expect(r.allText()).toContain(tr("device.volume")));
    drag(r, [60, 40]);
    await flush();
    expect(settings.send).toHaveBeenCalledWith("volume", 40);
    expect(volumeText(r)).toBe(`40% · ${tr("device.applying")}`);
    // 最近一条是前照灯的命令、失败了：和音量无关
    settings.lastCommand = command({
      commandId: "l1",
      params: { light: 2 },
      status: "failed",
    });
    again(r, qc);
    expect(volumeText(r)).toBe(`40% · ${tr("device.applying")}`);
    // 自己那条判了离线：回落 60，并在音量下面说没送达（头盔此刻在线，所以是「上次没送达」）
    settings.lastCommand = command({ commandId: "v1", status: "offline" });
    again(r, qc);
    expect(volumeText(r)).toBe("60%");
    expect(r.allText()).toContain(tr("device.cmd.expiredRetry"));
  });

  it("自己那条已生效：点亮新值，下面写已生效", async () => {
    const qc = makeQueryClient();
    const r = mount(qc);
    await waitFor(() => expect(r.allText()).toContain(tr("device.volume")));
    drag(r, [60, 40]);
    await flush();
    settings.values = { volume: 40 };
    settings.lastCommand = command({ commandId: "v1", status: "success" });
    again(r, qc);
    expect(volumeText(r)).toBe("40%");
    expect(r.allText()).toContain(tr("device.cmd.success"));
  });

  it("没发出去（请求失败，已弹窗）：立刻回落，不灰着", async () => {
    settings.send = jest.fn(() => Promise.resolve(null));
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.volume")));
    drag(r, [60, 40]);
    await flush();
    expect(volumeText(r)).toBe("60%");
  });

  it("一直看不到自己那条的回执（被别的命令挤掉）：35 秒兜底回落", async () => {
    jest.useFakeTimers();
    const r = mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    drag(r, [60, 40]);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(34_000);
    });
    expect(volumeText(r)).toBe(`40% · ${tr("device.applying")}`);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_100);
    });
    expect(volumeText(r)).toBe("60%");
  });

  it("头盔回来在线时，没送达的那条改说「上次没送达，请重试」（和其他设置项一致）", async () => {
    settings.lastCommand = command({ status: "offline" });
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.status.online")),
    );
    expect(r.allText()).toContain(tr("device.cmd.expiredRetry"));
    expect(r.allText()).not.toContain(tr("device.cmd.offline"));
  });

  it("头盔从没报过音量：80% 用次要色并说明是默认值；还没拉到设置时只是次要色、不说这句", async () => {
    settings.values = {};
    let r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.volume")));
    expect(volumeText(r)).toBe("80%");
    const num = r.root
      .findAllByType(Text)
      .find((x) => /^80%/.test(String([].concat(x.props.children).join(""))))!;
    expect(flat(num.props.style).color).toBe(Colors.dark.textSecondary);
    expect(r.allText()).toContain(tr("device.unconfirmedDefault"));
    settings.values = undefined;
    r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.volume")));
    expect(volumeText(r)).toBe("80%");
    expect(r.allText()).not.toContain(tr("device.unconfirmedDefault"));
  });

  it("头盔没确认过音量时拖过高音量线又取消：不知道原来是多少，不拿默认值去「还原」", async () => {
    jest.useFakeTimers();
    settings.values = {};
    const r = mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    const [pan] = volumeGesture(r);
    const hit = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.props.style?.height === 40,
    );
    act(() => hit.props.onLayout({ nativeEvent: { layout: { width: 100 } } }));
    act(() => pan.handlers.onStart({ x: 50 }));
    act(() => pan.handlers.onUpdate({ x: 70 }));
    act(() => {
      jest.advanceTimersByTime(200);
    });
    // 拖动中即时下发过中间值 70
    expect(devicesApi.putSettings).toHaveBeenLastCalledWith("h1", {
      settings: { volume: 70 },
    });
    act(() => pan.handlers.onUpdate({ x: 95 }));
    act(() => pan.handlers.onFinalize({}, true));
    const buttons = alert.mock.calls[0][2] as { onPress?: () => void }[];
    act(() => buttons[0].onPress!());
    expect(settings.send).not.toHaveBeenCalled();
  });

  it("头盔没报过音量、从显示的默认 80 往上拖过线又取消：拖动中不把 80 发出去，什么都不下发（10-17 模拟器实测曾下发 80）", async () => {
    jest.useFakeTimers();
    settings.values = {};
    const r = mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    const [pan] = volumeGesture(r);
    const hit = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.props.style?.height === 40,
    );
    act(() => hit.props.onLayout({ nativeEvent: { layout: { width: 100 } } }));
    act(() => pan.handlers.onStart({ x: 80 }));
    act(() => pan.handlers.onUpdate({ x: 90 }));
    act(() => pan.handlers.onUpdate({ x: 100 }));
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(devicesApi.putSettings).not.toHaveBeenCalled();
    act(() => pan.handlers.onFinalize({}, true));
    const buttons = alert.mock.calls[0][2] as { onPress?: () => void }[];
    act(() => buttons[0].onPress!());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(devicesApi.putSettings).not.toHaveBeenCalled();
    expect(settings.send).not.toHaveBeenCalled();
  });

  it("拖到一半被系统打断：返回手势恢复，还没发出去的中间值不再发，也不交出松手值", async () => {
    jest.useFakeTimers();
    const r = mount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    const [pan] = volumeGesture(r);
    const hit = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        typeof n.props.onLayout === "function" &&
        n.props.style?.height === 40,
    );
    act(() => hit.props.onLayout({ nativeEvent: { layout: { width: 100 } } }));
    act(() => pan.handlers.onStart({ x: 60 }));
    act(() => pan.handlers.onUpdate({ x: 30 }));
    act(() => pan.handlers.onFinalize({}, false));
    expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({
      gestureEnabled: true,
    });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(devicesApi.putSettings).not.toHaveBeenCalled();
    expect(settings.send).not.toHaveBeenCalled();
    expect(volumeText(r)).toBe("60%");
  });
});

describe("设置入口与摘要", () => {
  it("摘要只用头盔确认过的值拼；一项都没有时用固定说明", async () => {
    settings.values = {
      volume: 60,
      fallDetect: true,
      radar: false,
      vibration: 2,
      buzzer: true,
    };
    let r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.sum.fallOn")));
    expect(r.allText()).toContain(
      `${tr("device.sum.fallOn")} · ${tr("device.sum.radarOff")}`,
    );
    expect(r.allText()).toContain(
      `${tr("device.sum.vibration", { level: tr("device.level.medium") })} · ${tr("device.sum.buzzerOn")}`,
    );
    settings.values = undefined;
    r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.cat.safetySummary")),
    );
    expect(r.allText()).toContain(tr("device.cat.alertsSummary"));
  });

  it("四个入口各跳各的", async () => {
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.cat.safety")));
    r.press(tr("device.cat.safety"));
    r.press(tr("device.cat.alerts"));
    r.press(tr("device.videoPreview"));
    r.press(tr("device.cat.about"));
    expect(mockRouter.navigate.mock.calls.map((c) => c[0])).toEqual([
      "/device-safety/h1",
      "/device-alerts/h1",
      "/video-preview",
      "/device-about/h1",
    ]);
  });

  it("前照灯改档走设置命令", async () => {
    settings.values = { volume: 60, light: 0 };
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain(tr("device.set.light")));
    r.press(tr("device.level.lightHigh"));
    expect(settings.send).toHaveBeenCalledWith("light", 2);
  });
});

describe("重命名与解除绑定", () => {
  it("重命名：草稿带上现在的名字；成功后刷新详情和列表，画完勾关弹层", async () => {
    jest.useFakeTimers();
    m(devicesApi.rename).mockImplementation(() => Promise.resolve({}));
    const qc = makeQueryClient();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    const r = mount(qc);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("device.renameTitle"),
        )
        .props.onPress(),
    );
    const input = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        typeof n.props.onChangeText === "function" &&
        n.props.value === "通勤头盔",
    );
    act(() => input.props.onChangeText("骑行头盔"));
    r.press(tr("common.save"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    expect(devicesApi.rename).toHaveBeenCalledWith("h1", { name: "骑行头盔" });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["device-detail", "h1"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["devices"] });
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(
      r.root
        .findAllByType(Modal)
        .some(
          (x) =>
            x.props.visible &&
            x.props.onRequestClose &&
            !x.props.statusBarTranslucent,
        ),
    ).toBe(false);
  });

  it("重命名失败：弹窗说明原因", async () => {
    m(devicesApi.rename).mockImplementation(() =>
      Promise.reject(new ApiRequestError(400, { code: "VALIDATION_FAILED" })),
    );
    const r = mount();
    await waitFor(() => expect(r.allText()).toContain("通勤头盔"));
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("device.renameTitle"),
        )
        .props.onPress(),
    );
    r.press(tr("common.save"));
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        tr("device.renameFailed"),
        tr("error.validationFailed"),
        NOTICE_OK,
      ),
    );
  });

  it("解除绑定：确认里写用户起的名字；成功后先从列表缓存拿掉再返回，按钮换成转圈", async () => {
    m(devicesApi.unbind).mockImplementation(() => Promise.resolve());
    const qc = makeQueryClient();
    qc.setQueryData(["devices"], [{ deviceId: "h1" }, { deviceId: "h2" }]);
    const r = mount(qc);
    await waitFor(() => expect(r.allText()).toContain("通勤头盔"));
    r.press(tr("device.unbind"));
    const [, body, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { onPress?: () => void }[],
    ];
    expect(body).toBe(tr("device.unbindBody", { id: "通勤头盔" }));
    act(() => buttons[1].onPress!());
    expect(r.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(qc.getQueryData(["devices"])).toEqual([{ deviceId: "h2" }]);
  });

  it("解除绑定失败：恢复按钮并弹窗", async () => {
    m(devicesApi.unbind).mockImplementation(() =>
      Promise.reject(new ApiRequestError(404, { code: "DEVICE_NOT_FOUND" })),
    );
    m(devicesApi.detail).mockImplementation(() =>
      Promise.resolve({ deviceId: "h1", name: null } as DevicePublic),
    );
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.status.online")),
    );
    r.press(tr("device.unbind"));
    const [, body, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { onPress?: () => void }[],
    ];
    expect(body).toBe(tr("device.unbindBody", { id: "h1" }));
    act(() => buttons[1].onPress!());
    await waitFor(() =>
      expect(alert).toHaveBeenLastCalledWith(
        tr("device.unbindFailed"),
        tr("error.deviceNotFound"),
        NOTICE_OK,
      ),
    );
    expect(r.allText()).toContain(tr("device.unbind"));
  });
});
