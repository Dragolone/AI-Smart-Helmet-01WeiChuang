// 首次连接引导里华为 / 荣耀那一步（应用启动管理）：只在华为系 Android 且原生可用时出现；系统不给查这项设置，
// 「做过」= 点过「去设置」又回到了 App，并持久化；原生打不开（none）时回到前台不算做过。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as SecureStore from "expo-secure-store";
import { Alert, AppState, Platform } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useLocaleStore } from "@/i18n";
import { SECURE_KEYS } from "@/services/secure-keys";
import { useBleStore } from "@/stores/ble-store";
import { useLaunchSettingsStore } from "@/stores/launch-settings-store";
import { useBleOnboardingSteps } from "../ble-onboarding";

jest.mock("@/global.css", () => ({}));
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {},
}));
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

const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn((k: string) =>
    Promise.resolve(mockStore.get(k) ?? null),
  ),
  setItemAsync: jest.fn((k: string, v: string) => {
    mockStore.set(k, v);
    return Promise.resolve();
  }),
  deleteItemAsync: jest.fn((k: string) => {
    mockStore.delete(k);
    return Promise.resolve();
  }),
}));

const mockDevice = { manufacturer: "HUAWEI", brand: "HUAWEI" };
jest.mock("expo-device", () => ({
  __esModule: true,
  get manufacturer() {
    return mockDevice.manufacturer;
  },
  get brand() {
    return mockDevice.brand;
  },
}));

// 工厂在 import 阶段就会跑，这时下面的 const 还没赋值：一律经函数 / getter 惰性取值
const mockLink = {
  available: true,
  launchResult: "launch" as "launch" | "details" | "none",
  openCalls: 0,
};
jest.mock("helmet-link-service", () => ({
  HelmetLinkService: {
    get available() {
      return mockLink.available;
    },
    isIgnoringBatteryOptimizations: () => true,
    requestIgnoreBatteryOptimizations: () => undefined,
    openAppLaunchSettings: () => {
      mockLink.openCalls += 1;
      return mockLink.launchResult;
    },
  },
}));

type Steps = ReturnType<typeof useBleOnboardingSteps>;

let alertChoice: "go" | "cancel" = "go";
const alerts: { title: string; body: string }[] = [];
const listeners: ((state: string) => void)[] = [];
let tree: ReactTestRenderer | null = null;
const originalOS = Platform.OS;

/** 同一屏上两处同时用（设备页状态卡 + 首次连接引导）：一处点过，另一处也要跟着变 */
async function mount() {
  let latest: Steps = [];
  let other: Steps = [];
  function Probe() {
    latest = useBleOnboardingSteps();
    return null;
  }
  function OtherProbe() {
    other = useBleOnboardingSteps();
    return null;
  }
  await act(async () => {
    tree = create(
      <>
        <Probe />
        <OtherProbe />
      </>,
    );
  });
  // 等 SecureStore 的读取落地
  await act(async () => undefined);
  return {
    keys: () => latest.map((st) => st.key),
    launch: () => latest.find((st) => st.key === "launch"),
    otherLaunch: () => other.find((st) => st.key === "launch"),
  };
}
const foreground = async () => {
  await act(async () => {
    for (const l of listeners) l("active");
  });
};

beforeEach(() => {
  (Platform as { OS: string }).OS = "android";
  mockStore.clear();
  mockDevice.manufacturer = "HUAWEI";
  mockDevice.brand = "HUAWEI";
  mockLink.launchResult = "launch";
  mockLink.openCalls = 0;
  listeners.length = 0;
  jest.spyOn(AppState, "addEventListener").mockImplementation(((
    _type: string,
    fn: (state: string) => void,
  ) => {
    listeners.push(fn);
    return { remove: () => undefined };
  }) as never);
  useBleStore.setState({ adapter: "on" });
  useLaunchSettingsStore.setState({ acked: null, pending: false });
  useLocaleStore.setState({ locale: "zh-CN" });
  alertChoice = "go";
  alerts.length = 0;
  // 跳系统设置前的说明框：按 alertChoice 点「去设置」或「取消」
  jest.spyOn(Alert, "alert").mockImplementation(((
    title: string,
    body?: string,
    buttons?: { text?: string; style?: string; onPress?: () => void }[],
  ) => {
    alerts.push({ title, body: body ?? "" });
    const pick =
      alertChoice === "go"
        ? buttons?.find((b) => b.style !== "cancel")
        : buttons?.find((b) => b.style === "cancel");
    pick?.onPress?.();
  }) as never);
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
  (Platform as { OS: string }).OS = originalOS;
});

