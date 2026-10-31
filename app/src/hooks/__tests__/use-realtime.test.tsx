// 实时桥钩子 useRealtimeUpdates（根布局 RealtimeBridge 里那一个）的运行时行为。原来只有按源码文本的守护测试
// （audit-realtime-wiring），接线被改错时未必拦得住；这里把钩子真的渲染出来跑。
// 用真的：QueryClient、登录 / 当前头盔两个 store、sos-sync / sos-queue / bridge-lifecycle——「同一单只拉起一次」
// 「划掉 App 后由下一个界面接手」这些约定横跨几个模块，换成替身就测不到了。
// 换成替身的：实时连接（能推消息、切连接状态的假连接）；蓝牙链路、上行队列、推送、锁屏提醒和接口这些碰原生 / 网络的。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type {
  DevicePublic,
  DeviceStatus,
  Sos,
  UserProfile,
  WsDeviceCommandData,
  WsLocationData,
  WsMessage,
} from "@helmet/shared";
import { router } from "expo-router";
import { AppState } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { makeQueryClient } from "@/__tests__/helpers/render";
import { ApiRequestError, forceRefreshTokens } from "@/api/client";
import { devicesApi } from "@/api/devices";
import { realtimeClient } from "@/api/realtime";
import { sosApi } from "@/api/sos";
import {
  checkBatteryAlert,
  resetBatteryAlerts,
} from "@/services/battery-alert";
import {
  setBleTargetNameResolver,
  setBleTargets,
  checkBlePermissions,
  startBleLink,
  stopBleLink,
} from "@/services/ble-link";
import { handleDeviceCommand } from "@/services/ble-relay";
import {
  adoptRelayUplinkOwner,
  setCriticalAcceptedHandler,
  startRelayUplink,
  stopRelayUplink,
} from "@/services/ble-relay-uplink";
import {
  loadCachedTargets,
  loadWithRetry,
  saveCachedTargets,
} from "@/services/ble-targets";
import {
  __resetBridgeLifecycleForTests,
  bridgeUi,
} from "@/services/bridge-lifecycle";
import { devLog } from "@/services/dev-log";
import { setPushArrivalHandler, startPush, stopPush } from "@/services/push";
import { whenSignInQuiet } from "@/services/sign-in-moment";
import {
  clearSosAlert,
  ensureSosAlertPermission,
  whenCountdownClearForPrompt,
  whenSosAlertPermissionAsked,
  holdPermissionPromptUntil,
  resetSosAlerts,
  setOtherSosPendingCheck,
  setSosCancelConfirmedListener,
  showSosAlertIfBackground,
} from "@/services/sos-alert";
import { sosScreen } from "@/services/sos-queue";
import { presentedSos } from "@/services/sos-sync";
import { useAuthStore } from "@/stores/auth-store";
import { useCurrentHelmetStore } from "@/stores/current-helmet-store";
import { LOCATION_WRITE_MS, useRealtimeUpdates } from "../use-realtime";

/** 假的实时连接。订阅连接状态时和真的一样先回放当前值：onReconnect 靠它把「启动时已连上」算作第一次 */
const mockWs = {
  listeners: new Set<(message: WsMessage) => void>(),
  stateListeners: new Set<(connected: boolean) => void>(),
  connected: false,
};
jest.mock("@/api/realtime", () => ({
  realtimeClient: {
    start: jest.fn(),
    stop: jest.fn(),
    kick: jest.fn(),
    reconnect: jest.fn(),
    subscribe: (listener: (message: unknown) => void) => {
      mockWs.listeners.add(listener);
      return () => mockWs.listeners.delete(listener);
    },
    subscribeState: (listener: (connected: boolean) => void) => {
      listener(mockWs.connected);
      mockWs.stateListeners.add(listener);
      return () => mockWs.stateListeners.delete(listener);
    },
  },
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
jest.mock("@/api/client", () => ({
  ...jest.requireActual<typeof import("@/api/client")>("@/api/client"),
  forceRefreshTokens: jest.fn(),
}));
jest.mock("@/api/devices", () => ({ devicesApi: { list: jest.fn() } }));
jest.mock("@/api/sos", () => ({
  sosApi: { active: jest.fn(), activeForAccount: jest.fn() },
}));
jest.mock("@/services/ble-link", () => ({
  setBleTargetNameResolver: jest.fn(),
  setBleTargets: jest.fn(),
  checkBlePermissions: jest.fn(),
  startBleLink: jest.fn(),
  stopBleLink: jest.fn(),
}));
jest.mock("@/services/battery-alert", () => ({
  checkBatteryAlert: jest.fn(),
  resetBatteryAlerts: jest.fn(),
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("@/services/push", () => ({
  setPushArrivalHandler: jest.fn(),
  startPush: jest.fn(),
  stopPush: jest.fn(),
}));
jest.mock("@/services/ble-relay", () => ({ handleDeviceCommand: jest.fn() }));
jest.mock("@/services/ble-relay-uplink", () => ({
  adoptRelayUplinkOwner: jest.fn(),
  setCriticalAcceptedHandler: jest.fn(),
  startRelayUplink: jest.fn(),
  stopRelayUplink: jest.fn(),
}));
// liveTargets 是读缓存的纯函数，用真的；读写钥匙串、退避重试的换掉
jest.mock("@/services/ble-targets", () => ({
  ...jest.requireActual<typeof import("@/services/ble-targets")>(
    "@/services/ble-targets",
  ),
  loadCachedTargets: jest.fn(),
  saveCachedTargets: jest.fn(),
  loadWithRetry: jest.fn(),
}));
jest.mock("@/services/sign-in-moment", () => ({
  markSignedIn: jest.fn(),
  signInQuietRemainingMs: () => 0,
  whenSignInQuiet: jest.fn(),
}));
jest.mock("@/services/sos-alert", () => ({
  clearSosAlert: jest.fn(),
  ensureSosAlertPermission: jest.fn(),
  whenSosAlertPermissionAsked: jest.fn(),
  whenCountdownClearForPrompt: jest.fn(),
  setOtherSosPendingCheck: jest.fn(),
  holdPermissionPromptUntil: jest.fn(),
  resetSosAlerts: jest.fn(),
  setSosCancelConfirmedListener: jest.fn(),
  showSosAlertIfBackground: jest.fn(),
}));

const DEADLINE = "2026-10-18T02:01:00.000Z";
const offline = () => new TypeError("Network request failed");

const tokens = (n: number) => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
});
const profile = (id: string): UserProfile => ({
  id,
  phone: "13900000042",
  nickname: null,
  avatarUrl: null,
  createdAt: "2026-10-01T00:00:00Z",
});
const dev = (
  deviceId: string,
  over: Partial<DevicePublic> = {},
): DevicePublic => ({
  deviceId,
  name: null,
  bindCode: null,
  boundAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  online: true,
  lastSeenAt: null,
  battery: 80,
  charging: false,
  signalLevel: null,
  sleeping: false,
  firmwareVersion: null,
  ...over,
});
const statusOf = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  online: true,
  lastSeenAt: "2026-10-18T02:00:00.000Z",
  battery: 50,
  charging: false,
  signalLevel: 3,
  sleeping: false,
  firmwareVersion: "1.0.0",
  ...over,
});
const sosOf = (over: Partial<Sos> = {}): Sos => ({
  sosId: "s1",
  deviceId: "h1",
  triggerEventId: "e1",
  triggerType: "possible_fall",
  status: "pending",
  deadline: DEADLINE,
  createdAt: "2026-10-18T02:00:00.000Z",
  updatedAt: "2026-10-18T02:00:00.000Z",
  ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 钩子交给 setXxx 的回调（取最近一次登记的） */
function registered<T>(setter: (handler: T) => void): NonNullable<T> {
  const handler = jest.mocked(setter).mock.lastCall?.[0];
  if (!handler) throw new Error("还没登记回调");
  return handler as NonNullable<T>;
}

let qc: QueryClient;
const appStateListeners = new Set<(state: string) => void>();
/** loadWithRetry 的替身只试一次；load 留着，测试里再调一次就是「退避重试拉到了」 */
const devicesLoad: {
  load: (() => Promise<unknown>) | null;
  cancel: jest.Mock<() => void>;
} = { load: null, cancel: jest.fn<() => void>() };

/** 根布局里的 RealtimeBridge */
function Bridge() {
  useRealtimeUpdates();
  return null;
}
const trees = new Set<ReactTestRenderer>();

/** 让出几轮宏任务：替身都是立即兑现的 Promise，几轮之内各条 then 链都能走完 */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountBridge(): Promise<{ unmount: () => Promise<void> }> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <QueryClientProvider client={qc}>
        <Bridge />
      </QueryClientProvider>,
    );
  });
  trees.add(tree);
  await flush();
  return {
    unmount: async () => {
      await act(async () => {
        tree.unmount();
      });
      trees.delete(tree);
      await flush();
    },
  };
}

/** 改登录态要包在 act 里：桥组件订阅了「有没有 token」，变了会重渲染、跑 effect 的清理 */
async function setAuth(
  patch: Partial<ReturnType<typeof useAuthStore.getState>>,
): Promise<void> {
  await act(async () => {
    useAuthStore.setState(patch);
  });
  await flush();
}
const logout = () => setAuth({ tokens: null, user: null });

