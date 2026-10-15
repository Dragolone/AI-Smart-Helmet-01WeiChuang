// 扫码绑定页：相机权限（问 / 去设置）、扫到带绑定码的码直接绑（找到 → 正在绑定 → 成功 / 没绑上）、
// 只印了设备号的旧码转去手输、不是绑定码 / 刚绑过的提示、没绑上之后同一个码的处理（断网类可立刻重扫）、
// 手动输入、Android 返回键、成功后「完成」用 dismissAll 回去（绝不 push 标签页）。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { DevicePublic } from "@helmet/shared";
import { AccessibilityInfo, BackHandler, Linking } from "react-native";
import { act } from "react-test-renderer";
import { mockRouter, routerState } from "@/__tests__/helpers/native-mocks";
import {
  isHost,
  makeQueryClient,
  render,
  type Rendered,
} from "@/__tests__/helpers/render";
import { ApiRequestError } from "@/api/client";
import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { useThemeStore } from "@/stores/theme-store";
import BindDeviceScreen from "@/app/bind-device";

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
  NotificationFeedbackType: { Success: "success", Error: "error" },
}));
jest.mock("expo-image", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { Image: (props: Record<string, unknown>) => h("ExpoImage", props) };
});
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
const mockCamera = {
  perm: { granted: true, canAskAgain: true } as {
    granted: boolean;
    canAskAgain: boolean;
  } | null,
  request: jest.fn(() => Promise.resolve()),
};
jest.mock("expo-camera", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return {
    CameraView: (props: Record<string, unknown>) => h("CameraView", props),
    useCameraPermissions: () => [mockCamera.perm, mockCamera.request],
  };
});
jest.mock("@/api/devices", () => ({ devicesApi: { bind: jest.fn() } }));
jest.mock("@/api/contacts", () => ({ contactsApi: { list: jest.fn() } }));
const mockNotify = { value: "granted" as string | null };
jest.mock("@/hooks/use-safety", () => ({
  useNotifyPermission: () => mockNotify.value,
}));

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const QR = "helmet://bind?d=helmet_x&c=12345678";
let qc: QueryClient;
let back: ((...a: unknown[]) => boolean) | null = null;
let announce: ReturnType<typeof jest.spyOn>;
let backSpy: ReturnType<typeof jest.spyOn>;
let srSpy: ReturnType<typeof jest.spyOn>;
let srSub: ReturnType<typeof jest.spyOn>;

const mount = () =>
  render(
    <QueryClientProvider client={qc}>
      <BindDeviceScreen />
    </QueryClientProvider>,
  );
const camera = (r: Rendered) =>
  r.root.findAll((n) => isHost(n, "CameraView"))[0];
const scan = (r: Rendered, data: string) =>
  act(() => {
    (camera(r).props.onBarcodeScanned as (e: { data: string }) => void)({
      data,
    });
  });
const flush = async (ms = 0) => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
};
const P = {
  id: tr("device.deviceIdPlaceholder"),
  code: tr("device.bindCodePlaceholder"),
};

