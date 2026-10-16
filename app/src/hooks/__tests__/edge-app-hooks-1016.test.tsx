// App 自己的几个查询 / 状态 hook 的边界（2026-10-16）：验证码读秒、设备设置轮询与下发、安全页的连接结论 /
// 进行中求救 / 当前头盔选择 / 通知权限 / 演练入口、更换头盔提醒的接线。用真 QueryClient + 真 zustand store 渲染。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as RN from "react-native";
import type { DevicePublic, Sos } from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { authApi } from "@/api/auth";
import { sosApi } from "@/api/sos";
import { readNotifyPermissionAfterAsk } from "@/services/notify-permission";
import { STILL_MS } from "@/services/switch-reminder";
import { useAuthStore } from "@/stores/auth-store";
import { useBleStore } from "@/stores/ble-store";
import { useCurrentHelmetStore } from "@/stores/current-helmet-store";
import { useDrillStore } from "@/stores/drill-store";
import { useSwitchReminderStore } from "@/stores/switch-reminder-store";
import { useDeviceSettings } from "../use-device-settings";
import {
  useCurrentHelmetChoice,
  useHelmetLinks,
  useNotifyPermission,
  usePendingSos,
  useSosDrill,
} from "../use-safety";
import { RESEND_SECONDS, useSmsCode } from "../use-sms-code";
import { useSwitchHelmetWatcher } from "../use-switch-reminder";

// App 源码解析到 app/node_modules/react，渲染器用根目录那份：让两边用同一份（见 edge-small-hooks-1016）
jest.mock("react", () => jest.requireActual("../../../../node_modules/react"));
jest.mock("@/api/devices", () => ({
  devicesApi: {
    settings: jest.fn(),
    putSettings: jest.fn(),
    list: jest.fn(),
    latestLocation: jest.fn(),
  },
}));
jest.mock("@/api/auth", () => ({ authApi: { sendSmsCode: jest.fn() } }));
jest.mock("@/api/sos", () => ({
  sosApi: { active: jest.fn(), activeForAccount: jest.fn() },
}));
jest.mock("@/services/notify-permission", () => ({
  readNotifyPermissionAfterAsk: jest.fn(),
}));
jest.mock("expo-router", () => ({ router: { navigate: jest.fn() } }));
jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

type AnyMock = jest.Mock<(...args: any[]) => any>;
const settingsMock = devicesApi.settings as unknown as AnyMock;
const putMock = devicesApi.putSettings as unknown as AnyMock;
const smsMock = authApi.sendSmsCode as unknown as AnyMock;
const activeMock = sosApi.active as unknown as AnyMock;
const accountMock = sosApi.activeForAccount as unknown as AnyMock;
const permMock = readNotifyPermissionAfterAsk as unknown as AnyMock;