/** 服务端经 WS 推来一条消息 */
async function wsPush(type: WsMessage["type"], data: unknown): Promise<void> {
  await act(async () => {
    for (const l of [...mockWs.listeners])
      l({ type, data, sentAt: "2026-10-18T02:00:00.000Z" });
  });
  await flush();
}
/** WS 连接状态变化（和真的一样，只在变化时通知） */
async function setWsConnected(connected: boolean): Promise<void> {
  if (mockWs.connected === connected) return;
  mockWs.connected = connected;
  await act(async () => {
    for (const l of [...mockWs.stateListeners]) l(connected);
  });
  await flush();
}
async function setAppState(state: string): Promise<void> {
  await act(async () => {
    for (const l of [...appStateListeners]) l(state);
  });
  await flush();
}
async function run(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
  });
  await flush();
}

/** 全 App 共用的连接与状态全部停掉，每样一次 */
function expectSharedStopped(): void {
  expect(realtimeClient.stop).toHaveBeenCalledTimes(1);
  expect(stopRelayUplink).toHaveBeenCalledTimes(1);
  expect(stopBleLink).toHaveBeenCalledTimes(1);
  expect(setBleTargetNameResolver).toHaveBeenLastCalledWith(null);
  expect(resetBatteryAlerts).toHaveBeenCalledTimes(1);
  expect(setPushArrivalHandler).toHaveBeenLastCalledWith(null);
  expect(setCriticalAcceptedHandler).toHaveBeenLastCalledWith(null);
  expect(setSosCancelConfirmedListener).toHaveBeenLastCalledWith(null);
  expect(presentedSos.current.size).toBe(0);
  expect(resetSosAlerts).toHaveBeenCalledTimes(1);
  expect(stopPush).toHaveBeenCalledTimes(1);
}
/** 一样都没停 */
function expectSharedRunning(): void {
  expect(realtimeClient.stop).not.toHaveBeenCalled();
  expect(stopRelayUplink).not.toHaveBeenCalled();
  expect(stopBleLink).not.toHaveBeenCalled();
  expect(setBleTargetNameResolver).not.toHaveBeenCalledWith(null);
  expect(resetBatteryAlerts).not.toHaveBeenCalled();
  expect(setPushArrivalHandler).not.toHaveBeenCalledWith(null);
  expect(setCriticalAcceptedHandler).not.toHaveBeenCalledWith(null);
  expect(setSosCancelConfirmedListener).not.toHaveBeenCalledWith(null);
  expect(resetSosAlerts).not.toHaveBeenCalled();
  expect(stopPush).not.toHaveBeenCalled();
}
/** 挂上的订阅都拆了（查询缓存、账号变化两样看不到订阅数，各用例按行为另看） */
function expectDetached(): void {
  expect(mockWs.listeners.size).toBe(0);
  expect(mockWs.stateListeners.size).toBe(0);
  expect(appStateListeners.size).toBe(0);
  expect(devicesLoad.cancel).toHaveBeenCalled();
}

beforeEach(() => {
  const mocks: { mockReset: () => void }[] = [
    jest.mocked(router.push),
    jest.mocked(realtimeClient.start),
    jest.mocked(realtimeClient.stop),
    jest.mocked(realtimeClient.kick),
    jest.mocked(realtimeClient.reconnect),
    jest.mocked(forceRefreshTokens),
    jest.mocked(devicesApi.list),
    jest.mocked(sosApi.active),
    jest.mocked(sosApi.activeForAccount),
    jest.mocked(setBleTargetNameResolver),
    jest.mocked(setBleTargets),
    jest.mocked(startBleLink),
    jest.mocked(stopBleLink),
    jest.mocked(checkBatteryAlert),
    jest.mocked(resetBatteryAlerts),
    jest.mocked(devLog),
    jest.mocked(setPushArrivalHandler),
    jest.mocked(startPush),
    jest.mocked(stopPush),
    jest.mocked(handleDeviceCommand),
    jest.mocked(adoptRelayUplinkOwner),
    jest.mocked(setCriticalAcceptedHandler),
    jest.mocked(startRelayUplink),
    jest.mocked(stopRelayUplink),
    jest.mocked(loadCachedTargets),
    jest.mocked(saveCachedTargets),
    jest.mocked(loadWithRetry),
    jest.mocked(clearSosAlert),
    jest.mocked(ensureSosAlertPermission),
    jest.mocked(holdPermissionPromptUntil),
    jest.mocked(resetSosAlerts),
    jest.mocked(setSosCancelConfirmedListener),
    jest.mocked(showSosAlertIfBackground),
    devicesLoad.cancel,
  ];
  for (const m of mocks) m.mockReset();
  devicesLoad.load = null;
  jest.mocked(loadWithRetry).mockImplementation((load) => {
    devicesLoad.load = load;
    return {
      firstAttempt: load().then(
        () => undefined,
        () => undefined,
      ),
      cancel: devicesLoad.cancel,
    };
  });
  jest.mocked(loadCachedTargets).mockResolvedValue([]);
  jest.mocked(saveCachedTargets).mockResolvedValue(undefined);
  jest.mocked(ensureSosAlertPermission).mockResolvedValue(undefined);
  jest.mocked(whenSosAlertPermissionAsked).mockResolvedValue(undefined);
  jest.mocked(whenCountdownClearForPrompt).mockResolvedValue(undefined);
  jest.mocked(whenSignInQuiet).mockResolvedValue(undefined);
  jest.mocked(checkBlePermissions).mockResolvedValue(true);
  jest.mocked(startBleLink).mockResolvedValue(undefined);
  jest.mocked(adoptRelayUplinkOwner).mockReturnValue(true);
  jest.mocked(handleDeviceCommand).mockResolvedValue(true);
  jest.mocked(showSosAlertIfBackground).mockResolvedValue(undefined);
  jest.mocked(clearSosAlert).mockResolvedValue(undefined);
  jest.mocked(resetSosAlerts).mockResolvedValue(undefined);
  jest.mocked(forceRefreshTokens).mockResolvedValue("ok");
  jest
    .mocked(devicesApi.list)
    .mockResolvedValue([dev("h1", { name: "通勤盔" })]);
  jest.mocked(sosApi.active).mockResolvedValue({ sos: null });
  // 默认按「服务端还没有账号级接口」走逐台查：每次补拉查了哪几顶就看得见
  jest
    .mocked(sosApi.activeForAccount)
    .mockRejectedValue(new ApiRequestError(404, {}));

  mockWs.listeners.clear();
  mockWs.stateListeners.clear();
  mockWs.connected = false;
  appStateListeners.clear();
  jest.spyOn(AppState, "addEventListener").mockImplementation(((
    _type: string,
    listener: (state: string) => void,
  ) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  }) as never);

  presentedSos.current.clear();
  sosScreen.mounted = false;
  __resetBridgeLifecycleForTests();
  useAuthStore.setState({
    hydrated: true,
    tokens: tokens(1),
    user: profile("u1"),
    sessionExpired: false,
  });
  useCurrentHelmetStore.setState({ chosen: {} });
  qc = makeQueryClient();
});

afterEach(async () => {
  await act(async () => {
    for (const t of trees) t.unmount();
  });
  trees.clear();
  // 仍登录时卸下的那次会留成孤儿、订阅还挂在 store 上：退出登录把它拆掉，免得漏进下一个用例
  await act(async () => {
    useAuthStore.setState({ tokens: null, user: null });
  });
  __resetBridgeLifecycleForTests();
  jest.restoreAllMocks();
});

