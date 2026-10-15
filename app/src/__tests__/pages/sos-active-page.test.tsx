// 求救倒计时页（保命链路，只测不改；发现写进 COVERAGE_FINDINGS_1016.md）：
// 服务端权威——数字只按服务端给的 deadline 渲染；取消 / 立即求救调接口，结果以服务端为准；
// 已在别处结束（SOS_ALREADY_FINALIZED）不弹错而是拉权威状态；404 收掉；离线时才信缓存；
// 倒数中拦住 Android 返回键、每秒警报 + 震动（最后 10 秒连震两下）、锁屏通知按钮的取消在路上时不响；
// 结束后撤掉锁屏提醒；已通知页按短信结果写标题；「我还是需要帮助」同一个 eventId 重试；演练不碰服务端。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { AccidentDetail, Sos } from "@helmet/shared";
import { setAudioModeAsync } from "expo-audio";
import * as Haptics from "expo-haptics";
import { AccessibilityInfo, Alert, BackHandler } from "react-native";
import { act } from "react-test-renderer";
import { mockRouter, routerState } from "@/__tests__/helpers/native-mocks";
import {
  makeQueryClient,
  render,
  type Rendered,
} from "@/__tests__/helpers/render";
import { ApiRequestError } from "@/api/client";
import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { relayApi } from "@/api/relay";
import { sosApi } from "@/api/sos";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import {
  enqueueRelayEvent,
  notifyCriticalAccepted,
} from "@/services/ble-relay-uplink";
import { clearSosAlert } from "@/services/sos-alert";
import { presentedSos } from "@/services/sos-sync";
import { useSosCancelStore } from "@/stores/sos-cancel-store";
import { useThemeStore } from "@/stores/theme-store";
import SosActiveScreen from "@/app/sos-active";

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
  ImpactFeedbackStyle: { Light: "light", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));
