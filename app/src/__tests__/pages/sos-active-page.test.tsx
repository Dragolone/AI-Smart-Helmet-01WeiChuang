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
  isHost,
  flat,
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
import { devLog } from "@/services/dev-log";
import { clearSosAlert } from "@/services/sos-alert";
import { sosScreen } from "@/services/sos-queue";
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

/** 只有一个按钮的提示统一走 services/notice 的 showNotice：第三个参数是一个「确定」 */
const NOTICE_OK = [{ text: translate("common.confirm", undefined, "zh-CN") }];
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

  it("刚拉起时剩余比 60 秒多一点（服务端 Date 头只到秒、时钟偏移偏小）：数字写 60，不写 61（10-16 iPhone）", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(
        sosOf({ deadline: new Date(Date.now() + 60_800).toISOString() }),
      ),
    );
    const r = await mount();
    expect(number(r)).toBe("60");
    await tick(1050);
    expect(number(r)).toBe("60");
    await tick(1000);
    expect(number(r)).toBe("59");
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

  it("音频会话设置失败：只记日志，警报照样响", async () => {
    const err = new Error("audio session busy");
    m(setAudioModeAsync).mockImplementationOnce(() => Promise.reject(err));
    await mount();
    expect(devLog).toHaveBeenCalledWith("SOS", "音频模式设置失败", err);
    expect(mockAlarm.play).toHaveBeenCalled();
  });

  it("上半截放不下（英文多折行、没联系人的警告…）：量出溢出多少就把环缩多少，最小 140；缩到底还放不下才收起顶上的警示图标", async () => {
    const r = await mount();
    const scroll = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        typeof n.props.onContentSizeChange === "function",
    );
    const fontSize = () =>
      flat(
        r.root.find(
          (n) => isHost(n, "Text") && /^\d+$/.test(String(n.children.join(""))),
        ).props.style,
      ).fontSize as number;
    const icon = () => r.icons().includes("warning-outline");
    const measure = (viewport: number, content: number) => {
      act(() => {
        scroll.props.onLayout({
          nativeEvent: { layout: { height: viewport } },
        });
        scroll.props.onContentSizeChange(0, content);
      });
    };
    // 高屏：环是满的 252，数字 112
    expect(fontSize()).toBe(112);
    expect(icon()).toBe(true);
    // 放得下（多出不到 1）：不动
    measure(500, 501);
    expect(fontSize()).toBe(112);
    // 溢出 50：环缩 50 → 202
    measure(500, 550);
    expect(fontSize()).toBe(Math.round((112 * 202) / 252));
    // 再溢出 100：最多缩到 140
    measure(500, 600);
    expect(fontSize()).toBe(Math.round((112 * 140) / 252));
    expect(icon()).toBe(true);
    // 环已经最小：收起顶上的图标
    measure(500, 560);
    expect(icon()).toBe(false);
    expect(fontSize()).toBe(Math.round((112 * 140) / 252));
  });

  it("联系人胶囊可换到第二排、名字最多约 6 个字再省略（10-16 N20：原来三个挤一行只剩 3 个字）", async () => {
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve([
        { id: "c1", name: "张三丰师傅的头盔" },
        { id: "c2", name: "李四" },
        { id: "c3", name: "王五" },
      ]),
    );
    const r = await mount();
    const name = r.root.find(
      (n) => isHost(n, "Text") && n.props.children === "张三丰师傅的头盔",
    );
    expect(flat(name.props.style).maxWidth).toBe(94);
    expect(name.props.numberOfLines).toBe(1);
    const rows = r.root.findAll(
      (n) => isHost(n, "View") && flat(n.props.style).flexWrap === "wrap",
    );
    expect(rows).toHaveLength(1);
    expect(
      rows[0].findAll((n) => isHost(n, "Text")).length,
    ).toBeGreaterThanOrEqual(3);
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
      NOTICE_OK,
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
    // 假计时器下，依赖查询（enabled 由另一份缓存翻过来）拿到结果后要等下一次计时器推进才重画
    //（和「立即求救」那条一样；10-16 N10 之后页面多了登记队列的渲染，两拍 0 ms 不够了，推进到下一次每秒刷新）
    await tick(1100);
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
      NOTICE_OK,
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
      NOTICE_OK,
    );
  });

  it("之后的新单到了（中转成功后核对写进缓存）：这张页自己切回倒计时，不另开一页；同一顶头盔的旧单被顶掉，结束后仍是单条结果页（10-16 N10）", async () => {
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    const r = await cancelled();
    r.press(tr("sos.needHelp"));
    await tick(0);
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ sosId: "s3" })),
    );
    act(() => {
      qc.setQueryData(["sos-active", "h1"], { sos: sosOf({ sosId: "s3" }) });
    });
    await tick(0);
    await tick(0);
    expect(number(r)).toBe("45");
    expect(presentedSos.current.has("s3")).toBe(true);
    expect(mockRouter.back).not.toHaveBeenCalled();
    // 同一顶头盔的新单：不提示「已取消，已切到下一单」（10-16 iPhone 发现）
    expect(r.allText()).not.toContain(
      tr("sos.switchedCancelled", { name: "通勤" }),
    );
    m(sosApi.cancel).mockImplementation(() =>
      Promise.resolve(sosOf({ sosId: "s3", status: "cancelled" })),
    );
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    await tick(0);
    expect(r.allText()).toContain(tr("sos.cancelledTitle"));
    expect(r.allText()).not.toContain(tr("sos.multiDoneTitle", { n: 2 }));
  });
});