describe("登录态与启动", () => {
  it("未登录什么都不起；登录后起实时连接、上行队列、通知权限、推送和蓝牙链路，并标记界面已接上", async () => {
    useAuthStore.setState({ tokens: null, user: null });
    await mountBridge();
    expect(realtimeClient.start).not.toHaveBeenCalled();
    expect(startRelayUplink).not.toHaveBeenCalled();
    expect(ensureSosAlertPermission).not.toHaveBeenCalled();
    expect(loadWithRetry).not.toHaveBeenCalled();
    expect(mockWs.listeners.size).toBe(0);
    expect(bridgeUi.attached).toBe(false);

    await setAuth({ tokens: tokens(1), user: profile("u1") });
    expect(realtimeClient.start).toHaveBeenCalledTimes(1);
    expect(startRelayUplink).toHaveBeenCalledWith("u1");
    expect(ensureSosAlertPermission).toHaveBeenCalledTimes(1);
    expect(startPush).toHaveBeenCalledWith("u1");
    expect(startBleLink).toHaveBeenCalledTimes(1);
    expect(mockWs.listeners.size).toBe(1);
    expect(appStateListeners.size).toBe(1);
    expect(bridgeUi.attached).toBe(true);
  });

  it("实时连接每次取此刻的 token（轮换后取新的、登出后为空）；被判过期（4401）要强制换一把新 token", async () => {
    await mountBridge();
    const deps = jest.mocked(realtimeClient.start).mock.calls[0][0];
    expect(deps.getAccessToken()).toBe("access-1");
    await setAuth({ tokens: tokens(2) });
    expect(deps.getAccessToken()).toBe("access-2");
    await deps.triggerTokenRefresh();
    expect(forceRefreshTokens).toHaveBeenCalledTimes(1);
    await logout();
    expect(deps.getAccessToken()).toBeNull();
  });

  it("钥匙串里只有 token、档案晚到：先落匿名分区、不设推送别名；档案到了才设别名，上行队列带着匿名期间的积压认领过去（不 stop 再 start），只做一次", async () => {
    useAuthStore.setState({ user: null });
    await mountBridge();
    expect(startRelayUplink).toHaveBeenCalledWith(undefined);
    expect(loadCachedTargets).toHaveBeenCalledWith(undefined);
    expect(startPush).not.toHaveBeenCalled();

    await setAuth({ user: profile("u1") });
    expect(startPush).toHaveBeenCalledWith("u1");
    expect(adoptRelayUplinkOwner).toHaveBeenCalledWith("u1");
    expect(stopRelayUplink).not.toHaveBeenCalled();
    expect(startRelayUplink).toHaveBeenCalledTimes(1);
    expect(loadCachedTargets).toHaveBeenLastCalledWith("u1");

    // 之后档案刷新（还是这个人）、别的字段变化都不重来
    await setAuth({ user: { ...profile("u1"), nickname: "老王" } });
    await setAuth({ sessionExpired: false });
    expect(startPush).toHaveBeenCalledTimes(1);
    expect(adoptRelayUplinkOwner).toHaveBeenCalledTimes(1);
    expect(loadCachedTargets).toHaveBeenCalledTimes(2);
  });

  it("认领不成（上行队列已经不在匿名分区）：stop 再 start 到本人名下", async () => {
    useAuthStore.setState({ user: null });
    jest.mocked(adoptRelayUplinkOwner).mockReturnValue(false);
    await mountBridge();
    await setAuth({ user: profile("u1") });
    expect(stopRelayUplink).toHaveBeenCalledTimes(1);
    expect(startRelayUplink).toHaveBeenLastCalledWith("u1");
  });

  it("档案换成了另一个账号：上行队列 stop 再 start 到新账号名下、重载他的目标，不走认领（认领只给匿名 → 本人）", async () => {
    await mountBridge();
    await setAuth({ user: profile("u2") });
    expect(adoptRelayUplinkOwner).not.toHaveBeenCalled();
    expect(stopRelayUplink).toHaveBeenCalledTimes(1);
    expect(startRelayUplink).toHaveBeenLastCalledWith("u2");
    expect(loadCachedTargets).toHaveBeenLastCalledWith("u2");
  });

  it("档案晚到、设备列表还没拉到：重载他存下的目标交给链路，之后按这份目标补拉", async () => {
    useAuthStore.setState({ user: null });
    jest.mocked(devicesApi.list).mockRejectedValue(offline());
    jest
      .mocked(loadCachedTargets)
      .mockImplementation(async (uid) => (uid === "u1" ? ["h3", "h4"] : []));
    await mountBridge();
    await setAuth({ user: profile("u1") });
    expect(setBleTargets).toHaveBeenCalledWith(["h3", "h4"]);

    jest.mocked(sosApi.active).mockClear();
    await run(() => registered(setPushArrivalHandler)({}));
    expect(jest.mocked(sosApi.active).mock.calls).toEqual([["h3"], ["h4"]]);
  });

  it("档案晚到时设备列表已在缓存里：不拿存下的旧目标盖掉列表", async () => {
    useAuthStore.setState({ user: null });
    jest
      .mocked(loadCachedTargets)
      .mockImplementation(async (uid) => (uid === "u1" ? ["h3", "h4"] : []));
    await mountBridge();
    jest.mocked(setBleTargets).mockClear();
    await setAuth({ user: profile("u1") });
    expect(loadCachedTargets).toHaveBeenLastCalledWith("u1");
    expect(setBleTargets).not.toHaveBeenCalled();
  });
});

