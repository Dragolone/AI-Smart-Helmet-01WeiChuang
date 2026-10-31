// 实时视频预览页（只测不改：它和求救上报争网络，见 10-15 评审 F-1）：
// 连头盔热点的几条路（自动连 / 要手动连 / 连失败 / 连上时人已离开）、首帧与没画面提示、播放器出错与断流、
// 截图（成功 / 失败 / 没回调 / 不支持 / 没权限）、iOS 拒过本地网络权限时的提示，以及什么时候必须把热点还回去：
// 求救入队、退后台（连热点途中的系统弹窗除外）、失焦（被倒计时页盖住）、卸载、出错。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  Animated as RNAnimated,
  AppState,
  Linking,
  Platform,
} from "react-native";
import { act } from "react-test-renderer";
import { routerState } from "@/__tests__/helpers/native-mocks";
import { isHost, render, type Rendered } from "@/__tests__/helpers/render";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { useThemeStore } from "@/stores/theme-store";
import VideoPreviewScreen from "@/app/video-preview";
import { ToastHost } from "@/components/toast";

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
jest.mock("@/hooks/use-keep-awake-safe", () => ({
  useKeepAwakeSafe: jest.fn(),
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
const mockSos: ((type: string) => void)[] = [];
jest.mock("@/services/ble-relay-uplink", () => ({
  flushRelayQueue: jest.fn(() => Promise.resolve()),
  onSosRelayEvent: (l: (type: string) => void) => {
    mockSos.push(l);
    return () => mockSos.splice(mockSos.indexOf(l), 1);
  },
}));
const mockWifi = {
  available: true,
  programmatic: true,
  connect:
    jest.fn<
      (ssid: string, pass: string, ms: number, o?: unknown) => Promise<void>
    >(),
  release: jest.fn(),
  bind: jest.fn(() => true),
  openSettings: jest.fn(),
  saveImage: jest.fn<(uri: string) => Promise<void>>(() => Promise.resolve()),
  lost: [] as (() => void)[],
};
jest.mock("helmet-wifi", () => ({
  HelmetWifi: {
    get available() {
      return mockWifi.available;
    },
    canConnectProgrammatically: () => mockWifi.programmatic,
    connect: (...a: [string, string, number, unknown]) =>
      mockWifi.connect(...a),
    release: () => mockWifi.release(),
    bindToWifi: () => mockWifi.bind(),
    openWifiSettings: () => mockWifi.openSettings(),
    saveImage: (uri: string) => mockWifi.saveImage(uri),
    onWifiLost: (l: () => void) => {
      mockWifi.lost.push(l);
      return { remove: () => undefined };
    },
  },
}));
const mockFiles = { exists: true, deleted: [] as string[] };
jest.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache/" } },
  File: class {
    uri: string;
    constructor(a: { uri?: string } | string, b?: string) {
      this.uri = typeof a === "string" ? a : `${a.uri}${b}`;
    }
    get exists() {
      return mockFiles.exists;
    }
    delete() {
      mockFiles.deleted.push(this.uri);
    }
  },
}));
const mockPlayer = { snapshot: jest.fn() };
jest.mock("react-native-vlc-media-player/VLCPlayer", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const VLCPlayer = React.forwardRef(function VLCPlayer(
    props: Record<string, unknown>,
    ref,
  ) {
    React.useImperativeHandle(ref, () => ({
      snapshot: (p: string) => mockPlayer.snapshot(p),
    }));
    return React.createElement("VLCPlayer", props);
  });
  return { __esModule: true, default: VLCPlayer };
});

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const SSID = "X821cam";
let appListener: ((s: string) => void) | null = null;
let appSub: ReturnType<typeof jest.spyOn>;
let timing: ReturnType<typeof jest.spyOn>;
let resolveJoin: () => void = () => undefined;
let rejectJoin: (e: unknown) => void = () => undefined;

const mount = () =>
  render(
    <>
      <VideoPreviewScreen />
      <ToastHost />
    </>,
  );
const player = (r: Rendered) =>
  r.root.findAll((n) => isHost(n, "VLCPlayer"))[0];