describe("多顶头盔同时求救（10-16 N10：一张页 + 顶部胶囊点切）", () => {
  const second = (sosId = "s2", deviceId = "h2", seconds = 50) =>
    sosOf({
      sosId,
      deviceId,
      deadline: new Date(Date.now() + seconds * 1000).toISOString(),
    });
  const twoHelmets = () => {
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([
        { deviceId: "h1", name: "通勤" },
        { deviceId: "h2", name: "滑雪" },
        { deviceId: "h3", name: "山地" },
      ]),
    );
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(
        id === "s2" ? second() : id === "s3" ? second("s3", "h3", 55) : sosOf(),
      ),
    );
  };
  const arrive = (s: Sos) =>
    act(() => {
      qc.setQueryData(["sos-active", s.deviceId], { sos: s });
    });
  const slideCancel = (r: Rendered) =>
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );

  it("在屏上时登记 sosScreen.mounted（新单不再叠页）；第二单从缓存进队列：顶部两个胶囊、提示一句、写「滑雪 也在倒计时」；点胶囊切过去", async () => {
    twoHelmets();
    const r = await mount();
    expect(sosScreen.mounted).toBe(true);
    arrive(second());
    await tick(0);
    expect(r.allText()).toContain(tr("sos.newAlarm", { name: "滑雪" }));
    expect(r.allText()).toContain(tr("sos.alsoCounting", { name: "滑雪" }));
    expect(r.allText()).toContain(tr("sos.allCancel"));
    expect(r.allText()).toContain(tr("sos.allSendNow"));
    expect(number(r)).toBe("45");
    expect(
      r.byLabel(`滑雪 · ${tr("sos.chipLeft", { n: 50 })}`).props
        .accessibilityState,
    ).toEqual({ selected: false });
    r.press(tr("sos.chipLeft", { n: 50 }));
    for (let i = 0; i < 3; i++) await tick(0);
    expect(number(r)).toBe("50");
    expect(presentedSos.current.has("s2")).toBe(true);
    // 提示 4 秒后自己消失
    await tick(4_100);
    expect(r.allText()).not.toContain(tr("sos.newAlarm", { name: "滑雪" }));
    r.unmount();
    expect(sosScreen.mounted).toBe(false);
  });

  it("当前单取消后提示并自动切到下一单（页面仍在倒数）；两单都结束才进结果页，按头盔逐条列结论、已取消的各有「我还是需要帮助」", async () => {
    twoHelmets();
    m(sosApi.cancel).mockImplementation((id: unknown) =>
      Promise.resolve(
        sosOf({
          sosId: id as string,
          deviceId: id === "s2" ? "h2" : "h1",
          status: "cancelled",
        }),
      ),
    );
    const r = await mount();
    arrive(second());
    await tick(0);
    slideCancel(r);
    for (let i = 0; i < 3; i++) await tick(0);
    expect(sosApi.cancel).toHaveBeenCalledWith("s1");
    expect(r.allText()).toContain(
      tr("sos.switchedCancelled", { name: "通勤" }),
    );
    expect(number(r)).toBe("50");
    expect(r.allText()).not.toContain(tr("sos.multiDoneTitle", { n: 2 }));
    expect(clearSosAlert).toHaveBeenCalledWith("s1");
    slideCancel(r);
    for (let i = 0; i < 3; i++) await tick(0);
    expect(sosApi.cancel).toHaveBeenCalledWith("s2");
    expect(r.allText()).toContain(tr("sos.multiDoneTitle", { n: 2 }));
    expect(r.allText()).toContain("通勤");
    expect(r.allText()).toContain("滑雪");
    expect(r.texts().filter((x) => x === tr("sos.needHelp"))).toHaveLength(2);
    r.press(tr("sos.close"));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it("三顶以上写「还有 2 顶头盔正在报警」；「全部取消」先确认，确认后每单都调取消接口；结果页列 3 条", async () => {
    twoHelmets();
    m(sosApi.cancel).mockImplementation((id: unknown) =>
      Promise.resolve(
        sosOf({
          sosId: id as string,
          deviceId: id === "s2" ? "h2" : id === "s3" ? "h3" : "h1",
          status: "cancelled",
        }),
      ),
    );
    const r = await mount();
    arrive(second());
    arrive(second("s3", "h3", 55));
    await tick(0);
    expect(r.allText()).toContain(tr("sos.moreAlarms", { n: 2 }));
    r.press(tr("sos.allCancel"));
    expect(alert).toHaveBeenCalledTimes(1);
    const buttons = alert.mock.calls[0][2] as {
      text: string;
      onPress?: () => void;
    }[];
    expect(buttons[0].text).toBe(tr("common.cancel"));
    expect(sosApi.cancel).not.toHaveBeenCalled();
    act(() => buttons[1].onPress?.());
    for (let i = 0; i < 4; i++) await tick(0);
    expect(
      m(sosApi.cancel)
        .mock.calls.map((c) => c[0])
        .sort(),
    ).toEqual(["s1", "s2", "s3"]);
    expect(r.allText()).toContain(tr("sos.multiDoneTitle", { n: 3 }));
    expect(r.allText()).toContain("山地");
  });

  it("「全部立即求救」：确认后每单都调确认接口；一单失败弹窗说明，其余照常", async () => {
    twoHelmets();
    m(sosApi.confirm).mockImplementation((id: unknown) =>
      id === "s2"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(sosOf({ sosId: id as string, status: "notified" })),
    );
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve({ notifications: [] } as unknown as AccidentDetail),
    );
    const r = await mount();
    arrive(second());
    await tick(0);
    r.press(tr("sos.allSendNow"));
    const buttons = alert.mock.calls[0][2] as {
      text: string;
      onPress?: () => void;
    }[];
    act(() => buttons[1].onPress?.());
    for (let i = 0; i < 4; i++) await tick(0);
    expect(
      m(sosApi.confirm)
        .mock.calls.map((c) => c[0])
        .sort(),
    ).toEqual(["s1", "s2"]);
    expect(alert).toHaveBeenLastCalledWith(
      tr("common.failed"),
      expect.any(String),
      NOTICE_OK,
    );
    // s2 没成功还在倒数：页面切到它
    await tick(1100);
    expect(number(r)).toBe("49");
  });

  it("屏上这单本机还是倒计时、同一顶头盔却来了新单（旧单终态没收到）：不崩，立刻拉旧单的权威状态，结束了就切到新单、不提示「已切到下一单」（10-16 评审）", async () => {
    const s9 = second("s9", "h1", 55);
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(id === "s9" ? s9 : sosOf()),
    );
    const r = await mount();
    expect(number(r)).toBe("45");
    const before = m(sosApi.snapshot).mock.calls.length;
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(id === "s9" ? s9 : sosOf({ status: "notified" })),
    );
    arrive(s9);
    for (let i = 0; i < 4; i++) await tick(0);
    expect(r.tree.toJSON()).not.toBeNull();
    expect(
      m(sosApi.snapshot)
        .mock.calls.slice(before)
        .some((c) => c[0] === "s1"),
    ).toBe(true);
    expect(number(r)).toBe("55");
    expect(r.allText()).not.toContain(
      tr("sos.switchedNotified", { name: "通勤" }),
    );
    expect(r.allText()).not.toContain(tr("sos.newAlarm", { name: "通勤" }));
  });

  it("点了旧单留在锁屏上的通知进来、本机缓存里旧单还是倒计时而同一顶已有新单：挂载不崩，落到新单", async () => {
    const s9 = second("s9", "h1", 55);
    qc = makeQueryClient();
    qc.setQueryData(["sos", "s1"], sosOf());
    qc.setQueryData(["sos-active", "h1"], { sos: s9 });
    qc.setQueryData(["sos", "s9"], s9);
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(id === "s9" ? s9 : sosOf({ status: "notified" })),
    );
    const r = await mount(false);
    for (let i = 0; i < 3; i++) await tick(0);
    expect(r.tree.toJSON()).not.toBeNull();
    expect(number(r)).toBe("55");
  });

  it("页面被切到一个不存在的单号（已解绑头盔的推送 / 外部链接，404），而另一单还在倒数：切到那单，不用「这条求救不存在」盖住它", async () => {
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      id === "sX"
        ? Promise.reject(
            new ApiRequestError(404, { code: "NOT_FOUND", message: "x" }),
          )
        : Promise.resolve(sosOf()),
    );
    const r = await mount();
    qc.setQueryData(["sos-active", "h1"], { sos: sosOf() });
    routerState.params = { sosId: "sX", deviceId: "h2" };
    r.rerender(
      <QueryClientProvider client={qc}>
        <SosActiveScreen />
      </QueryClientProvider>,
    );
    for (let i = 0; i < 4; i++) await tick(0);
    expect(r.allText()).not.toContain(tr("sos.gone.title"));
    await tick(1100);
    expect(number(r)).toBe("44");
    const plays = mockAlarm.play.mock.calls.length;
    await tick(3000);
    expect(mockAlarm.play.mock.calls.length).toBeGreaterThan(plays);
  });

  it("「全部取消」时屏上这单已在别处结束（409 SOS_ALREADY_FINALIZED）：不弹错，立刻拉它的权威状态切走，不等下一轮 10 秒轮询", async () => {
    twoHelmets();
    m(sosApi.cancel).mockImplementation((id: unknown) =>
      id === "s1"
        ? Promise.reject(
            new ApiRequestError(409, {
              code: "SOS_ALREADY_FINALIZED",
              message: "x",
            }),
          )
        : Promise.resolve({ ...second(), status: "cancelled" }),
    );
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve({ notifications: [] } as unknown as AccidentDetail),
    );
    const r = await mount();
    arrive(second());
    await tick(0);
    const before = m(sosApi.snapshot).mock.calls.length;
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(
        id === "s1"
          ? sosOf({ status: "notified" })
          : { ...second(), status: "cancelled" },
      ),
    );
    r.press(tr("sos.allCancel"));
    const buttons = alert.mock.calls.at(-1)?.[2] as { onPress?: () => void }[];
    act(() => buttons[1].onPress?.());
    for (let i = 0; i < 6; i++) await tick(0);
    expect(
      m(sosApi.snapshot)
        .mock.calls.slice(before)
        .some((c) => c[0] === "s1"),
    ).toBe(true);
    expect(alert.mock.calls.length).toBe(1);
    expect(r.allText()).toContain(tr("sos.multiDoneTitle", { n: 2 }));
  });

  it("点了另一单的通知：_layout 把这张页的参数改成那一单，页面切过去", async () => {
    twoHelmets();
    const r = await mount();
    arrive(second());
    await tick(0);
    routerState.params = { sosId: "s2", deviceId: "h2" };
    r.rerender(
      <QueryClientProvider client={qc}>
        <SosActiveScreen />
      </QueryClientProvider>,
    );
    for (let i = 0; i < 3; i++) await tick(0);
    expect(number(r)).toBe("50");
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