describe("蓝牙链路目标", () => {
  it("等通知权限的系统框有了结果才起链路（安卓同时只允许一个权限请求，并发时蓝牙权限框不出现）；目标把当前头盔排最前", async () => {
    const permission = deferred<void>();
    jest.mocked(ensureSosAlertPermission).mockReturnValue(permission.promise);
    jest
      .mocked(devicesApi.list)
      .mockResolvedValue([dev("h1", { online: false }), dev("h2"), dev("h3")]);
    useCurrentHelmetStore.setState({ chosen: { u1: "h3" } });
    await mountBridge();
    expect(startBleLink).not.toHaveBeenCalled();

    await run(() => permission.resolve());
    expect(startBleLink).toHaveBeenCalledTimes(1);
    expect(startBleLink).toHaveBeenCalledWith(["h3", "h1", "h2"]);
  });

  it("刚登录的几秒里不起链路（iOS 新建蓝牙管理器就弹蓝牙授权框，压在「保存密码？」卡片上会把 App 卡死，10-22 iPad）", async () => {
    const quiet = deferred<void>();
    jest.mocked(whenSignInQuiet).mockReturnValue(quiet.promise);
    jest.mocked(devicesApi.list).mockResolvedValue([dev("h1")]);
    await mountBridge();
    await run(() => undefined);
    expect(startBleLink).not.toHaveBeenCalled();
    await run(() => quiet.resolve());
    expect(startBleLink).toHaveBeenCalledTimes(1);
  });

  it("蓝牙权限还没给过（这次起链路会弹系统框）：等通知那次申请有结果（倒计时在屏时被推迟到关页后）再起链路，不让「附近设备」框盖住倒计时（O10）", async () => {
    const asked = deferred<void>();
    jest.mocked(checkBlePermissions).mockResolvedValue(false);
    jest.mocked(whenSosAlertPermissionAsked).mockReturnValue(asked.promise);
    jest.mocked(devicesApi.list).mockResolvedValue([dev("h1")]);
    await mountBridge();
    expect(startBleLink).not.toHaveBeenCalled();
    await run(() => asked.resolve());
    expect(startBleLink).toHaveBeenCalledTimes(1);
  });

  it("蓝牙权限没有、通知那次根本没弹框（早就授权 / 永久拒绝，立刻兑现）：倒计时页在屏时照样等它关掉再起链路（O10，10-21 代码审查）", async () => {
    const clear = deferred<void>();
    jest.mocked(checkBlePermissions).mockResolvedValue(false);
    jest.mocked(whenSosAlertPermissionAsked).mockResolvedValue(undefined);
    jest.mocked(whenCountdownClearForPrompt).mockReturnValue(clear.promise);
    jest.mocked(devicesApi.list).mockResolvedValue([dev("h1")]);
    await mountBridge();
    await run(() => undefined);
    expect(startBleLink).not.toHaveBeenCalled();
    await run(() => clear.resolve());
    expect(startBleLink).toHaveBeenCalledTimes(1);
  });

  it("会话被否定、倒计时还在走（O19-A）：停掉蓝牙链路，让头盔里的高危事件留着等重新登录后补传；这时界面重建也不再起链路（10-21 第二轮审查）", async () => {
    jest.mocked(devicesApi.list).mockResolvedValue([dev("h1")]);
    await mountBridge();
    expect(startBleLink).toHaveBeenCalledTimes(1);
    jest.mocked(stopBleLink).mockClear();
    await setAuth({ sessionDeadUntil: Date.now() + 40_000 });
    expect(stopBleLink).toHaveBeenCalledTimes(1);
    // 同一失效期里再来一次变化不重复停
    await setAuth({ sessionDeadUntil: Date.now() + 50_000 });
    expect(stopBleLink).toHaveBeenCalledTimes(1);

    jest.mocked(startBleLink).mockClear();
    await mountBridge();
    await run(() => undefined);
    expect(startBleLink).not.toHaveBeenCalled();
    await setAuth({ sessionDeadUntil: null });
  });

  it("给 sos-alert 注册「账号下还有别的单在倒数吗」：按 [sos-active] 缓存判断；登出时撤掉（O12 兜底撤极光遗留通知用）", async () => {
    await mountBridge();
    const check = jest
      .mocked(setOtherSosPendingCheck)
      .mock.calls.at(-1)?.[0] as ((id: string) => boolean) | null;
    expect(typeof check).toBe("function");
    qc.setQueryData(["sos-active", "h1"], {
      sos: { sosId: "s1", deviceId: "h1", status: "pending" },
    });
    qc.setQueryData(["sos-active", "h2"], { sos: null });
    expect(check!("s1")).toBe(false);
    expect(check!("s9")).toBe(true);
    await logout();
    expect(
      jest.mocked(setOtherSosPendingCheck).mock.calls.at(-1)?.[0],
    ).toBeNull();
  });

  it("蓝牙权限已经有了：不等通知那次申请（可能被推迟），通知权限一有结果就起链路", async () => {
    jest.mocked(checkBlePermissions).mockResolvedValue(true);
    jest
      .mocked(whenSosAlertPermissionAsked)
      .mockReturnValue(new Promise(() => undefined));
    jest
      .mocked(whenCountdownClearForPrompt)
      .mockReturnValue(new Promise(() => undefined));
    jest.mocked(devicesApi.list).mockResolvedValue([dev("h1")]);
    await mountBridge();
    await run(() => undefined);
    expect(startBleLink).toHaveBeenCalledTimes(1);
  });

  const orderCases: {
    when: string;
    user: UserProfile | null;
    chosen: Record<string, string | null>;
    devices: DevicePublic[];
    expected: string[];
  }[] = [
    {
      when: "没选过当前头盔：第一台在线的排最前",
      user: profile("u1"),
      chosen: {},
      devices: [dev("h1", { online: false }), dev("h2"), dev("h3")],
      expected: ["h2", "h1", "h3"],
    },
    {
      when: "档案还没到（不知道是谁，选过哪顶无从查）：同样按第一台在线的",
      user: null,
      chosen: { u1: "h3" },
      devices: [dev("h1", { online: false }), dev("h2"), dev("h3")],
      expected: ["h2", "h1", "h3"],
    },
    {
      when: "当前头盔本来就在最前：原样",
      user: profile("u1"),
      chosen: { u1: "h1" },
      devices: [dev("h1"), dev("h2")],
      expected: ["h1", "h2"],
    },
    {
      when: "一台都没绑：空目标",
      user: profile("u1"),
      chosen: {},
      devices: [],
      expected: [],
    },
  ];
  it.each(orderCases)(
    "目标排序——$when",
    async ({ user, chosen, devices, expected }) => {
      const permission = deferred<void>();
      jest.mocked(ensureSosAlertPermission).mockReturnValue(permission.promise);
      jest.mocked(devicesApi.list).mockResolvedValue(devices);
      useAuthStore.setState({ user });
      useCurrentHelmetStore.setState({ chosen });
      await mountBridge();
      await run(() => permission.resolve());
      expect(startBleLink).toHaveBeenCalledWith(expected);
    },
  );

  it("冷启动拉不到设备列表：用上次存下的目标起链路、做冷启动补拉；拉取失败不动链路目标", async () => {
    jest.mocked(devicesApi.list).mockRejectedValue(offline());
    jest.mocked(loadCachedTargets).mockResolvedValue(["h7", "h8"]);
    await mountBridge();
    expect(loadCachedTargets).toHaveBeenCalledWith("u1");
    expect(startBleLink).toHaveBeenCalledWith(["h7", "h8"]);
    expect(setBleTargets).not.toHaveBeenCalled();
    expect(jest.mocked(sosApi.active).mock.calls).toEqual([["h7"], ["h8"]]);
  });

  it("设备列表到了 / 变了：同步链路目标并按账号存一份；解绑到一台不剩时目标清空（空列表 ≠ 拉取失败）；别的查询不碰目标", async () => {
    await mountBridge();
    expect(setBleTargets).toHaveBeenLastCalledWith(["h1"]);
    expect(saveCachedTargets).toHaveBeenLastCalledWith("u1", ["h1"]);

    await run(() => qc.setQueryData(["devices"], [dev("h1"), dev("h2")]));
    expect(setBleTargets).toHaveBeenLastCalledWith(["h1", "h2"]);
    await run(() => qc.setQueryData(["devices"], []));
    expect(setBleTargets).toHaveBeenLastCalledWith([]);
    expect(saveCachedTargets).toHaveBeenLastCalledWith("u1", []);

    jest.mocked(setBleTargets).mockClear();
    await run(() => qc.setQueryData(["events"], []));
    expect(setBleTargets).not.toHaveBeenCalled();
  });

  it("前台服务常驻通知里的头盔名：用户起的名字（整理掉看不见的字符）；没起、整理后为空、不在列表、列表没拉到都给 null（ble-link 再用设备号兜底）", async () => {
    jest.mocked(devicesApi.list).mockRejectedValue(offline());
    await mountBridge();
    const nameOf = registered(setBleTargetNameResolver);
    expect(nameOf("h1")).toBeNull();

    await run(() =>
      qc.setQueryData<DevicePublic[]>(
        ["devices"],
        [
          dev("h1", { name: " 通勤盔\u200B " }),
          dev("h2", { name: "\u200B\u200B" }),
          dev("h3"),
        ],
      ),
    );
    expect(nameOf("h1")).toBe("通勤盔");
    expect(nameOf("h2")).toBeNull();
    expect(nameOf("h3")).toBeNull();
    expect(nameOf("h9")).toBeNull();
  });

  it("设备列表到了 / 刷新时，交给链路和存盘的目标也把当前头盔排第一（绑 20 顶以上时链路只盯前 20 顶，10-16 A11）", async () => {
    const ids = Array.from(
      { length: 22 },
      (_, i) => `h${String(i + 1).padStart(2, "0")}`,
    );
    const ordered = ["h22", ...ids.filter((id) => id !== "h22")];
    const permission = deferred<void>();
    jest.mocked(ensureSosAlertPermission).mockReturnValue(permission.promise);
    jest.mocked(devicesApi.list).mockResolvedValue(ids.map((id) => dev(id)));
    useCurrentHelmetStore.setState({ chosen: { u1: "h22" } });
    await mountBridge();
    // 列表到达：当前那顶（服务端排第 22）挪到最前再交给链路、存盘（存盘只留前 20 个）
    expect(setBleTargets).toHaveBeenLastCalledWith(ordered);
    expect(saveCachedTargets).toHaveBeenLastCalledWith("u1", ordered);

    // 起链路走 bleTargetsOf，同样在最前
    await run(() => permission.resolve());
    expect(jest.mocked(startBleLink).mock.calls[0][0][0]).toBe("h22");

    // 之后列表一刷新（回前台、绑定 / 解绑），目标仍是当前那顶在最前
    await run(() =>
      qc.setQueryData(
        ["devices"],
        ids.map((id) => dev(id)),
      ),
    );
    expect(jest.mocked(setBleTargets).mock.lastCall?.[0]).toEqual(ordered);
  });
});