const join = async () => {
  await act(async () => {
    resolveJoin();
    await Promise.resolve();
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  routerState.params = {};
  routerState.focused = true;
  Object.assign(mockWifi, { available: true, programmatic: true, lost: [] });
  mockWifi.connect.mockImplementation(
    () =>
      new Promise<void>((res, rej) => {
        resolveJoin = res;
        rejectJoin = rej;
      }),
  );
  mockFiles.exists = true;
  mockFiles.deleted = [];
  mockSos.length = 0;
  // 轻提示的 RN Animated：start 时直接跳到终值（不依赖 jest 里 Animated 的计时）
  timing = jest.spyOn(RNAnimated, "timing").mockImplementation(
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
  appSub = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_e, l) => {
      appListener = l as (s: string) => void;
      return { remove: jest.fn() } as never;
    });
});
afterEach(() => {
  appSub.mockRestore();
  timing.mockRestore();
  jest.clearAllMocks();
  jest.useRealTimers();
  routerState.focused = true;
});

describe("连头盔热点", () => {
  it("自动连：先写正在连哪个热点；连上后挂播放器（RTSP + 预设参数），首帧后去掉遮罩并能截图", async () => {
    const r = mount();
    expect(r.allText()).toContain(tr("video.joining", { ssid: SSID }));
    expect(r.allText()).toContain(tr("video.joiningHint"));
    expect(mockWifi.connect).toHaveBeenCalledWith(SSID, "Aa123456", 30_000, {
      wpa3: false,
    });
    await join();
    const p = player(r);
    expect((p.props.source as { uri: string }).uri).toBe(
      "rtsp://192.168.176.1:8554/ch0",
    );
    expect(r.allText()).toContain(tr("video.connecting"));
    act(() => (p.props.onPlaying as () => void)());
    expect(r.allText()).not.toContain(tr("video.connecting"));
    expect(r.allText()).toContain(tr("video.snapshot"));
    expect(r.allText()).toContain(tr("video.note.hotspot", { ssid: SSID }));
  });

  it("连上后 5 秒还没画面：提示检查 Wi-Fi，并给重新连接", async () => {
    const r = mount();
    await join();
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(r.allText()).toContain(tr("video.stalled", { ssid: SSID }));
    r.press(tr("video.retry"));
    expect(r.allText()).toContain(tr("video.joining", { ssid: SSID }));
    expect(mockWifi.connect).toHaveBeenCalledTimes(2);
  });

  it("连失败：写原因（用户取消）、把热点还回去、可重新连接", async () => {
    const r = mount();
    await act(async () => {
      rejectJoin({ code: "USER_DENIED" });
      await Promise.resolve();
    });
    expect(r.allText()).toContain(tr("video.err.denied"));
    expect(mockWifi.release).toHaveBeenCalled();
    expect(r.allText()).toContain(tr("video.retry"));
  });

  it("系统不支持自动连：引导手动连；Android 多一个去设置；连上了继续，没连上提示先连", () => {
    const os = Platform.OS;
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    mockWifi.programmatic = false;
    const r = mount();
    expect(r.allText()).toContain(
      tr("video.manual", { ssid: SSID, pass: "Aa123456" }),
    );
    r.press(tr("video.manual.openSettings"));
    expect(mockWifi.openSettings).toHaveBeenCalled();
    mockWifi.bind.mockReturnValueOnce(false);
    r.press(tr("video.manual.continue"));
    expect(r.allText()).toContain(tr("video.err.noWifi", { ssid: SSID }));
    r.press(tr("video.manual.continue"));
    expect(player(r)).toBeTruthy();
    Object.defineProperty(Platform, "OS", { value: os, configurable: true });
  });

  it("没有 Wi-Fi 原生模块（模拟器）：跳过连热点直接拉流", () => {
    mockWifi.available = false;
    const r = mount();
    expect(mockWifi.connect).not.toHaveBeenCalled();
    expect(player(r)).toBeTruthy();
  });

  it("连上那一刻人已经离开页面（失焦）：拿到的热点立刻还回去", async () => {
    const r = mount();
    routerState.focused = false;
    r.rerender(
      <>
        <VideoPreviewScreen />
        <ToastHost />
      </>,
    );
    mockWifi.release.mockClear();
    await join();
    expect(mockWifi.release).toHaveBeenCalled();
  });

  it("连热点途中离开、很快又回来：第二次连接已经在用热点，第一次迟到的结果不去还热点", async () => {
    const el = () => (
      <>
        <VideoPreviewScreen />
        <ToastHost />
      </>
    );
    const r = mount();
    const first = resolveJoin;
    routerState.focused = false;
    r.rerender(el());
    routerState.focused = true;
    r.rerender(el());
    expect(mockWifi.connect).toHaveBeenCalledTimes(2);
    mockWifi.release.mockClear();
    await act(async () => {
      first();
      await Promise.resolve();
    });
    expect(mockWifi.release).not.toHaveBeenCalled();
    await join();
    expect(player(r)).toBeTruthy();
  });

  it("连热点途中离开页面后才报失败：页面已经暂停，不再显示失败", async () => {
    const r = mount();
    routerState.focused = false;
    r.rerender(
      <>
        <VideoPreviewScreen />
        <ToastHost />
      </>,
    );
    await act(async () => {
      rejectJoin({ code: "USER_DENIED" });
      await Promise.resolve();
    });
    expect(r.allText()).not.toContain(tr("video.err.denied"));
    expect(r.allText()).not.toContain(tr("video.retry"));
  });

  it("开发包的测试参数：?ssid=&pass= 换成别的热点、wpa3=1 按 WPA3 请求、?url=rtsp:// 换测试流；只给 ssid 按空密码连；不是 rtsp:// 的地址不认", async () => {
    routerState.params = {
      ssid: "测试热点",
      pass: "pw123456",
      wpa3: "1",
      url: "rtsp://10.0.0.2:8554/ch0",
    };
    let r = mount();
    expect(r.allText()).toContain(tr("video.joining", { ssid: "测试热点" }));
    expect(mockWifi.connect).toHaveBeenLastCalledWith(
      "测试热点",
      "pw123456",
      30_000,
      { wpa3: true },
    );
    await join();
    expect((player(r).props.source as { uri: string }).uri).toBe(
      "rtsp://10.0.0.2:8554/ch0",
    );
    r.unmount();

    routerState.params = { ssid: "测试热点", url: "http://10.0.0.2/ch0" };
    r = mount();
    expect(mockWifi.connect).toHaveBeenLastCalledWith("测试热点", "", 30_000, {
      wpa3: false,
    });
    await join();
    expect((player(r).props.source as { uri: string }).uri).toBe(
      "rtsp://192.168.176.1:8554/ch0",
    );
  });
});