let qc: QueryClient;
const renderers: ReactTestRenderer[] = [];
async function renderHook<T>(hook: () => T): Promise<{ current: T }> {
  const box = {} as { current: T };
  function Probe() {
    box.current = hook();
    return null;
  }
  await act(async () => {
    renderers.push(
      create(
        <QueryClientProvider client={qc}>
          <Probe />
        </QueryClientProvider>,
      ),
    );
  });
  return box;
}
async function settle(until: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && !until(); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const dev = (deviceId: string, online: boolean): DevicePublic => ({
  deviceId,
  name: null,
  bindCode: null,
  boundAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  online,
  lastSeenAt: null,
  battery: null,
  charging: null,
  signalLevel: null,
  sleeping: false,
  firmwareVersion: null,
});
const signIn = (id: string) =>
  useAuthStore.setState({
    user: {
      id,
      phone: "13900000042",
      nickname: null,
      avatarUrl: null,
      createdAt: "2026-10-01T00:00:00Z",
    } as never,
  });

beforeEach(() => {
  qc = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
  for (const m of [
    settingsMock,
    putMock,
    smsMock,
    activeMock,
    accountMock,
    permMock,
  ])
    m.mockReset();
  useAuthStore.setState({ user: null });
  useBleStore.setState({ adapter: "on", links: {} });
  useCurrentHelmetStore.setState({ chosen: {} });
  useDrillStore.setState({ seen: {} });
  useSwitchReminderStore.setState({ enabled: {}, asked: {}, prompt: null });
});
afterEach(async () => {
  await act(async () => {
    for (const r of renderers.splice(0)) r.unmount();
  });
  qc.clear();
  jest.restoreAllMocks();
});

describe("useSmsCode：发验证码与重发读秒", () => {
  it("发出去之后读秒从 60 开始、按钮禁用；号码首尾空白去掉再发", async () => {
    smsMock.mockResolvedValue(undefined);
    const r = await renderHook(() => useSmsCode("register"));
    expect(r.current).toMatchObject({
      sending: false,
      cooldown: 0,
      disabled: false,
    });
    await act(async () => {
      await r.current.send("  13900000042 ");
    });
    expect(smsMock).toHaveBeenCalledWith({
      phone: "13900000042",
      purpose: "register",
    });
    expect(r.current.cooldown).toBe(RESEND_SECONDS);
    expect(r.current.disabled).toBe(true);
  });

  it("发送失败：抛给页面，不进入读秒、按钮恢复可点", async () => {
    smsMock.mockRejectedValue(
      Object.assign(new Error("429"), { code: "SMS_CODE_TOO_FREQUENT" }),
    );
    const r = await renderHook(() => useSmsCode("reset_password"));
    let caught: unknown;
    await act(async () => {
      await r.current.send("13900000042").catch((e: unknown) => {
        caught = e;
      });
    });
    expect((caught as { code: string }).code).toBe("SMS_CODE_TOO_FREQUENT");
    expect(r.current).toMatchObject({
      sending: false,
      cooldown: 0,
      disabled: false,
    });
  });

  it("请求在途时按钮禁用（防连点重复发码）", async () => {
    let resolve!: () => void;
    smsMock.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
    const r = await renderHook(() => useSmsCode("change_phone"));
    let pending!: Promise<void>;
    await act(async () => {
      pending = r.current.send("13900000042");
    });
    expect(r.current).toMatchObject({ sending: true, disabled: true });
    await act(async () => {
      resolve();
      await pending;
    });
    expect(r.current.sending).toBe(false);
  });

  it("读秒按墙钟走：过了 59.5 秒还剩 1 秒，过了 60 秒可以重发", async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 16, 1, 0, 0) });
    try {
      smsMock.mockResolvedValue(undefined);
      const r = await renderHook(() => useSmsCode("register"));
      await act(async () => {
        await r.current.send("13900000042");
      });
      await act(async () => {
        jest.advanceTimersByTime(59_500);
      });
      expect(r.current.cooldown).toBe(1);
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
      expect(r.current.cooldown).toBe(0);
      expect(r.current.disabled).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("useDeviceSettings：轮询节奏与下发", () => {
  const intervalOf = (deviceId: string) => {
    const q = qc
      .getQueryCache()
      .find({ queryKey: ["device-settings", deviceId] })!;
    // refetchInterval 是观察者上的选项，Query 自己的类型里没有；运行时 options 里带着
    const fn = (q.options as { refetchInterval?: unknown }).refetchInterval as (
      query: typeof q,
    ) => number;
    return fn(q);
  };

  it.each([
    ["pending", 2_000],
    ["delivered", 2_000],
    ["success", 30_000],
    ["failed", 30_000],
    ["offline", 30_000],
  ])("最近一条命令 %s：%d 毫秒再看一次", async (status, ms) => {
    settingsMock.mockResolvedValue({
      settings: { volume: 50 },
      lastCommand: { status, params: { volume: 50 } },
    });
    const r = await renderHook(() => useDeviceSettings("h1"));
    await settle(() => r.current.values !== undefined);
    expect(intervalOf("h1")).toBe(ms);
  });

  it("还没拿到 / 没有任何命令：30 秒；lastCommand 缺省时给 null 不是 undefined", async () => {
    settingsMock.mockResolvedValue({ settings: {} });
    const r = await renderHook(() => useDeviceSettings("h2"));
    expect(intervalOf("h2")).toBe(30_000);
    await settle(() => r.current.values !== undefined);
    expect(r.current.lastCommand).toBeNull();
    expect(intervalOf("h2")).toBe(30_000);
  });

  it("下发成功：只发这一项，随后重新拉设置；下发中 sending 为真，结束复位；交回新建的命令", async () => {
    settingsMock.mockResolvedValue({
      settings: { volume: 50 },
      lastCommand: null,
    });
    let resolvePut!: (cmd: unknown) => void;
    putMock.mockImplementation(
      () => new Promise((r) => (resolvePut = r)),
    );
    const r = await renderHook(() => useDeviceSettings("h3"));
    await settle(() => r.current.values !== undefined);
    const before = settingsMock.mock.calls.length;
    let sent!: Promise<unknown>;
    await act(async () => {
      sent = r.current.send("light", 2);
    });
    expect(putMock).toHaveBeenCalledWith("h3", { settings: { light: 2 } });
    expect(r.current.sending).toBe(true);
    await act(async () => resolvePut({ commandId: "c9", status: "pending" }));
    await expect(sent).resolves.toEqual({ commandId: "c9", status: "pending" });
    await settle(
      () => !r.current.sending && settingsMock.mock.calls.length > before,
    );
    expect(r.current.sending).toBe(false);
    expect(settingsMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("下发失败：弹窗说明（标题 + 具体原因），sending 复位，当前值不变", async () => {
    settingsMock.mockResolvedValue({
      settings: { volume: 50 },
      lastCommand: null,
    });
    putMock.mockRejectedValue(new Error("offline"));
    const alert = jest
      .spyOn(RN.Alert, "alert")
      .mockImplementation(() => undefined);
    const r = await renderHook(() => useDeviceSettings("h4"));
    await settle(() => r.current.values !== undefined);
    let sent!: Promise<unknown>;
    await act(async () => {
      sent = r.current.send("volume", 80);
    });
    // 没发出去：交回 null（调用方据此撤掉乐观值），不是抛错
    await expect(sent).resolves.toBeNull();
    await settle(() => alert.mock.calls.length > 0);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(r.current.sending).toBe(false);
    expect(r.current.values).toEqual({ volume: 50 });
  });
});

describe("useHelmetLinks：几顶头盔各自的连接结论", () => {
  it("没有链路记录的头盔按 phase 为空处理；有记录的按各自阶段；顺序与设备列表一致", async () => {
    useBleStore.setState({
      adapter: "on",
      links: {
        a: { phase: "connected", eventsReceived: 0, resent: 0 },
        c: { phase: "scanning", eventsReceived: 0, resent: 0 },
      },
    });
    const devices = [
      dev("a", false),
      dev("b", true),
      dev("c", false),
      dev("d", false),
    ];
    const r = await renderHook(() => useHelmetLinks(devices, true));
    expect(r.current).toEqual({
      a: "connected",
      b: "online",
      c: "searching",
      d: "offline",
    });
  });

  it("列表拉取失败（不新鲜）：只有本机连着的那顶能确定，其余待确认", async () => {
    useBleStore.setState({
      adapter: "on",
      links: { a: { phase: "connected", eventsReceived: 0, resent: 0 } },
    });
    const r = await renderHook(() =>
      useHelmetLinks([dev("a", true), dev("b", true)], false),
    );
    expect(r.current).toEqual({ a: "connected", b: "unknown" });
  });

  it("没有头盔：空对象；编号里带「|」也不会串到别的头盔上（阶段按下标对应）", async () => {
    const empty = await renderHook(() => useHelmetLinks([], true));
    expect(empty.current).toEqual({});
    useBleStore.setState({
      adapter: "on",
      links: { "x|y": { phase: "connected", eventsReceived: 0, resent: 0 } },
    });
    const r = await renderHook(() =>
      useHelmetLinks([dev("x|y", false), dev("z", false)], true),
    );
    expect(r.current).toEqual({ "x|y": "connected", z: "offline" });
  });

  it("帧到达只改 lastFrameAt：结论不变（页面不因每一帧重画结论）", async () => {
    useBleStore.setState({
      adapter: "on",
      links: { a: { phase: "connected", eventsReceived: 0, resent: 0 } },
    });
    const devices = [dev("a", false)];
    const r = await renderHook(() => useHelmetLinks(devices, true));
    const first = r.current;
    await act(async () => {
      useBleStore
        .getState()
        .patchLink("a", { lastFrameAt: Date.now(), eventsReceived: 5 });
    });
    expect(r.current).toEqual(first);
  });
});

describe("usePendingSos：所有头盔上进行中的求救", () => {
  const sos = (over: Partial<Sos>): Sos =>
    ({
      sosId: "s",
      deviceId: "a",
      triggerEventId: "e",
      triggerType: "possible_fall",
      status: "pending",
      deadline: "2026-10-16T01:01:00.000Z",
      createdAt: "2026-10-16T01:00:00.000Z",
      updatedAt: "2026-10-16T01:00:00.000Z",
      ...over,
    }) as Sos;

  it("一个账号级请求拿全（不逐台查）：只留 pending 的、按到期先后；解绑后的头盔（不在设备列表里）也在（B 线第 12 项）", async () => {
    accountMock.mockResolvedValue({
      items: [
        sos({
          sosId: "se",
          deviceId: "e",
          deadline: "2026-10-16T01:00:30.000Z",
        }),
        sos({ sosId: "sa", deviceId: "a" }),
        sos({ sosId: "sz", deviceId: "unbound" }),
      ],
      total: 3,
      page: 1,
      pageSize: 100,
    });
    const r = await renderHook(() => usePendingSos(["a", "b", "c", "d", "e"]));
    await settle(() => r.current.length === 3);
    expect(r.current.map((s) => s.sosId)).toEqual(["se", "sa", "sz"]);
    expect(accountMock).toHaveBeenCalledTimes(1);
    expect(activeMock).not.toHaveBeenCalled();
    // 列表里没有的头盔写成「查过了、没有」
    expect(qc.getQueryData(["sos-active", "b"])).toEqual({ sos: null });
  });

  it("WS 推来新单 / 倒计时页取消：不等下一轮轮询，跟着缓存变", async () => {
    accountMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    const r = await renderHook(() => usePendingSos(["a"]));
    await settle(() => accountMock.mock.calls.length > 0);
    expect(r.current).toEqual([]);
    await act(async () => {
      qc.setQueryData(["sos-active", "a"], { sos: sos({ sosId: "sa" }) });
    });
    expect(r.current.map((s) => s.sosId)).toEqual(["sa"]);
    await act(async () => {
      qc.setQueryData(["sos", "sa"], sos({ sosId: "sa", status: "cancelled" }));
    });
    expect(r.current).toEqual([]);
  });

  it("轮询回来的 pending 但这单在本机已是终态（倒计时页刚取消）：不把卡片顶回来", async () => {
    qc.setQueryData(["sos", "sx"], sos({ sosId: "sx", status: "cancelled" }));
    accountMock.mockResolvedValue({
      items: [sos({ sosId: "sx" })],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    const r = await renderHook(() => usePendingSos(["a"]));
    await settle(
      () =>
        accountMock.mock.calls.length > 0 &&
        qc.getQueryData(["sos-active", "a"]) !== undefined,
    );
    expect(r.current).toEqual([]);
  });

  it("没有头盔：空，不发请求", async () => {
    const r = await renderHook(() => usePendingSos([]));
    expect(r.current).toEqual([]);
    expect(accountMock).not.toHaveBeenCalled();
    expect(activeMock).not.toHaveBeenCalled();
  });
});

describe("useCurrentHelmetChoice / useSosDrill", () => {
  it("没登录：ready 立刻为真（不让页面一直等），选择为空；choose 什么都不做", async () => {
    const r = await renderHook(() => useCurrentHelmetChoice());
    expect(r.current).toMatchObject({ chosenId: null, ready: true });
    act(() => r.current.choose("a"));
    expect(useCurrentHelmetStore.getState().chosen).toEqual({});
  });

  it("登录后：读到存储之前 ready 为假；读完（没选过）为真、chosenId 为 null；选了之后是那一台", async () => {
    signIn("u1");
    const r = await renderHook(() => useCurrentHelmetChoice());
    await settle(() => r.current.ready);
    expect(r.current).toMatchObject({ chosenId: null, ready: true });
    await act(async () => r.current.choose("h9"));
    expect(r.current.chosenId).toBe("h9");
  });

  it("演练入口：只有确定没打开过才显示；读到之前不显示；点开就记为打开过", async () => {
    signIn("u2");
    const r = await renderHook(() => useSosDrill());
    await settle(() => useDrillStore.getState().seen.u2 !== undefined);
    expect(r.current.unseen).toBe(true);
    await act(async () => r.current.open());
    expect(r.current.unseen).toBe(false);
  });

  it("演练入口：没登录时不显示（没有可读的记录）", async () => {
    const r = await renderHook(() => useSosDrill());
    expect(r.current.unseen).toBe(false);
  });
});

describe("useNotifyPermission", () => {
  it("没查到之前是 null；回到前台再查一次；卸载后迟到的结果不再写", async () => {
    const listeners: ((s: string) => void)[] = [];
    jest.spyOn(RN.AppState, "addEventListener").mockImplementation(((
      _: string,
      cb: (s: string) => void,
    ) => {
      listeners.push(cb);
      return { remove: () => listeners.splice(listeners.indexOf(cb), 1) };
    }) as never);
    permMock.mockResolvedValueOnce("denied").mockResolvedValueOnce("granted");
    const r = await renderHook(() => useNotifyPermission());
    await settle(() => r.current !== null);
    expect(r.current).toBe("denied");
    await act(async () => listeners.forEach((cb) => cb("background")));
    expect(permMock).toHaveBeenCalledTimes(1);
    await act(async () => listeners.forEach((cb) => cb("active")));
    await settle(() => r.current === "granted");
    expect(r.current).toBe("granted");
  });
});

describe("useSwitchHelmetWatcher：更换头盔提醒的接线", () => {
  const T0 = Date.UTC(2026, 9, 16, 1, 0, 0);
  let now = T0;
  const point = (speed: number) => ({
    latitude: 22.5,
    longitude: 113.9,
    coordinateSystem: "wgs84",
    accuracy: 5,
    speed,
    heading: 0,
    timestamp: new Date(now).toISOString(),
  });
  const setup = (enabled: boolean) => {
    jest.spyOn(Date, "now").mockImplementation(() => now);
    signIn("u3");
    useCurrentHelmetStore.setState({ chosen: { u3: "a" } });
    useSwitchReminderStore.setState({
      enabled: { u3: enabled },
      asked: {},
      prompt: null,
    });
    qc.setQueryData(["devices"], [dev("a", true), dev("b", true)]);
  };
  /** 写一个定位点并等 react-query 把通知发出去（它的通知排在下一个宏任务里） */
  const report = async (id: string, speed: number | null) => {
    await act(async () => {
      qc.setQueryData(["device-location", id], { ...point(0), speed });
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it("当前头盔停满 2 分钟、另一台连续在动：提出「换成 b」；b 掉线后收起", async () => {
    now = T0;
    setup(true);
    await renderHook(() => useSwitchHelmetWatcher());
    await report("a", 0);
    await report("b", 5);
    expect(useSwitchReminderStore.getState().prompt).toBeNull();
    now = T0 + 60_000;
    await report("b", 5);
    expect(useSwitchReminderStore.getState().prompt).toBeNull();
    now = T0 + STILL_MS + 5_000;
    await report("b", 5);
    expect(useSwitchReminderStore.getState().prompt).toEqual({
      currentId: "a",
      otherId: "b",
    });
    await act(async () => {
      qc.setQueryData(["devices"], [dev("a", true), dev("b", false)]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useSwitchReminderStore.getState().prompt).toBeNull();
  });

  it("开关关着：条件满足也不问", async () => {
    now = T0;
    setup(false);
    await renderHook(() => useSwitchHelmetWatcher());
    await report("a", 0);
    await report("b", 5);
    now = T0 + STILL_MS + 5_000;
    await report("b", 5);
    expect(useSwitchReminderStore.getState().prompt).toBeNull();
  });

  it("另一台的定位没有速度（null）：不当成在动", async () => {
    now = T0;
    setup(true);
    await renderHook(() => useSwitchHelmetWatcher());
    await report("a", 0);
    await report("b", null);
    now = T0 + STILL_MS + 5_000;
    await report("b", null);
    expect(useSwitchReminderStore.getState().prompt).toBeNull();
  });

  it("只有一台在线：不看定位、不问", async () => {
    now = T0;
    setup(true);
    qc.setQueryData(["devices"], [dev("a", true), dev("b", false)]);
    await renderHook(() => useSwitchHelmetWatcher());
    await report("b", 5);
    now = T0 + STILL_MS + 5_000;
    await report("b", 5);
    expect(useSwitchReminderStore.getState().prompt).toBeNull();
  });
});