const mockAlarm = {
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(() => Promise.resolve()),
};
jest.mock("expo-audio", () => ({
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
  useAudioPlayer: () => mockAlarm,
}));
jest.mock("@/hooks/use-keep-awake-safe", () => ({
  useKeepAwakeSafe: jest.fn(),
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("@/services/sos-alert", () => ({
  clearSosAlert: jest.fn(() => Promise.resolve()),
}));
jest.mock("@/services/ble-relay-uplink", () => ({
  enqueueRelayEvent: jest.fn(),
  notifyCriticalAccepted: jest.fn(),
}));
jest.mock("@/api/sos", () => ({
  sosApi: {
    snapshot: jest.fn(),
    cancel: jest.fn(),
    confirm: jest.fn(),
    accidentDetail: jest.fn(),
  },
}));
jest.mock("@/api/contacts", () => ({ contactsApi: { list: jest.fn() } }));
jest.mock("@/api/devices", () => ({ devicesApi: { list: jest.fn() } }));
jest.mock("@/api/relay", () => ({
  ...jest.requireActual<typeof import("@/api/relay")>("@/api/relay"),
  relayApi: { push: jest.fn() },
}));

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const m = <T,>(fn: T) => fn as unknown as jest.Mock;
let qc: QueryClient;
let back: (() => boolean) | null;
let backSpy: ReturnType<typeof jest.spyOn>;
let alert: ReturnType<typeof jest.spyOn>;
let sr: ReturnType<typeof jest.spyOn>;
let srSub: ReturnType<typeof jest.spyOn>;

const sosOf = (over: Partial<Sos> = {}): Sos => ({
  sosId: "s1",
  deviceId: "h1",
  triggerEventId: "e1",
  triggerType: "possible_fall",
  status: "pending",
  deadline: new Date(Date.now() + 45_000).toISOString(),
  createdAt: new Date(Date.now() - 15_000).toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});
/** 每次渲染默认一个新的 QueryClient（测试版不过期，换一次渲染不换客户端的话会读到上一次的缓存） */
const mount = async (fresh = true) => {
  if (fresh) qc = makeQueryClient();
  const r = render(
    <QueryClientProvider client={qc}>
      <SosActiveScreen />
    </QueryClientProvider>,
  );
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
  return r;
};
const tick = async (ms: number) => {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
};
/** 环中间那个大数字 */
const number = (r: Rendered) =>
  r.texts().find((x) => /^\d+$/.test(x) || x === "—");
const slideButton = (r: Rendered) =>
  r.root.find(
    (n) =>
      typeof n.type === "string" &&
      n.props.accessibilityLabel === tr("sos.slideA11y"),
  );

beforeEach(() => {
  jest.useFakeTimers({ now: Date.UTC(2026, 9, 16, 2, 0, 0) });
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  routerState.params = { sosId: "s1", deviceId: "h1" };
  routerState.focused = true;
  presentedSos.current.clear();
  useSosCancelStore.setState({ inFlight: {} } as never);
  qc = makeQueryClient();
  m(sosApi.snapshot).mockImplementation(() => Promise.resolve(sosOf()));
  m(contactsApi.list).mockImplementation(() =>
    Promise.resolve([{ id: "c1", name: "妈妈" }]),
  );
  m(devicesApi.list).mockImplementation(() =>
    Promise.resolve([{ deviceId: "h1", name: "通勤" }]),
  );
  back = null;
  backSpy = jest
    .spyOn(BackHandler, "addEventListener")
    .mockImplementation((_e, h) => {
      back = h as () => boolean;
      return { remove: () => (back = null) } as never;
    });
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  sr = jest
    .spyOn(AccessibilityInfo, "isScreenReaderEnabled")
    .mockImplementation(() => Promise.resolve(false));
  srSub = jest
    .spyOn(AccessibilityInfo, "addEventListener")
    .mockImplementation(() => ({ remove: jest.fn() }) as never);
});
afterEach(() => {
  backSpy.mockRestore();
  alert.mockRestore();
  sr.mockRestore();
  srSub.mockRestore();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("倒数中", () => {
  it("按服务端 deadline 显示剩余秒数并每秒走；登记为已拉起；拦住返回键；写将通知谁", async () => {
    const r = await mount();
    expect(sosApi.snapshot).toHaveBeenCalledWith("s1", "h1");
    expect(presentedSos.current.has("s1")).toBe(true);
    expect(number(r)).toBe("45");
    expect(r.allText()).toContain(tr("sos.fall"));
    expect(r.allText()).toContain(tr("sos.willNotify", { n: 1 }));
    expect(r.texts()).toContain("妈");
    // 数字在每一秒换档后 30 ms 刷新（对着换档的那一刻读时钟）
    await tick(3050);
    expect(number(r)).toBe("42");
    expect(back).not.toBeNull();
    expect(back!()).toBe(true);
  });

  it("警报：音频设成锁屏 / 静音键下也响，每秒重播 + 警示震动；最后 10 秒每秒连震两下", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(
        sosOf({ deadline: new Date(Date.now() + 12_000).toISOString() }),
      ),
    );
    await mount();
    expect(setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
      }),
    );
    const warnings = () =>
      m(Haptics.notificationAsync).mock.calls.filter((c) => c[0] === "warning")
        .length;
    await tick(1000);
    expect(mockAlarm.seekTo).toHaveBeenCalledWith(0);
    expect(warnings()).toBe(1);
    await tick(1000);
    await tick(1000);
    // 剩 9 秒起：每秒两下
    const before = warnings();
    await tick(1000);
    expect(warnings() - before).toBe(2);
  });

  it("警报音播放抛错（锁屏时音频会话激活失败）不把页面打崩", async () => {
    mockAlarm.play.mockImplementation(() => {
      throw new Error("Session activation failed");
    });
    const r = await mount();
    await tick(2050);
    expect(number(r)).toBe("43");
    mockAlarm.play.mockReset();
  });

  it("没有紧急联系人：明说倒计时结束也通知不了人；超过 3 位只露 3 个和 +n", async () => {
    m(contactsApi.list).mockImplementation(() => Promise.resolve([]));
    let r = await mount();
    expect(r.allText()).toContain(tr("sos.noContacts"));
    r.unmount();
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve(
        ["甲", "乙", "丙", "丁"].map((n, i) => ({ id: `c${i}`, name: n })),
      ),
    );
    r = await mount();
    expect(r.allText()).toContain(tr("sos.willNotify", { n: 4 }));
    expect(r.texts()).toContain("+1");
    expect(r.texts()).not.toContain("丁");
  });

  it("账号下两顶以上：写明是哪顶头盔发起的（两顶同时求救时分得清）", async () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        { deviceId: "h1", name: "通勤" },
        { deviceId: "h2", name: "滑雪" },
      ]),
    );
    const r = await mount();
    expect(r.allText()).toContain(tr("sos.fromHelmet", { name: "通勤" }));
  });

  it("补传的旧事件：点明大约多久前发生", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(
        sosOf({
          triggeredAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        }),
      ),
    );
    const r = await mount();
    expect(r.allText()).toContain(tr("sos.lateEventHours", { n: 3 }));
  });

  it("锁屏通知按钮的取消还在路上：滑块写「取消中…」、不响警报", async () => {
    useSosCancelStore.setState({ inFlight: { s1: true } } as never);
    const r = await mount();
    await tick(2000);
    expect(r.allText()).toContain(tr("sos.cancelling"));
    expect(mockAlarm.seekTo).not.toHaveBeenCalled();
    expect(back).toBeNull();
  });
});