describe("求救：拉起倒计时页与锁屏提醒", () => {
  // 补拉不等列表（10-31）：手上有缓存目标是常态，这一组都按它走；没有缓存的首次登录见下面「冷启动补拉与设备列表的先后」
  beforeEach(() => {
    jest.mocked(loadCachedTargets).mockResolvedValue(["h1"]);
  });

  it("冷启动补拉回来之前拦住系统通知授权框（O10：进行中的单要等补拉才拉起倒计时页，授权框先弹会盖在页上）：闸在调 ensure 之前装上；补拉先拉起倒计时页、结束后才放行", async () => {
    const active = deferred<{ sos: Sos | null }>();
    jest.mocked(sosApi.active).mockReturnValueOnce(active.promise);
    await mountBridge();
    const hold = jest.mocked(holdPermissionPromptUntil);
    expect(hold).toHaveBeenCalledTimes(1);
    expect(hold.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(ensureSosAlertPermission).mock.invocationCallOrder[0],
    );
    const released = jest.fn();
    void hold.mock.calls[0][0].then(released);
    await flush();
    expect(sosApi.active).toHaveBeenCalledWith("h1");
    expect(released).not.toHaveBeenCalled(); // 补拉还在路上

    await run(() => active.resolve({ sos: sosOf() }));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    // 先登记、拉起倒计时页，再放行：sos-alert 放行后看到 presentedSos 里有这单，就把申请推迟到页面关掉后
    expect(jest.mocked(router.push).mock.invocationCallOrder[0]).toBeLessThan(
      released.mock.invocationCallOrder[0],
    );
  });

  it("冷启动补拉失败（离线）也放行授权框：申请不能一直挂着", async () => {
    jest.mocked(sosApi.active).mockRejectedValue(offline());
    await mountBridge();
    const released = jest.fn();
    void jest.mocked(holdPermissionPromptUntil).mock.calls[0][0].then(released);
    await flush();
    expect(released).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("第一次挂上（没有孤儿可接手）不清「拉起过」的登记：点通知冷启动进来的那单，冷启动补拉只补锁屏提醒、不再叠一页", async () => {
    presentedSos.current.add("s1");
    jest.mocked(sosApi.active).mockResolvedValue({ sos: sosOf() });
    await mountBridge();
    expect(sosApi.active).toHaveBeenCalledWith("h1");
    expect(showSosAlertIfBackground).toHaveBeenCalledWith(
      "s1",
      "h1",
      DEADLINE,
      undefined,
      "通勤盔",
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("WS 推来进行中的单：同一单只拉起一次倒计时页（编号编码后拼进路径）；锁屏提醒带头盔名；事故记录缓存失效", async () => {
    await mountBridge();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    const sos = sosOf({
      sosId: "s 1/x",
      triggeredAt: "2026-10-18T01:59:00.000Z",
    });
    await wsPush("sos_update", sos);
    // 重连补发 / 重复推送
    await wsPush("sos_update", sos);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/sos-active?sosId=s%201%2Fx&deviceId=h1",
    );
    expect(showSosAlertIfBackground).toHaveBeenCalledTimes(1);
    expect(showSosAlertIfBackground).toHaveBeenCalledWith(
      "s 1/x",
      "h1",
      DEADLINE,
      "2026-10-18T01:59:00.000Z",
      "通勤盔",
    );
    expect(qc.getQueryData(["sos-active", "h1"])).toEqual({ sos });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["accidents"] });
    // 打开着的记录详情也跟着刷新（状态 / 短信发送结果）
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["accident", "s 1/x"],
    });
  });

  it("倒计时页已在屏上：新来的单只进队列（进行中缓存 + 锁屏提醒），不再叠一页；不在设备列表里的头盔提醒写设备号", async () => {
    await mountBridge();
    sosScreen.mounted = true;
    const other = sosOf({ sosId: "s2", deviceId: "h2" });
    await wsPush("sos_update", other);
    expect(router.push).not.toHaveBeenCalled();
    expect(qc.getQueryData(["sos-active", "h2"])).toEqual({ sos: other });
    expect(showSosAlertIfBackground).toHaveBeenCalledWith(
      "s2",
      "h2",
      DEADLINE,
      undefined,
      "h2",
    );
  });

  it("单结束（取消 / 已通知）：撤掉锁屏提醒、进行中缓存清空，不跳页", async () => {
    await mountBridge();
    await wsPush("sos_update", sosOf());
    jest.mocked(router.push).mockClear();
    await wsPush("sos_update", sosOf({ status: "cancelled" }));
    expect(clearSosAlert).toHaveBeenCalledWith("s1");
    expect(qc.getQueryData(["sos-active", "h1"])).toEqual({ sos: null });
    expect(router.push).not.toHaveBeenCalled();
  });

  it("锁屏提醒的头盔名：设备列表没拉到时写设备号", async () => {
    jest.mocked(devicesApi.list).mockRejectedValue(offline());
    await mountBridge();
    await wsPush("sos_update", sosOf());
    expect(showSosAlertIfBackground).toHaveBeenCalledWith(
      "s1",
      "h1",
      DEADLINE,
      undefined,
      "h1",
    );
  });

  it("冷启动补拉走账号级接口：一个请求拿全（头盔已解绑、单还是本人的也拉起），不再逐台查", async () => {
    jest.mocked(sosApi.activeForAccount).mockResolvedValue({
      items: [
        { ...sosOf({ sosId: "s7", deviceId: "h-old" }), deviceName: null },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    await mountBridge();
    expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
    expect(sosApi.active).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith(
      "/sos-active?sosId=s7&deviceId=h-old",
    );
    expect(devLog).toHaveBeenCalledWith("SOS", "冷启动发现进行中 SOS s7");
  });

  it.each([
    ["服务端 500", new ApiRequestError(500, {})],
    ["断网", offline()],
  ])(
    "账号级接口报别的错（%s）：不退回逐台查（离线时那只是 N 个注定失败的请求），这次不拉起、不抛（稍后重试见下一条）",
    async (_label, error) => {
      jest.mocked(sosApi.activeForAccount).mockRejectedValue(error);
      await mountBridge();
      expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
      expect(sosApi.active).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
    },
  );

  it("账号级接口回了不像分页的应答（apiPage 按服务端出错拒掉，状态码 200）：同 404 退回逐台查，进行中的单照样拉起（10-25 审查）", async () => {
    jest.mocked(sosApi.activeForAccount).mockRejectedValue(
      new ApiRequestError(
        200,
        {
          code: "INTERNAL_ERROR",
          message: "/users/me/sos/active: not a page",
        },
        undefined,
        true,
      ),
    );
    jest
      .mocked(sosApi.active)
      .mockResolvedValue({ sos: sosOf({ sosId: "s8", deviceId: "h1" }) });
    await mountBridge();
    expect(sosApi.active).toHaveBeenCalledWith("h1");
    expect(router.push).toHaveBeenCalledWith(
      "/sos-active?sosId=s8&deviceId=h1",
    );
  });

  describe("冷启动补拉失败后重试（10-22 夜测：安卓划掉后进程和 WS 都活着，界面重挂时只有这一次补拉，弱网下没拉到就再没机会）", () => {
    /** 截下重试用的定时器（2 s 起头、5 s 第二次），由用例自己触发；别的定时器照常 */
    function catchRetryTimers(): (ms?: number) => (() => void) | null {
      const real = global.setTimeout;
      const caught = new Map<number, () => void>();
      jest.spyOn(global, "setTimeout").mockImplementation(((
        fn: () => void,
        ms?: number,
      ) => {
        if (ms === 2_000 || ms === 5_000) {
          caught.set(ms, fn);
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return real(fn, ms);
      }) as typeof setTimeout);
      return (ms = 2_000) => caught.get(ms) ?? null;
    }
    const account = (sosId: string) => ({
      items: [{ ...sosOf({ sosId, deviceId: "h1" }), deviceName: null }],
      total: 1,
      page: 1,
      pageSize: 100,
    });

    it("2 s 后再补一次，补到了照样拉起倒计时页", async () => {
      const retry = catchRetryTimers();
      jest
        .mocked(sosApi.activeForAccount)
        .mockRejectedValueOnce(offline())
        .mockResolvedValueOnce(account("s9"));
      await mountBridge();
      expect(router.push).not.toHaveBeenCalled();
      expect(retry()).not.toBeNull();
      await act(async () => retry()!());
      await flush();
      expect(sosApi.activeForAccount).toHaveBeenCalledTimes(2);
      expect(router.push).toHaveBeenCalledWith(
        "/sos-active?sosId=s9&deviceId=h1",
      );
      expect(devLog).toHaveBeenCalledWith(
        "SOS",
        "冷启动补拉失败后重试，发现进行中 SOS s9",
      );
    });

    it("补拉成功（哪怕没有进行中的单）不重试", async () => {
      const retry = catchRetryTimers();
      jest
        .mocked(sosApi.activeForAccount)
        .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 100 });
      await mountBridge();
      expect(retry()).toBeNull();
    });

    it("重试途中退出登录：后面几次不再发请求", async () => {
      const retry = catchRetryTimers();
      jest
        .mocked(sosApi.activeForAccount)
        .mockRejectedValueOnce(offline())
        .mockRejectedValueOnce(offline());
      await mountBridge();
      await act(async () => retry()!());
      await flush();
      expect(sosApi.activeForAccount).toHaveBeenCalledTimes(2);
      await logout();
      jest.mocked(sosApi.activeForAccount).mockClear();
      expect(retry(5_000)).not.toBeNull();
      await act(async () => retry(5_000)!());
      await flush();
      expect(sosApi.activeForAccount).not.toHaveBeenCalled();
    });

    it("重试排上之后退出登录：到点不再补拉", async () => {
      const retry = catchRetryTimers();
      jest.mocked(sosApi.activeForAccount).mockRejectedValueOnce(offline());
      await mountBridge();
      await logout();
      jest.mocked(sosApi.activeForAccount).mockClear();
      await act(async () => retry()!());
      await flush();
      expect(sosApi.activeForAccount).not.toHaveBeenCalled();
    });
  });

  it("WS 由断转连才补拉（第一次连上算启动，冷启动补拉已经做过）", async () => {
    await mountBridge();
    jest.mocked(sosApi.activeForAccount).mockClear();
    await setWsConnected(true);
    expect(sosApi.activeForAccount).not.toHaveBeenCalled();

    jest.mocked(sosApi.active).mockResolvedValue({ sos: sosOf() });
    await setWsConnected(false);
    await setWsConnected(true);
    expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
    expect(sosApi.active).toHaveBeenLastCalledWith("h1");
    expect(devLog).toHaveBeenCalledWith("SOS", "重连补拉发现进行中 SOS s1");
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("挂上时 WS 已经连着：回放的「已连上」算第一次，不额外补拉", async () => {
    mockWs.connected = true;
    await mountBridge();
    expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
  });

  it("远程推送到达：带了设备号只查那一顶，没带按全部链路目标查", async () => {
    jest.mocked(devicesApi.list).mockResolvedValue([dev("h1"), dev("h2")]);
    await mountBridge();
    const onArrival = registered(setPushArrivalHandler);
    jest.mocked(sosApi.active).mockClear();
    jest.mocked(sosApi.active).mockImplementation(async (id) => ({
      sos: id === "h2" ? sosOf({ sosId: "s2", deviceId: "h2" }) : null,
    }));

    await run(() => onArrival({ sosId: "s2", deviceId: "h2" }));
    expect(jest.mocked(sosApi.active).mock.calls).toEqual([["h2"]]);
    expect(devLog).toHaveBeenCalledWith(
      "SOS",
      "远程推送到达，补拉发现进行中 SOS s2",
    );
    expect(router.push).toHaveBeenCalledWith(
      "/sos-active?sosId=s2&deviceId=h2",
    );

    jest.mocked(sosApi.active).mockClear();
    await run(() => onArrival({}));
    expect(jest.mocked(sosApi.active).mock.calls).toEqual([["h1"], ["h2"]]);
  });

  it("自己中转上去的摔倒 / 求救被服务端接受：WS 立刻重连，核对那一顶并拉起倒计时页（手机深睡时唯一不靠 WS / 极光的路）", async () => {
    await mountBridge();
    jest.mocked(sosApi.active).mockClear();
    jest
      .mocked(sosApi.active)
      .mockResolvedValue({ sos: sosOf({ sosId: "s5", deviceId: "h5" }) });
    await run(() => registered(setCriticalAcceptedHandler)("h5"));
    expect(realtimeClient.kick).toHaveBeenCalledTimes(1);
    expect(jest.mocked(sosApi.active).mock.calls).toEqual([["h5"]]);
    expect(router.push).toHaveBeenCalledWith(
      "/sos-active?sosId=s5&deviceId=h5",
    );
    expect(devLog).toHaveBeenCalledWith(
      "SOS",
      "中转成功后核对发现进行中 SOS s5",
    );
  });

  it("中转成功后的核对第一次没拉到（深睡刚醒、网络还没起来）：同推送到达那条 2 s 后再试，拉到了照样拉起倒计时页（10-25 审查）", async () => {
    await mountBridge();
    jest
      .mocked(sosApi.activeForAccount)
      .mockRejectedValueOnce(offline())
      .mockResolvedValueOnce({
        items: [
          { ...sosOf({ sosId: "s6", deviceId: "h6" }), deviceName: null },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      });
    const real = global.setTimeout;
    let fire: (() => void) | null = null;
    const spy = jest.spyOn(global, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms === 2_000) {
        fire = fn;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return real(fn, ms);
    }) as typeof setTimeout);
    try {
      let resumed: unknown;
      await run(() => {
        resumed = registered(setCriticalAcceptedHandler)("h6");
      });
      expect(resumed).toBeInstanceOf(Promise);
      expect(router.push).not.toHaveBeenCalled();
      expect(fire).not.toBeNull();
      await run(() => fire!());
      await act(async () => {
        await resumed;
      });
      expect(router.push).toHaveBeenCalledWith(
        "/sos-active?sosId=s6&deviceId=h6",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("锁屏通知上的「取消」被服务端确认：先把终态写进缓存（弱网下接着的刷新失败也不回落成倒数），再让倒计时页 / 安全页重拉", async () => {
    await mountBridge();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    const onConfirmed = registered(setSosCancelConfirmedListener);
    const cancelled = sosOf({ status: "cancelled" });
    await run(() => onConfirmed("s1", cancelled));
    expect(qc.getQueryData(["sos", "s1"])).toEqual(cancelled);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sos", "s1"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sos-active"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["sos-active-account"],
    });

    // 服务端回「已结束」（SOS_ALREADY_FINALIZED）时没有单据可写：只重拉
    invalidate.mockClear();
    await run(() => onConfirmed("s2"));
    expect(qc.getQueryData(["sos", "s2"])).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sos", "s2"] });
  });
});

describe("其余实时消息与前后台", () => {
  it("device_status：详情缓存整体替换、列表里那一行合并；电量提醒按头盔名，不在列表的用设备号", async () => {
    jest
      .mocked(devicesApi.list)
      .mockResolvedValue([dev("h1", { name: "通勤盔" }), dev("h2")]);
    await mountBridge();
    const status = statusOf({ battery: 12 });
    await wsPush("device_status", { deviceId: "h1", ...status });
    expect(qc.getQueryData(["device-status", "h1"])).toEqual(status);
    expect(qc.getQueryData(["devices"])).toEqual([
      { ...dev("h1", { name: "通勤盔" }), ...status },
      dev("h2"),
    ]);
    expect(checkBatteryAlert).toHaveBeenCalledWith("h1", "通勤盔", status);

    await wsPush("device_status", { deviceId: "h9", ...status });
    expect(checkBatteryAlert).toHaveBeenLastCalledWith("h9", "h9", status);
    expect(
      qc.getQueryData<DevicePublic[]>(["devices"])?.map((d) => d.deviceId),
    ).toEqual(["h1", "h2"]);
  });

  it("device_status 比设备列表先到：只写详情缓存，不凭空造一份列表（半截列表会被链路当成已绑定的全部）", async () => {
    jest.mocked(devicesApi.list).mockRejectedValue(offline());
    await mountBridge();
    const status = statusOf();
    await wsPush("device_status", { deviceId: "h1", ...status });
    expect(qc.getQueryData(["device-status", "h1"])).toEqual(status);
    expect(qc.getQueryData(["devices"])).toBeUndefined();
    expect(checkBatteryAlert).toHaveBeenCalledWith("h1", "h1", status);
  });

  it.each(["risk_event", "device_event"] as const)(
    "%s：事件页缓存失效、立即刷新",
    async (type) => {
      await mountBridge();
      const invalidate = jest.spyOn(qc, "invalidateQueries");
      await wsPush(type, { eventId: "e1", deviceId: "h1" });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["events"] });
    },
  );

  it("location_update：同一顶只留更新的点，乱序到达的旧点不往回跳", async () => {
    await mountBridge();
    const fix = (timestamp: string): WsLocationData => ({
      deviceId: "h1",
      latitude: 22.54,
      longitude: 114.06,
      coordinateSystem: "wgs84",
      accuracy: 5,
      speed: 3,
      heading: 90,
      altitude: null,
      timestamp,
      receivedAt: timestamp,
    });
    await wsPush("location_update", fix("2026-10-18T02:00:10.000Z"));
    expect(qc.getQueryData(["device-location", "h1"])).toEqual(
      fix("2026-10-18T02:00:10.000Z"),
    );
    await wsPush("location_update", fix("2026-10-18T02:00:05.000Z"));
    expect(qc.getQueryData(["device-location", "h1"])).toEqual(
      fix("2026-10-18T02:00:10.000Z"),
    );
    await wsPush("location_update", fix("2026-10-18T02:00:20.000Z"));
    // 0.5 秒窗口内来的新点先留着，窗口末尾写（合并写，见下一条）
    await act(async () => {
      await new Promise((r) => setTimeout(r, LOCATION_WRITE_MS + 100));
    });
    expect(qc.getQueryData(["device-location", "h1"])).toEqual(
      fix("2026-10-18T02:00:20.000Z"),
    );
  });

  describe("location_update 合并写（优化清单 6：积压补传时一秒十几个点，地图不逐条重画）", () => {
    const fixAt = (deviceId: string, sec: number): WsLocationData => ({
      deviceId,
      latitude: 22.54,
      longitude: 114.06,
      coordinateSystem: "wgs84",
      accuracy: 5,
      speed: 3,
      heading: 90,
      altitude: null,
      timestamp: new Date(Date.UTC(2026, 9, 18, 2, 0, sec)).toISOString(),
      receivedAt: new Date(Date.UTC(2026, 9, 18, 2, 0, sec)).toISOString(),
    });
    /** 数某顶头盔位置缓存真正被写了几次（订阅方据此重画） */
    const countWrites = (deviceId: string) => {
      const box = { n: 0 };
      const unsub = qc.getQueryCache().subscribe((e) => {
        if (
          e.type === "updated" &&
          e.action.type === "success" &&
          e.query.queryKey[0] === "device-location" &&
          e.query.queryKey[1] === deviceId
        )
          box.n += 1;
      });
      return { box, unsub };
    };
    const waitWindow = () =>
      act(async () => {
        await new Promise((r) => setTimeout(r, LOCATION_WRITE_MS + 100));
      });

    it("一下来 15 个点：窗口里第一个立刻写，其余合并成窗口末尾一次（写最新的那个）", async () => {
      await mountBridge();
      const { box, unsub } = countWrites("h1");
      for (let i = 1; i <= 15; i += 1) {
        await wsPush("location_update", fixAt("h1", i));
      }
      expect(box.n).toBe(1);
      expect(qc.getQueryData(["device-location", "h1"])).toEqual(
        fixAt("h1", 1),
      );
      await waitWindow();
      expect(box.n).toBe(2);
      expect(qc.getQueryData(["device-location", "h1"])).toEqual(
        fixAt("h1", 15),
      );
      unsub();
    });

    it("不比缓存新的点（补传的旧点、重复的乱序点）不写缓存，订阅方不重画", async () => {
      await mountBridge();
      await wsPush("location_update", fixAt("h1", 30));
      await waitWindow();
      const { box, unsub } = countWrites("h1");
      await wsPush("location_update", fixAt("h1", 10));
      await waitWindow();
      await wsPush("location_update", fixAt("h1", 20));
      await waitWindow();
      expect(box.n).toBe(0);
      expect(qc.getQueryData(["device-location", "h1"])).toEqual(
        fixAt("h1", 30),
      );
      unsub();
    });

    it("手机时间往回拨 1 小时：不会把窗口拉长到一小时、位置照样立刻写（10-25 审查）", async () => {
      await mountBridge();
      const real = Date.now();
      await wsPush("location_update", fixAt("h1", 1));
      const now = jest.spyOn(Date, "now").mockReturnValue(real - 3_600_000);
      try {
        await wsPush("location_update", fixAt("h1", 2));
        expect(qc.getQueryData(["device-location", "h1"])).toEqual(
          fixAt("h1", 2),
        );
        await wsPush("location_update", fixAt("h1", 3));
        await waitWindow();
        expect(qc.getQueryData(["device-location", "h1"])).toEqual(
          fixAt("h1", 3),
        );
      } finally {
        now.mockRestore();
      }
    });

    it("两顶头盔各算各的窗口：都立刻写；坏消息（data 不是对象 / 没有设备号）不写", async () => {
      await mountBridge();
      await wsPush("location_update", fixAt("h1", 1));
      await wsPush("location_update", fixAt("h2", 1));
      expect(qc.getQueryData(["device-location", "h1"])).toEqual(
        fixAt("h1", 1),
      );
      expect(qc.getQueryData(["device-location", "h2"])).toEqual(
        fixAt("h2", 1),
      );
      const write = jest.spyOn(qc, "setQueryData");
      for (const bad of [null, "x", { latitude: 1 }]) {
        await wsPush("location_update", bad as never);
      }
      expect(write).not.toHaveBeenCalled();
    });
  });

  it("device_command：交给中转写头盔；回执完成后才刷新设置页（不抢在回执前拉到旧状态）", async () => {
    await mountBridge();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    let finish!: (acked: boolean) => void;
    jest
      .mocked(handleDeviceCommand)
      .mockReturnValueOnce(new Promise((r) => (finish = r)));
    const cmd: WsDeviceCommandData = {
      deviceId: "h1",
      commandId: "c1",
      type: "set_config",
      params: { volume: 3 },
      issuedAt: "2026-10-18T02:00:00.000Z",
    };
    await wsPush("device_command", cmd);
    expect(handleDeviceCommand).toHaveBeenCalledWith(cmd);
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["device-settings", "h1"],
    });
  });

  it("device_command 没送达（头盔不在这台身边，比如同账号另一台手机下发的）：也刷新设置页，让它进 2 秒快轮询跟上头盔最终执行的值（优化清单 2）", async () => {
    await mountBridge();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    jest.mocked(handleDeviceCommand).mockResolvedValue(false);
    await wsPush("device_command", {
      deviceId: "h2",
      commandId: "c2",
      type: "set_config",
      params: { light: 3 },
      issuedAt: "2026-10-18T02:00:00.000Z",
    });
    expect(handleDeviceCommand).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["device-settings", "h2"],
    });
  });

  it("device_command 坏消息（data 是 null / 字符串 / 没有命令号）：不交给中转、不刷新，也不抛出没人接的错（10-25 iOS 注入）", async () => {
    await mountBridge();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    for (const bad of [
      null,
      "x",
      { deviceId: "h1", type: "set_config", params: { light: 1 } },
      { commandId: 7, deviceId: "h1" },
    ]) {
      await wsPush("device_command", bad as never);
    }
    expect(handleDeviceCommand).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("device_status 带着越界 / 错类型的值：写进缓存前规整（电量 'x' → 没有、在线 'yes' → 不在线、充电 'no' → 不知道）；data 不是对象就不写（优化清单 8）", async () => {
    await mountBridge();
    await wsPush("device_status", {
      deviceId: "h1",
      battery: "x",
      online: "yes",
      charging: "no",
      lastSeenAt: "nope",
      sleeping: false,
      signalLevel: 3,
      firmwareVersion: null,
    } as never);
    expect(qc.getQueryData(["device-status", "h1"])).toMatchObject({
      battery: null,
      online: false,
      charging: null,
      lastSeenAt: null,
      signalLevel: 3,
    });
    const write = jest.spyOn(qc, "setQueryData");
    for (const bad of [null, "x", { battery: 50 }]) {
      await wsPush("device_status", bad as never);
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("device_status 只带了一部分字段：列表行只合并带了的，没带的（电量 / 充电）不被规整补的 null 盖掉（10-25 审查）", async () => {
    await mountBridge();
    qc.setQueryData(
      ["devices"],
      [dev("h1", { battery: 80, charging: true, online: false })],
    );
    await wsPush("device_status", { deviceId: "h1", online: true } as never);
    const row = qc
      .getQueryData<
        {
          deviceId: string;
          battery: number | null;
          charging: boolean | null;
          online: boolean;
        }[]
      >(["devices"])
      ?.find((d) => d.deviceId === "h1");
    expect(row).toMatchObject({ battery: 80, charging: true, online: true });
  });

  it("认不出的消息类型（服务端先上了新类型）：忽略，不碰缓存", async () => {
    await mountBridge();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    const write = jest.spyOn(qc, "setQueryData");
    await wsPush("firmware_update" as never, { deviceId: "h1" });
    expect(invalidate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("回到前台：WS 不等退避立刻重连、设备列表重拉；进后台：按缓存给进行中的单补弹锁屏提醒；inactive（来电 / 控制中心）不弹", async () => {
    await mountBridge();
    await wsPush("sos_update", sosOf());
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    jest.mocked(showSosAlertIfBackground).mockClear();

    await setAppState("inactive");
    expect(showSosAlertIfBackground).not.toHaveBeenCalled();
    await setAppState("background");
    expect(showSosAlertIfBackground).toHaveBeenCalledWith(
      "s1",
      "h1",
      DEADLINE,
      undefined,
      "通勤盔",
    );
    expect(realtimeClient.kick).not.toHaveBeenCalled();

    await setAppState("active");
    expect(realtimeClient.kick).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["devices"] });
  });
});

describe("实时通道半开时核对进行中的求救（11-01 模拟器实测整单不弹页）", () => {
  const pendingNow = () =>
    jest.mocked(sosApi.activeForAccount).mockResolvedValue({
      items: [sosOf()],
      total: 1,
      page: 1,
      pageSize: 20,
    } as never);

  it("回前台按账号核对：服务端有单、WS 没推过来 → 拉起倒计时页并换掉这条连接", async () => {
    await mountBridge();
    jest.mocked(sosApi.activeForAccount).mockClear();
    pendingNow();
    await setAppState("background");
    await setAppState("active");
    await act(async () => {
      await Promise.resolve();
    });
    expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(realtimeClient.reconnect).toHaveBeenCalledTimes(1);
  });

  it("这单 WS 已经推过：回前台核对不重开页面，也不动连接", async () => {
    await mountBridge();
    await wsPush("sos_update", sosOf());
    jest.mocked(router.push).mockClear();
    pendingNow();
    await setAppState("background");
    await setAppState("active");
    await act(async () => {
      await Promise.resolve();
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(realtimeClient.reconnect).not.toHaveBeenCalled();
  });

  it("前台每 20 s 核对一次；倒计时页在屏上、在后台时都不查", async () => {
    const spy = jest.spyOn(global, "setInterval");
    await mountBridge();
    const tick = spy.mock.calls.find(([, ms]) => ms === 20_000)?.[0] as
      (() => void) | undefined;
    spy.mockRestore();
    expect(tick).toBeDefined();
    const appState = AppState as { currentState: string };
    const was = appState.currentState;
    appState.currentState = "active";
    try {
      jest.mocked(sosApi.activeForAccount).mockClear();
      pendingNow();
      await run(() => tick?.());
      expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenCalledTimes(1);

      jest.mocked(sosApi.activeForAccount).mockClear();
      sosScreen.mounted = true;
      await run(() => tick?.());
      expect(sosApi.activeForAccount).not.toHaveBeenCalled();
      sosScreen.mounted = false;

      appState.currentState = "background";
      await run(() => tick?.());
      expect(sosApi.activeForAccount).not.toHaveBeenCalled();
    } finally {
      appState.currentState = was;
    }
  });
});

describe("冷启动补拉与设备列表的先后（B 线 F-10）", () => {
  it("冷启动补拉时一台目标都没有（首拉失败且没有缓存）：列表之后拉到了再补拉一次，只补这一次", async () => {
    jest.mocked(devicesApi.list).mockRejectedValueOnce(offline());
    await mountBridge();
    expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
    expect(sosApi.active).not.toHaveBeenCalled();

    jest.mocked(sosApi.active).mockResolvedValue({ sos: sosOf() });
    // 退避重试拉到了列表
    await run(() => void devicesLoad.load?.());
    expect(setBleTargets).toHaveBeenLastCalledWith(["h1"]);
    expect(sosApi.active).toHaveBeenCalledWith("h1");
    expect(devLog).toHaveBeenCalledWith(
      "SOS",
      "设备列表到位后补拉发现进行中 SOS s1",
    );
    expect(router.push).toHaveBeenCalledTimes(1);

    jest.mocked(sosApi.activeForAccount).mockClear();
    await run(() => qc.setQueryData(["devices"], [dev("h1"), dev("h2")]));
    expect(setBleTargets).toHaveBeenLastCalledWith(["h1", "h2"]);
    expect(sosApi.activeForAccount).not.toHaveBeenCalled();
  });

  it("冷启动补拉时手上有目标：列表之后到了也不再补拉", async () => {
    jest.mocked(devicesApi.list).mockRejectedValueOnce(offline());
    jest.mocked(loadCachedTargets).mockResolvedValue(["h1"]);
    await mountBridge();
    jest.mocked(sosApi.activeForAccount).mockClear();
    await run(() => void devicesLoad.load?.());
    expect(setBleTargets).toHaveBeenLastCalledWith(["h1"]);
    expect(sosApi.activeForAccount).not.toHaveBeenCalled();
  });
});

describe("冷启动补拉不等设备列表（10-31：弱网下列表最坏 31 s，不在前台时重试还被暂停，60 s 倒计时等不起）", () => {
  const account = (deviceName: string | null) => ({
    items: [{ ...sosOf({ sosId: "s7", deviceId: "h1" }), deviceName }],
    total: 1,
    page: 1,
    pageSize: 100,
  });

  it("列表一直没回来：缓存目标读完就走账号级接口，拉起倒计时页、放行授权框，不用等列表", async () => {
    jest.mocked(devicesApi.list).mockReturnValue(new Promise(() => undefined));
    jest.mocked(loadCachedTargets).mockResolvedValue(["h1"]);
    jest.mocked(sosApi.activeForAccount).mockResolvedValue(account(null));
    await mountBridge();
    expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/sos-active?sosId=s7&deviceId=h1",
    );
    const released = jest.fn();
    void jest.mocked(holdPermissionPromptUntil).mock.calls[0][0].then(released);
    await flush();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("缓存目标还在读：先不补拉（读完才知道退回逐台查时查谁）", async () => {
    const cached = deferred<string[]>();
    jest.mocked(loadCachedTargets).mockReturnValue(cached.promise);
    await mountBridge();
    expect(sosApi.activeForAccount).not.toHaveBeenCalled();
    await run(() => cached.resolve(["h1"]));
    expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
  });

  it("首次登录没有缓存目标、列表晚到：先补拉一次，列表到了按 F-10 再补一次；同一单不叠两页", async () => {
    const list = deferred<DevicePublic[]>();
    jest.mocked(devicesApi.list).mockReturnValue(list.promise);
    jest.mocked(sosApi.activeForAccount).mockResolvedValue(account(null));
    await mountBridge();
    expect(sosApi.activeForAccount).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledTimes(1);

    await run(() => list.resolve([dev("h1")]));
    expect(sosApi.activeForAccount).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["写账号级接口带回来的头盔名，不写设备号", "通勤盔", "通勤盔"],
    ["服务端也没有名字（头盔已转给别人、没起过名）才退成设备号", null, "h1"],
  ])("列表没到时的锁屏提醒：%s", async (_label, deviceName, shown) => {
    jest.mocked(devicesApi.list).mockReturnValue(new Promise(() => undefined));
    jest.mocked(sosApi.activeForAccount).mockResolvedValue(account(deviceName));
    await mountBridge();
    expect(showSosAlertIfBackground).toHaveBeenLastCalledWith(
      "s7",
      "h1",
      DEADLINE,
      undefined,
      shown,
    );
  });

  it("列表已在缓存：锁屏提醒以列表里的名字为准", async () => {
    qc.setQueryData<DevicePublic[]>(
      ["devices"],
      [dev("h1", { name: "新名字" })],
    );
    jest.mocked(devicesApi.list).mockReturnValue(new Promise(() => undefined));
    jest.mocked(sosApi.activeForAccount).mockResolvedValue(account("旧名字"));
    await mountBridge();
    expect(showSosAlertIfBackground).toHaveBeenLastCalledWith(
      "s7",
      "h1",
      DEADLINE,
      undefined,
      "新名字",
    );
  });
});

describe("界面拆掉时的清理", () => {
  it("退出登录：拆掉这次的订阅，并逐项停掉全 App 共用的连接与状态（WS、上行队列、蓝牙链路、电量提醒、各回调、拉起登记、锁屏提醒、推送别名）", async () => {
    await mountBridge();
    presentedSos.current.add("s1");
    await logout();
    expectSharedStopped();
    expectDetached();

    // 查询缓存和账号变化的订阅也拆了
    jest.mocked(setBleTargets).mockClear();
    await run(() => qc.setQueryData(["devices"], [dev("h2")]));
    expect(setBleTargets).not.toHaveBeenCalled();
    await setAuth({ user: profile("u2") });
    expect(startRelayUplink).not.toHaveBeenCalledWith("u2");
    expect(loadCachedTargets).not.toHaveBeenCalledWith("u2");
  });

  it("退出登录之后才回来的异步结果：不再起链路、不再做冷启动补拉", async () => {
    const permission = deferred<void>();
    const cached = deferred<string[]>();
    jest.mocked(ensureSosAlertPermission).mockReturnValue(permission.promise);
    jest.mocked(loadCachedTargets).mockReturnValue(cached.promise);
    jest.mocked(devicesApi.list).mockRejectedValue(offline());
    await mountBridge();
    await logout();
    await run(() => {
      permission.resolve();
      cached.resolve(["h7"]);
    });
    expect(startBleLink).not.toHaveBeenCalled();
    expect(sosApi.activeForAccount).not.toHaveBeenCalled();
  });

  it("档案晚到后去读他存下的目标、读回来时已经退出登录：不再动链路目标", async () => {
    useAuthStore.setState({ user: null });
    const cachedU1 = deferred<string[]>();
    jest
      .mocked(loadCachedTargets)
      .mockImplementation((uid) =>
        uid === "u1" ? cachedU1.promise : Promise.resolve([]),
      );
    jest.mocked(devicesApi.list).mockRejectedValue(offline());
    await mountBridge();
    await setAuth({ user: profile("u1") });
    await logout();
    await run(() => cachedU1.resolve(["h3"]));
    expect(setBleTargets).not.toHaveBeenCalled();
  });

  it("仍登录时界面被拆（安卓从多任务划掉、进程被推送服务撑着）：订阅和共享连接都留着；来单照样弹锁屏提醒，但不跳页（导航器没挂着）", async () => {
    const ui = await mountBridge();
    await ui.unmount();
    expect(bridgeUi.attached).toBe(false);
    expectSharedRunning();
    expect(mockWs.listeners.size).toBe(1);
    expect(mockWs.stateListeners.size).toBe(1);
    expect(appStateListeners.size).toBe(1);
    expect(devicesLoad.cancel).not.toHaveBeenCalled();
    expect(devLog).toHaveBeenCalledWith(
      "realtime",
      "界面被拆、仍登录：连接和订阅都留着，等界面回来接手",
    );

    await wsPush("sos_update", sosOf());
    expect(showSosAlertIfBackground).toHaveBeenCalledWith(
      "s1",
      "h1",
      DEADLINE,
      undefined,
      "通勤盔",
    );
    expect(router.push).not.toHaveBeenCalled();
    // 绑定变化照样同步给链路
    await run(() => qc.setQueryData(["devices"], [dev("h1"), dev("h2")]));
    expect(setBleTargets).toHaveBeenLastCalledWith(["h1", "h2"]);
  });

  it("界面回来：接手孤儿——拆掉旧订阅（同一条消息不处理两遍）、共享连接接着用；清掉「拉起过」的登记，补拉把划掉期间来的单重新拉起", async () => {
    const ui = await mountBridge();
    await ui.unmount();
    await wsPush("sos_update", sosOf());
    expect(presentedSos.current.has("s1")).toBe(true);
    expect(router.push).not.toHaveBeenCalled();

    jest.mocked(sosApi.active).mockResolvedValue({ sos: sosOf() });
    await mountBridge();
    expect(bridgeUi.attached).toBe(true);
    expect(mockWs.listeners.size).toBe(1);
    expect(mockWs.stateListeners.size).toBe(1);
    expect(appStateListeners.size).toBe(1);
    expect(devicesLoad.cancel).toHaveBeenCalledTimes(1);
    expectSharedRunning();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(
      "/sos-active?sosId=s1&deviceId=h1",
    );

    jest.mocked(checkBatteryAlert).mockClear();
    await wsPush("device_status", { deviceId: "h1", ...statusOf() });
    expect(checkBatteryAlert).toHaveBeenCalledTimes(1);
  });

  it("划掉后、界面回来之前会话结束（被动登出）：孤儿的订阅和共享连接全部拆掉；token 只是轮换不算登出", async () => {
    const ui = await mountBridge();
    await ui.unmount();
    await setAuth({ tokens: tokens(2) });
    expectSharedRunning();
    expect(mockWs.listeners.size).toBe(1);

    presentedSos.current.add("s1");
    await logout();
    expectSharedStopped();
    expectDetached();
  });

  it("界面重建（安卓改系统字体 / 语言：新根先挂上、旧根后卸下）：旧根只拆自己的订阅，共享连接留给新根，也不留孤儿；之后退出登录由新根全部停掉", async () => {
    const oldRoot = await mountBridge();
    await mountBridge();
    expect(mockWs.listeners.size).toBe(2);

    await oldRoot.unmount();
    expectSharedRunning();
    expect(devLog).toHaveBeenCalledWith(
      "realtime",
      "界面重建：新界面已接管，旧界面不拆共享连接",
    );
    expect(mockWs.listeners.size).toBe(1);
    expect(mockWs.stateListeners.size).toBe(1);
    expect(appStateListeners.size).toBe(1);
    expect(bridgeUi.attached).toBe(true);
    await wsPush("sos_update", sosOf());
    expect(router.push).toHaveBeenCalledTimes(1);

    await logout();
    expectSharedStopped();
    expectDetached();
  });

  it("退出登录时新旧两个根都还在：旧根只拆自己的，共享连接由最新那次停、只停一次", async () => {
    await mountBridge();
    await mountBridge();
    await logout();
    expectSharedStopped();
    expectDetached();
  });
});