describe("什么时候把热点还回去", () => {
  it("求救入队：同步释放热点、补传积压的中转事件、暂停并说明原因，可重新连接", async () => {
    const { flushRelayQueue } = jest.requireMock<{
      flushRelayQueue: jest.Mock;
    }>("@/services/ble-relay-uplink");
    const r = mount();
    await join();
    act(() => (player(r).props.onPlaying as () => void)());
    act(() => mockSos.forEach((l) => l("possible_fall")));
    expect(mockWifi.release).toHaveBeenCalledTimes(1);
    expect(flushRelayQueue).toHaveBeenCalled();
    expect(r.allText()).toContain(tr("video.paused.sos"));
    expect(r.root.findAll((n) => isHost(n, "VLCPlayer"))).toHaveLength(0);
    r.press(tr("video.retry"));
    expect(r.allText()).toContain(tr("video.joining", { ssid: SSID }));
  });

  it("退后台：释放并暂停，回前台自动重连；连热点途中（系统选 Wi-Fi 弹窗）的 background 不算离开", async () => {
    const r = mount();
    act(() => appListener!("background"));
    expect(mockWifi.release).not.toHaveBeenCalled();
    await join();
    act(() => appListener!("background"));
    expect(mockWifi.release).toHaveBeenCalledTimes(1);
    expect(r.allText()).toContain(tr("video.connecting"));
    act(() => appListener!("active"));
    expect(mockWifi.connect).toHaveBeenCalledTimes(2);
  });

  it("连上 2 秒后仍在后台（人按了 HOME）：照退后台处理", async () => {
    const desc = Object.getOwnPropertyDescriptor(AppState, "currentState");
    Object.defineProperty(AppState, "currentState", {
      value: "background",
      configurable: true,
    });
    mount();
    await join();
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(mockWifi.release).toHaveBeenCalledTimes(1);
    if (desc) Object.defineProperty(AppState, "currentState", desc);
    else delete (AppState as { currentState?: unknown }).currentState;
  });

  it("被别的页面盖住（失焦）：释放并暂停；回到本页重新连", async () => {
    // 每次都给一个新元素：同一个元素对象 React 会直接跳过重渲染
    const el = () => (
      <>
        <VideoPreviewScreen />
        <ToastHost />
      </>
    );
    const r = mount();
    await join();
    routerState.focused = false;
    r.rerender(el());
    expect(mockWifi.release).toHaveBeenCalledTimes(1);
    routerState.focused = true;
    r.rerender(el());
    expect(mockWifi.connect).toHaveBeenCalledTimes(2);
  });

  it("头盔 Wi-Fi 断了：报错并释放；播放器出错 / 断流也一样", async () => {
    let r = mount();
    await join();
    act(() => mockWifi.lost.forEach((l) => l()));
    expect(r.allText()).toContain(tr("video.err.wifiLost"));
    expect(mockWifi.release).toHaveBeenCalledTimes(1);
    r.unmount();
    mockWifi.release.mockClear();
    r = mount();
    await join();
    act(() => (player(r).props.onError as () => void)());
    expect(r.allText()).toContain(tr("video.err.stream"));
    expect(mockWifi.release).toHaveBeenCalledTimes(1);
  });

  it("离开页面（卸载）：释放", async () => {
    const r = mount();
    await join();
    r.unmount();
    expect(mockWifi.release).toHaveBeenCalled();
  });

  it("系统短暂打断（iOS 下拉控制中心等，inactive）：不算退后台，不释放、不暂停", async () => {
    const r = mount();
    await join();
    act(() => (player(r).props.onPlaying as () => void)());
    act(() => appListener!("inactive"));
    expect(mockWifi.release).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("video.snapshot"));
  });

  it("播放中断流（onEnd / onStopped）：写画面中断了、释放热点，可重新连接", async () => {
    const r = mount();
    await join();
    act(() => (player(r).props.onPlaying as () => void)());
    act(() => (player(r).props.onEnd as () => void)());
    expect(r.allText()).toContain(tr("video.err.streamEnded"));
    expect(mockWifi.release).toHaveBeenCalledTimes(1);
    r.press(tr("video.retry"));
    await join();
    act(() => (player(r).props.onPlaying as () => void)());
    act(() => (player(r).props.onStopped as () => void)());
    expect(r.allText()).toContain(tr("video.err.streamEnded"));
    expect(mockWifi.release).toHaveBeenCalledTimes(2);
  });

  it("播放中又收到 onPlaying（缓冲后恢复）：照常播放，首帧耗时只记一次", async () => {
    const { devLog } = jest.requireMock<{ devLog: jest.Mock }>(
      "@/services/dev-log",
    );
    const r = mount();
    await join();
    act(() => (player(r).props.onPlaying as () => void)());
    act(() => (player(r).props.onPlaying as () => void)());
    expect(r.allText()).toContain(tr("video.snapshot"));
    expect(
      devLog.mock.calls.filter((c) => String(c[1]).startsWith("首帧")),
    ).toHaveLength(1);
  });
});