describe("取消 / 立即求救", () => {
  it("滑动取消（读屏双击同效）：调取消接口，结果写进缓存 → 已取消页；撤掉锁屏提醒；不再拦返回键", async () => {
    m(sosApi.cancel).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "cancelled" })),
    );
    const r = await mount();
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    await tick(0);
    expect(sosApi.cancel).toHaveBeenCalledWith("s1");
    expect(r.allText()).toContain(tr("sos.cancelledTitle"));
    expect(clearSosAlert).toHaveBeenCalledWith("s1");
    expect(back).toBeNull();
    r.press(tr("sos.close"));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it("立即求救：调确认接口 → 已通知页；短信全部发出时标题写已发出，列出每位联系人", async () => {
    m(sosApi.confirm).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "notified" })),
    );
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve({
        notifications: [
          {
            id: "n1",
            channel: "sms",
            target: "138****0001",
            contactName: "妈妈",
            status: "sent",
          },
          {
            id: "n2",
            channel: "push",
            target: "x",
            contactName: null,
            status: "sent",
          },
        ],
      } as unknown as AccidentDetail),
    );
    const r = await mount();
    r.press(tr("sos.sendNow"));
    await tick(0);
    expect(sosApi.confirm).toHaveBeenCalledWith("s1");
    // 假计时器下，依赖查询（enabled 由另一份缓存翻过来）拿到结果后要等下一次计时器推进才重画；
    // 真计时器下是立即重画的（用最小用例核对过，不是页面的问题）。这里推进到下一次每秒刷新
    await tick(1100);
    expect(r.allText()).toContain(tr("sos.notified.sent"));
    expect(r.allText()).toContain(`${tr("sos.viaSms")} · 138****0001`);
    expect(r.allText()).toContain(tr("accident.notif.sent"));
  });

  it("这单已在别处结束（SOS_ALREADY_FINALIZED）：不弹错，重新拉权威状态", async () => {
    m(sosApi.cancel).mockImplementation(() =>
      Promise.reject(
        new ApiRequestError(409, { code: "SOS_ALREADY_FINALIZED" }),
      ),
    );
    const r = await mount();
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "cancelled" })),
    );
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    await tick(0);
    await tick(0);
    expect(alert).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("sos.cancelledTitle"));
  });

  it("其它失败：弹窗说明，页面还在倒数", async () => {
    m(sosApi.confirm).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = await mount();
    r.press(tr("sos.sendNow"));
    await tick(0);
    expect(alert).toHaveBeenCalledWith(
      tr("common.failed"),
      tr("error.network"),
    );
    expect(number(r)).toBe("45");
  });
});

describe("已通知页的标题", () => {
  const notified = async (notifications: unknown[] | undefined) => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "notified" })),
    );
    m(sosApi.accidentDetail).mockImplementation(() =>
      notifications === undefined
        ? new Promise(() => undefined)
        : Promise.resolve({ notifications } as unknown as AccidentDetail),
    );
    const r = await mount();
    await tick(0);
    await tick(0);
    return r;
  };

  it("记录还没拿到不下结论；没有短信 = 没有联系人；全没发出去；还在发", async () => {
    let r = await notified(undefined);
    expect(r.allText()).toContain(tr("sos.notified.sending"));
    expect(r.allText()).toContain(tr("sos.notifiedBody"));
    r.unmount();
    r = await notified([]);
    expect(r.allText()).toContain(tr("sos.notified.none"));
    r.unmount();
    r = await notified([
      {
        id: "n1",
        channel: "sms",
        target: "1",
        contactName: null,
        status: "failed",
      },
    ]);
    expect(r.allText()).toContain(tr("sos.notified.failed"));
    expect(r.allText()).toContain(tr("accident.notif.failed"));
    r.unmount();
    r = await notified([
      {
        id: "n1",
        channel: "sms",
        target: "139****0002",
        contactName: null,
        status: "pending",
      },
    ]);
    expect(r.allText()).toContain(tr("sos.notified.sending"));
    expect(r.allText()).toContain(tr("accident.notif.sending"));
    r.unmount();
    r = await notified([
      {
        id: "n1",
        channel: "sms",
        target: "138****0001",
        contactName: "妈妈",
        status: "sent",
      },
    ]);
    expect(r.allText()).toContain(tr("sos.notified.sent"));
    expect(r.texts()).toContain("妈");
  });
});