describe("首次连接引导：华为「应用启动管理」那一步", () => {
  it("华为 Android：第四步出现、没做过 → 未完成；点「去设置」调原生，回到前台才算做过并持久化", async () => {
    const m = await mount();
    expect(m.keys()).toEqual([
      "bluetooth",
      "permission",
      "whitelist",
      "launch",
    ]);
    expect(m.launch()?.done).toBe(false);
    expect(m.launch()?.blocking).toBe(false);

    // 没点过「去设置」就回到前台：不算
    await foreground();
    expect(m.launch()?.done).toBe(false);

    act(() => m.launch()?.action());
    // 先弹说明框（跳过去以后 App 里的说明就看不到了），点「去设置」才调原生
    expect(alerts).toHaveLength(1);
    // 路径按华为 P30 Pro 实测：应用信息 → 耗电详情 → 启动管理（10-18）
    expect(alerts[0].body).toContain("耗电详情");
    expect(alerts[0].body).toContain("启动管理");
    expect(alerts[0].body).toContain("允许后台活动");
    expect(mockLink.openCalls).toBe(1);
    expect(m.launch()?.done).toBe(false);

    await foreground();
    expect(m.launch()?.done).toBe(true);
    expect(m.otherLaunch()?.done).toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      SECURE_KEYS.launchSettingsAcked,
      "1",
    );
  });

  it("之前做过（存过标记）：一进来就是完成", async () => {
    mockStore.set(SECURE_KEYS.launchSettingsAcked, "1");
    const m = await mount();
    expect(m.launch()?.done).toBe(true);
  });

  it("说明框里点「取消」：不跳设置，回到前台也不算做过", async () => {
    alertChoice = "cancel";
    const m = await mount();
    act(() => m.launch()?.action());
    expect(alerts).toHaveLength(1);
    expect(mockLink.openCalls).toBe(0);
    await foreground();
    expect(m.launch()?.done).toBe(false);
  });

  it("原生打不开（none）：回到前台也不算做过", async () => {
    mockLink.launchResult = "none";
    const m = await mount();
    act(() => m.launch()?.action());
    await foreground();
    expect(m.launch()?.done).toBe(false);
  });

  it("荣耀也算华为系；小米 / iOS 没有这一步", async () => {
    mockDevice.manufacturer = "HONOR";
    mockDevice.brand = "HONOR";
    expect((await mount()).launch()).toBeDefined();
    act(() => tree?.unmount());

    mockDevice.manufacturer = "Xiaomi";
    mockDevice.brand = "Redmi";
    expect((await mount()).launch()).toBeUndefined();
    act(() => tree?.unmount());

    mockDevice.manufacturer = "HUAWEI";
    (Platform as { OS: string }).OS = "ios";
    expect((await mount()).launch()).toBeUndefined();
  });

  it("没授权时第 1 步「打开蓝牙」查不到：标成未知、不当成没开去催（10-21 边界审查）；授了权才按真实开关算", async () => {
    useBleStore.setState({ adapter: "unauthorized" });
    let latest: Steps = [];
    function Probe() {
      latest = useBleOnboardingSteps();
      return null;
    }
    await act(async () => {
      tree = create(<Probe />);
    });
    const bt = () => latest.find((st) => st.key === "bluetooth");
    const perm = () => latest.find((st) => st.key === "permission");
    expect(bt()).toMatchObject({ done: false, unknown: true, blocking: false });
    expect(perm()).toMatchObject({ done: false, blocking: true });

    await act(async () => useBleStore.setState({ adapter: "off" }));
    expect(bt()).toMatchObject({ done: false, unknown: false, blocking: true });
    expect(perm()?.done).toBe(true);

    await act(async () => useBleStore.setState({ adapter: "on" }));
    expect(bt()).toMatchObject({ done: true, unknown: false });
  });
});