describe("iOS 拒过「本地网络」权限", () => {
  const setOs = (value: string) => {
    Object.defineProperty(Platform, "OS", { value, configurable: true });
  };
  const os = Platform.OS;
  afterEach(() => setOs(os));

  it("iOS 拉流失败：除了原因再提示本地网络权限，并给去设置的按钮", async () => {
    setOs("ios");
    const settings = jest
      .spyOn(Linking, "openSettings")
      .mockImplementation(() => Promise.resolve());
    const r = mount();
    await join();
    expect(r.allText()).not.toContain(tr("video.err.localNetwork"));
    act(() => (player(r).props.onError as () => void)());
    expect(r.allText()).toContain(tr("video.err.stream"));
    expect(r.allText()).toContain(tr("video.err.localNetwork"));
    r.press(tr("video.err.openSettings"));
    expect(settings).toHaveBeenCalledTimes(1);
    // 重新连接时提示收起
    r.press(tr("video.retry"));
    expect(r.allText()).not.toContain(tr("video.err.localNetwork"));
    expect(r.allText()).not.toContain(tr("video.err.openSettings"));
    settings.mockRestore();
  });

  it("Android 拉流失败、iOS 别的错误（Wi-Fi 断开）：不提本地网络", async () => {
    setOs("android");
    let r = mount();
    await join();
    act(() => (player(r).props.onError as () => void)());
    expect(r.allText()).toContain(tr("video.err.stream"));
    expect(r.allText()).not.toContain(tr("video.err.localNetwork"));
    r.unmount();
    setOs("ios");
    r = mount();
    await join();
    act(() => mockWifi.lost.forEach((l) => l()));
    expect(r.allText()).toContain(tr("video.err.wifiLost"));
    expect(r.allText()).not.toContain(tr("video.err.openSettings"));
  });

  it("去设置打不开（系统拒绝）：吞掉，提示和按钮照常留着", async () => {
    setOs("ios");
    const settings = jest
      .spyOn(Linking, "openSettings")
      .mockImplementation(() => Promise.reject(new Error("no settings")));
    const r = mount();
    await join();
    act(() => (player(r).props.onError as () => void)());
    await act(async () => {
      r.press(tr("video.err.openSettings"));
    });
    expect(settings).toHaveBeenCalledTimes(1);
    expect(r.allText()).toContain(tr("video.err.localNetwork"));
    expect(r.allText()).toContain(tr("video.err.openSettings"));
    settings.mockRestore();
  });
});