describe("这一单的状态拿不到 / 不存在", () => {
  it("服务端说没有这一单（404）：不画倒计时，说明并关闭（栈里没东西回设备页）", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.reject(new ApiRequestError(404, { code: "NOT_FOUND" })),
    );
    const r = await mount();
    expect(r.allText()).toContain(tr("sos.gone.title"));
    expect(sosApi.snapshot).toHaveBeenCalledTimes(1);
    mockRouter.canGoBack.mockReturnValueOnce(false);
    r.press(tr("sos.close"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/");
  });

  it("离线（两条 REST 都失败）：才信缓存；缓存也没有时数字写一横、环是空的", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    let r = await mount();
    expect(number(r)).toBe("—");
    r.unmount();
    qc = makeQueryClient();
    qc.setQueryData(
      ["sos", "s1"],
      sosOf({ deadline: new Date(Date.now() + 30_000).toISOString() }),
    );
    r = await mount(false);
    await tick(0);
    expect(number(r)).toBe("30");
  });
});

describe("已取消后「我还是需要帮助」", () => {
  const cancelled = async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "cancelled" })),
    );
    return mount();
  };

  it("经 app-relay 注入 manual_sos；成功立刻核对进行中求救", async () => {
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    const r = await cancelled();
    r.press(tr("sos.needHelp"));
    await tick(0);
    const body = m(relayApi.push).mock.calls[0][0] as {
      deviceId: string;
      envelopes: { eventType: string }[];
    };
    expect(body.deviceId).toBe("h1");
    expect(body.envelopes[0].eventType).toBe("manual_sos");
    expect(notifyCriticalAccepted).toHaveBeenCalledWith("h1");
  });

  it("服务端判 invalid（只留档不建单）：明说没被接受，不进队列", async () => {
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 0, duplicate: 0, invalid: 1 }),
    );
    const r = await cancelled();
    r.press(tr("sos.needHelp"));
    await tick(0);
    expect(alert).toHaveBeenCalledWith(
      tr("safety.sosSendFailed"),
      tr("safety.sosRejected"),
    );
    expect(enqueueRelayEvent).not.toHaveBeenCalled();
    expect(notifyCriticalAccepted).not.toHaveBeenCalled();
  });

  it("没发出去：进持久队列（只入一次）；再点重试复用同一个 eventId", async () => {
    m(relayApi.push).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = await cancelled();
    r.press(tr("sos.needHelp"));
    await tick(0);
    r.press(tr("sos.needHelp"));
    await tick(0);
    expect(enqueueRelayEvent).toHaveBeenCalledTimes(1);
    const ids = m(relayApi.push).mock.calls.map(
      (c) =>
        (c[0] as { envelopes: { eventId: string }[] }).envelopes[0].eventId,
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(alert).toHaveBeenLastCalledWith(
      tr("safety.sosSendFailed"),
      `${tr("error.network")}\n${tr("safety.sosQueued")}`,
    );
  });

  it("新一单的倒计时页盖上来又关掉之后，这张已取消页跟着关掉", async () => {
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    const r = await cancelled();
    r.press(tr("sos.needHelp"));
    await tick(0);
    const el = () => (
      <QueryClientProvider client={qc}>
        <SosActiveScreen />
      </QueryClientProvider>
    );
    routerState.focused = false;
    r.rerender(el());
    routerState.focused = true;
    r.rerender(el());
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe("演练（drill=1）", () => {
  beforeEach(() => {
    routerState.params = { drill: "1", deviceId: "h1" };
  });

  it("不碰服务端；顶部常驻演练标记；同样倒数 60 秒、同样警报", async () => {
    const r = await mount();
    expect(sosApi.snapshot).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("sos.drillBadge"));
    expect(number(r)).toBe("60");
    await tick(1000);
    expect(mockAlarm.seekTo).toHaveBeenCalled();
    expect(presentedSos.current.size).toBe(0);
  });

  it("取消 / 立即求救只改本地状态；倒数走完在本地变成「已通知」的演练结束页；不撤锁屏提醒", async () => {
    let r = await mount();
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    expect(sosApi.cancel).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("sos.drillDoneTitle"));
    expect(r.allText()).not.toContain(tr("sos.needHelp"));
    r.unmount();
    r = await mount();
    r.press(tr("sos.sendNow"));
    expect(sosApi.confirm).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("sos.drillNotifiedBody"));
    r.unmount();
    r = await mount();
    await tick(61_000);
    expect(r.allText()).toContain(tr("sos.drillDoneTitle"));
    expect(clearSosAlert).not.toHaveBeenCalled();
  });
});