beforeEach(() => {
  jest.useFakeTimers();
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  routerState.params = {};
  routerState.focused = true;
  mockCamera.perm = { granted: true, canAskAgain: true };
  mockNotify.value = "granted";
  qc = makeQueryClient();
  m(contactsApi.list).mockImplementation(() => Promise.resolve([{ id: "c1" }]));
  m(devicesApi.bind).mockImplementation((...a: unknown[]) =>
    Promise.resolve({
      deviceId: (a[0] as { deviceId: string }).deviceId,
    } as DevicePublic),
  );
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
  srSpy = jest
    .spyOn(AccessibilityInfo, "isScreenReaderEnabled")
    .mockImplementation(() => Promise.resolve(false));
  srSub = jest
    .spyOn(AccessibilityInfo, "addEventListener")
    .mockImplementation(() => ({ remove: jest.fn() }) as never);
  backSpy = jest
    .spyOn(BackHandler, "addEventListener")
    .mockImplementation((_e, h) => {
      back = h as (...a: unknown[]) => boolean;
      return { remove: jest.fn() } as never;
    });
});
afterEach(() => {
  announce.mockRestore();
  srSpy.mockRestore();
  srSub.mockRestore();
  backSpy.mockRestore();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("相机权限", () => {
  it("还能问：说明 + 允许；不能再问了：去设置；手动输入照常可用", () => {
    mockCamera.perm = { granted: false, canAskAgain: true };
    let r = mount();
    expect(r.allText()).toContain(tr("scan.permissionTitle"));
    r.press(tr("scan.allow"));
    expect(mockCamera.request).toHaveBeenCalled();
    expect(camera(r)).toBeUndefined();
    mockCamera.perm = { granted: false, canAskAgain: false };
    const settings = jest
      .spyOn(Linking, "openSettings")
      .mockImplementation(() => Promise.resolve());
    r = mount();
    r.press(tr("ble.onboarding.go"));
    expect(settings).toHaveBeenCalled();
    r.press(tr("scan.manual"));
    expect(r.texts()).toContain(tr("bind.manualTitle"));
    settings.mockRestore();
  });

  it("关闭按钮回上一页", () => {
    const r = mount();
    act(() =>
      r.root
        .find(
          (n) =>
            typeof n.type !== "string" &&
            n.props.accessibilityLabel === tr("common.close") &&
            typeof n.props.onPress === "function",
        )
        .props.onPress(),
    );
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe("扫码绑定", () => {
  it("带绑定码的码：只认二维码；找到 → 正在绑定 → 成功（写进列表缓存）；「完成」用 dismissAll 回去", async () => {
    qc.setQueryData(["devices"], [{ deviceId: "h0" }]);
    const r = mount();
    expect(camera(r).props.barcodeScannerSettings).toEqual({
      barcodeTypes: ["qr"],
    });
    expect(r.allText()).toContain(tr("scan.hint"));
    scan(r, QR);
    expect(r.allText()).toContain(tr("scan.recognized"));
    expect(devicesApi.bind).toHaveBeenCalledWith({
      deviceId: "helmet_x",
      bindCode: "12345678",
    });
    // 识别后不再接相机的回调（相机还会把同一个码报几遍）
    expect(camera(r).props.onBarcodeScanned).toBeUndefined();
    await flush(320);
    expect(r.allText()).toContain(tr("bind.binding"));
    await flush(500);
    expect(r.allText()).toContain(tr("device.bindSuccess"));
    expect(r.allText()).toContain("helmet_x");
    expect(announce).toHaveBeenCalledWith(tr("device.bindSuccess"));
    expect(qc.getQueryData(["devices"])).toEqual([
      { deviceId: "h0" },
      { deviceId: "helmet_x" },
    ]);
    // 安全设置不缺东西时不提「去做安全设置」
    expect(r.allText()).not.toContain(tr("bind.doneBodySafety"));
    r.press(tr("bind.finish"));
    expect(mockRouter.dismissAll).toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("安全设置还差东西（通知被拒 / 没联系人）：成功卡片提一句", async () => {
    mockNotify.value = "denied";
    const r = mount();
    scan(r, QR);
    await flush(900);
    expect(r.allText()).toContain(tr("bind.doneBodySafety"));
  });

  it("没绑上（绑定码错）：说明原因；重新扫码时码还在镜头里就提示刚才没绑上、不立刻再失败一次", async () => {
    m(devicesApi.bind).mockImplementation(() =>
      Promise.reject(new ApiRequestError(400, { code: "BIND_CODE_INVALID" })),
    );
    const r = mount();
    scan(r, QR);
    await flush(900);
    expect(r.allText()).toContain(tr("bind.failedTitle"));
    expect(r.allText()).toContain(tr("error.bindCodeInvalid"));
    r.press(tr("bind.rescan"));
    scan(r, QR);
    expect(devicesApi.bind).toHaveBeenCalledTimes(1);
    expect(r.allText()).toContain(tr("scan.justFailed"));
    // 码离开镜头 1.5 秒以上再对上来才算重新扫
    await flush(2000);
    scan(r, QR);
    expect(devicesApi.bind).toHaveBeenCalledTimes(2);
  });

  it("没连上服务器那类失败：点重新扫码时镜头还对着同一个码就立刻认它", async () => {
    m(devicesApi.bind)
      .mockImplementationOnce(() =>
        Promise.reject(new TypeError("Network request failed")),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ deviceId: "helmet_x" } as DevicePublic),
      );
    const r = mount();
    scan(r, QR);
    await flush(900);
    expect(r.allText()).toContain(tr("error.network"));
    r.press(tr("bind.rescan"));
    scan(r, QR);
    expect(devicesApi.bind).toHaveBeenCalledTimes(2);
  });

  it("没绑上时改成手输：面板里填好扫到的设备号和绑定码", async () => {
    m(devicesApi.bind).mockImplementation(() =>
      Promise.reject(
        new ApiRequestError(409, { code: "DEVICE_ALREADY_BOUND" }),
      ),
    );
    const r = mount();
    scan(r, QR);
    await flush(900);
    r.press(tr("scan.typeInstead"));
    expect(r.valueOf(P.id)).toBe("helmet_x");
    expect(r.valueOf(P.code)).toBe("12345678");
  });

  it("只印了设备号的旧码：打开手输面板并填好设备号，说明绑定码要手输", () => {
    const r = mount();
    scan(r, "helmet_old01");
    expect(r.texts()).toContain(tr("bind.manualTitle"));
    expect(r.valueOf(P.id)).toBe("helmet_old01");
    expect(r.valueOf(P.code)).toBe("");
    expect(devicesApi.bind).not.toHaveBeenCalled();
  });

  it("不是绑定码：取景框下面提示，2.2 秒后收起；继续扫", async () => {
    const r = mount();
    scan(r, "https://example.com/not-a-helmet?x=1");
    expect(r.allText()).toContain(tr("scan.notBindCode"));
    await flush(2300);
    expect(r.allText()).toContain(tr("scan.hint"));
  });

  it("这次刚绑上的那一顶：再扫到提示「刚绑过」，不再绑一次", async () => {
    const r = mount();
    scan(r, QR);
    await flush(900);
    r.press(tr("bind.another"));
    await flush(2000);
    scan(r, QR);
    expect(r.allText()).toContain(tr("scan.alreadyBound"));
    expect(devicesApi.bind).toHaveBeenCalledTimes(1);
  });

  it("面板开着时不扫码", () => {
    const r = mount();
    r.press(tr("scan.manual"));
    expect(camera(r).props.onBarcodeScanned).toBeUndefined();
  });
});

describe("手动输入", () => {
  it("带参数打开：面板开着、填好设备号和绑定码，等用户自己点绑定", () => {
    routerState.params = { deviceId: "helmet_p", bindCode: "87654321" };
    const r = mount();
    expect(r.valueOf(P.id)).toBe("helmet_p");
    expect(r.valueOf(P.code)).toBe("87654321");
    expect(devicesApi.bind).not.toHaveBeenCalled();
  });

  it("manual=1 一进来就开着面板；绑不上原因写在面板里、填的留着；绑上收起面板显示成功", async () => {
    routerState.params = { manual: "1" };
    m(devicesApi.bind).mockImplementationOnce(() =>
      Promise.reject(new ApiRequestError(404, { code: "DEVICE_NOT_FOUND" })),
    );
    const r = mount();
    r.type(P.id, " helmet_m ");
    r.type(P.code, "11112222");
    r.press(tr("device.bindAction"));
    await flush();
    expect(r.allText()).toContain(tr("error.deviceNotFound"));
    expect(r.valueOf(P.id)).toBe(" helmet_m ");
    r.press(tr("device.bindAction"));
    await flush();
    expect(devicesApi.bind).toHaveBeenLastCalledWith({
      deviceId: "helmet_m",
      bindCode: "11112222",
    });
    expect(r.allText()).toContain(tr("device.bindSuccess"));
    expect(r.texts()).not.toContain(tr("bind.manualTitle"));
  });

  it("面板往下拖过 90 收起，拖不够弹回", () => {
    routerState.params = { manual: "1" };
    const r = mount();
    const pan = r.root.find((n) => isHost(n, "GestureDetector")).props
      .gesture as {
      handlers: Record<string, (e?: unknown) => void>;
    };
    act(() => pan.handlers.onUpdate({ translationY: 40 }));
    act(() => pan.handlers.onEnd());
    expect(r.texts()).toContain(tr("bind.manualTitle"));
    act(() => pan.handlers.onUpdate({ translationY: 120 }));
    act(() => pan.handlers.onEnd());
    expect(r.texts()).not.toContain(tr("bind.manualTitle"));
  });
});

describe("Android 返回键", () => {
  it("面板开着先收面板；成功卡片上等于完成；没绑上的卡片上等于重新扫码；其余交给系统", async () => {
    routerState.params = { manual: "1" };
    const r = mount();
    let handled = false;
    act(() => {
      handled = back!();
    });
    expect(handled).toBe(true);
    expect(r.texts()).not.toContain(tr("bind.manualTitle"));
    act(() => {
      handled = back!();
    });
    expect(handled).toBe(false);
    m(devicesApi.bind).mockImplementationOnce(() =>
      Promise.reject(new ApiRequestError(400, { code: "BIND_CODE_INVALID" })),
    );
    scan(r, QR);
    await flush(900);
    act(() => {
      handled = back!();
    });
    expect(handled).toBe(true);
    expect(r.allText()).toContain(tr("scan.hint"));
    await flush(2000);
    scan(r, "helmet://bind?d=helmet_y&c=12345678");
    await flush(900);
    act(() => {
      back!();
    });
    expect(mockRouter.dismissAll).toHaveBeenCalled();
  });
});