describe("截图", () => {
  const playing = async () => {
    const r = mount();
    await join();
    act(() => (player(r).props.onPlaying as () => void)());
    return r;
  };

  it("成功：存进相册、提示已保存、删掉缓存文件", async () => {
    const r = await playing();
    r.press(tr("video.snapshot"));
    expect(mockPlayer.snapshot).toHaveBeenCalledWith(
      expect.stringMatching(/^\/cache\/helmet-shot-\d+\.png$/),
    );
    await act(async () => {
      await (player(r).props.onSnapshot as (e: unknown) => Promise<void>)({
        success: true,
      });
    });
    expect(mockWifi.saveImage).toHaveBeenCalled();
    expect(r.allText()).toContain(tr("video.snapshot.saved"));
    expect(mockFiles.deleted).toHaveLength(1);
  });

  it("原生回调说失败 / 不支持 / 没权限：各自的提示", async () => {
    const r = await playing();
    const shoot = async (e: unknown) => {
      r.press(tr("video.snapshot"));
      await act(async () => {
        await (player(r).props.onSnapshot as (x: unknown) => Promise<void>)(e);
      });
    };
    await shoot({ success: false, error: "x" });
    expect(r.allText()).toContain(tr("video.snapshot.failed"));
    mockWifi.saveImage.mockImplementationOnce(() =>
      Promise.reject({ code: "UNSUPPORTED" }),
    );
    await shoot({ success: true });
    expect(r.allText()).toContain(tr("video.snapshot.unsupported"));
    mockWifi.saveImage.mockImplementationOnce(() =>
      Promise.reject({ code: "PERMISSION_DENIED" }),
    );
    await shoot({ success: true });
    expect(r.allText()).toContain(tr("video.snapshot.denied"));
  });

  it("回调先到、文件后到（iOS 异步落盘）：等文件出现再存相册", async () => {
    const r = await playing();
    r.press(tr("video.snapshot"));
    mockFiles.exists = false;
    await act(async () => {
      (player(r).props.onSnapshot as (e: unknown) => void)({ success: true });
      await jest.advanceTimersByTimeAsync(300);
    });
    expect(mockWifi.saveImage).not.toHaveBeenCalled();
    mockFiles.exists = true;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(mockWifi.saveImage).toHaveBeenCalledTimes(1);
    expect(r.allText()).toContain(tr("video.snapshot.saved"));
  });

  it("文件 2 秒还没落盘：算失败，提示并删掉缓存", async () => {
    const r = await playing();
    r.press(tr("video.snapshot"));
    mockFiles.exists = false;
    await act(async () => {
      (player(r).props.onSnapshot as (e: unknown) => void)({ success: true });
      await jest.advanceTimersByTimeAsync(2_100);
    });
    expect(mockWifi.saveImage).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("video.snapshot.failed"));
    expect(mockFiles.deleted).toHaveLength(1);
  });

  it("存相册报不认识的错：提示截图失败", async () => {
    const r = await playing();
    mockWifi.saveImage.mockImplementationOnce(() =>
      Promise.reject({ code: "E_IO" }),
    );
    r.press(tr("video.snapshot"));
    await act(async () => {
      (player(r).props.onSnapshot as (e: unknown) => void)({ success: true });
    });
    expect(mockWifi.saveImage).toHaveBeenCalledTimes(1);
    expect(r.allText()).toContain(tr("video.snapshot.failed"));
  });

  it("成功之后 4 秒的兜底计时到点：不再提示失败", async () => {
    const r = await playing();
    r.press(tr("video.snapshot"));
    await act(async () => {
      (player(r).props.onSnapshot as (e: unknown) => void)({ success: true });
    });
    expect(r.allText()).toContain(tr("video.snapshot.saved"));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4_000);
    });
    expect(r.allText()).not.toContain(tr("video.snapshot.failed"));
  });

  it("原生侧一直没回调：4 秒后按钮不再转圈并提示失败；迟到的回调不再处理", async () => {
    const r = await playing();
    r.press(tr("video.snapshot"));
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(r.allText()).toContain(tr("video.snapshot.failed"));
    await act(async () => {
      await (player(r).props.onSnapshot as (e: unknown) => Promise<void>)({
        success: true,
      });
    });
    expect(mockWifi.saveImage).not.toHaveBeenCalled();
  });
});
