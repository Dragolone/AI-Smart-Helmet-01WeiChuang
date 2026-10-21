// 求救倒计时页（保命链路，只测不改；发现写进 COVERAGE_FINDINGS_1016.md）：
// 服务端权威——数字只按服务端给的 deadline 渲染；取消 / 立即求救调接口，结果以服务端为准；
// 已在别处结束（SOS_ALREADY_FINALIZED）不弹错而是拉权威状态；404 收掉；离线时才信缓存；
// 倒数中拦住 Android 返回键、每秒警报 + 震动（最后 10 秒连震两下）、锁屏通知按钮的取消在路上时不响；
// 结束后撤掉锁屏提醒；已通知页按短信结果写标题；「我还是需要帮助」同一个 eventId 重试；演练不碰服务端。
// 倒数中取消 / 立即求救没成功：按钮区上方的页内提示条（还剩约几秒 + 重试），不弹框盖住倒计时（O7，10-20）。
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
import {
  AccessibilityInfo,
  Alert,
  BackHandler,
  StyleSheet,
  View,
} from "react-native";
import { act } from "react-test-renderer";
import {
  mockInsets,
  mockRouter,
  routerState,
} from "@/__tests__/helpers/native-mocks";
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
import { toUserMessage } from "@/api/error-messages";
import { relayApi } from "@/api/relay";
import { sosApi } from "@/api/sos";
import { Badge } from "@/components/badge";
import { CountdownRing } from "@/components/countdown-ring";
import { SlideToCancel } from "@/components/slide-to-cancel";
import { Tappable } from "@/components/tappable";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import {
  enqueueRelayEvent,
  notifyCriticalAccepted,
} from "@/services/ble-relay-uplink";
import { devLog } from "@/services/dev-log";
import { clearSosAlert } from "@/services/sos-alert";
import { sosScreen } from "@/services/sos-queue";
import {
  __resetServerClockForTests,
  noteServerDate,
  serverClockOffsetMs,
} from "@/services/server-clock";
import { presentedSos } from "@/services/sos-sync";
import { countdownHoldUntil } from "@/services/countdown-hold";
import { useAuthStore } from "@/stores/auth-store";
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
let announce: ReturnType<typeof jest.spyOn>;

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
/** 大数字的字号（跟着环的尺寸走：252 的环是 112） */
const numberFontSize = (r: Rendered) =>
  flat(
    r.root.find(
      (n) => isHost(n, "Text") && /^\d+$/.test(String(n.children.join(""))),
    ).props.style,
  ).fontSize as number;
/** 环此刻摆到的进度（0–1） */
const ringProgress = (r: Rendered) =>
  (
    r.root.findByType(CountdownRing).props.progress as {
      get: () => number;
    }
  ).get();
const secondsFromNow = (s: number) =>
  new Date(Date.now() + s * 1000).toISOString();
const slideButton = (r: Rendered) =>
  r.root.find(
    (n) =>
      typeof n.type === "string" &&
      n.props.accessibilityLabel === tr("sos.slideA11y"),
  );
/** 取消 / 立即求救没成功的页内提示条（O7）：从它的标题往上找到带边框的那一层 */
const failBar = (r: Rendered) => {
  const titles = [tr("sos.failCancel"), tr("sos.failSend")];
  let cur: ReturnType<Rendered["root"]["find"]> | null = r.root.find(
    (n) => isHost(n, "Text") && titles.includes(n.children.join("")),
  );
  while (cur && !(isHost(cur, "View") && flat(cur.props.style).borderWidth))
    cur = cur.parent;
  if (!cur) throw new Error("没有提示条");
  return cur;
};
/** 读屏念的那一句：标题 + 分隔 + 倒计时那一行 */
const said = (title: MessageKey, body: string) =>
  `${tr(title)}${tr("common.a11ySep")}${body}`;
/** 请求在 ms 毫秒后失败（超时 / 断网），按假计时器走 */
const failAfter = (ms: number) => () =>
  new Promise((_resolve, reject) => {
    setTimeout(
      () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
      ms,
    );
  });

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
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => undefined);
});
afterEach(() => {
  backSpy.mockRestore();
  alert.mockRestore();
  sr.mockRestore();
  srSub.mockRestore();
  announce.mockRestore();
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

  it("警报：音频设成锁屏 / 静音键下也响，每秒重播 + 震一下；最后 10 秒每秒连震两下", async () => {
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
    // 每秒单下的 Heavy：Warning 本身是两下短震，平时就用它的话最后 10 秒成了四下（10-17 华为震动记录）
    const pulses = () =>
      m(Haptics.impactAsync).mock.calls.filter((c) => c[0] === "heavy").length;
    await tick(1000);
    expect(mockAlarm.seekTo).toHaveBeenCalledWith(0);
    expect(pulses()).toBe(1);
    await tick(1000);
    await tick(1000);
    // 剩 9 秒起：每秒两下
    const before = pulses();
    await tick(1000);
    expect(pulses() - before).toBe(2);
    expect(
      m(Haptics.notificationAsync).mock.calls.filter((c) => c[0] === "warning"),
    ).toHaveLength(0);
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
    // 图标也收了还放不下（字体放得很大）：不再改，靠上半截自己滚动兜底
    measure(500, 620);
    expect(icon()).toBe(false);
    expect(fontSize()).toBe(Math.round((112 * 140) / 252));
  });

  it("矮屏（360×677，1 倍字体）：按估算就放不下 → 一开始就收起顶上的警示图标，省下的高度还给环（216，不是 150）", async () => {
    // react-native 的导出是 getter：在原模块对象上换 getter 本身（同 edge-large-font-1016）
    const raw = require("react-native") as { useWindowDimensions: object };
    const dims = jest
      .spyOn(raw, "useWindowDimensions", "get")
      .mockReturnValue(() => ({
        width: 360,
        height: 677,
        scale: 2,
        fontScale: 1,
      }));
    try {
      const r = await mount();
      expect(r.icons()).not.toContain("warning-outline");
      expect(numberFontSize(r)).toBe(Math.round((112 * 216) / 252));
    } finally {
      dims.mockRestore();
    }
  });

  it("分屏半屏（360×440）：最小的环也塞不下 → 不画环、说明收起，只留大号秒数（O20，负责人 10-21 定）；按钮照常", async () => {
    const raw = require("react-native") as { useWindowDimensions: object };
    const dims = jest
      .spyOn(raw, "useWindowDimensions", "get")
      .mockReturnValue(() => ({
        width: 360,
        height: 440,
        scale: 2,
        fontScale: 1,
      }));
    try {
      const r = await mount();
      expect(r.root.findAllByType(CountdownRing)).toHaveLength(0);
      expect(number(r)).toBe("45");
      expect(r.allText()).toContain(tr("sos.autoSendSuffix"));
      // 标题下那句说明收起，高度让给数字（1080×900 模拟器：只去掉环时数字底边仍被按钮裁掉）
      expect(r.allText()).not.toContain(tr("sos.pendingBody"));
      expect(r.allText()).toContain(tr("sos.fall"));
      const size = numberFontSize(r);
      expect(size).toBeGreaterThanOrEqual(44);
      expect(size).toBeLessThanOrEqual(96);
      expect(r.icons()).not.toContain("warning-outline");
      expect(r.root.findAllByType(SlideToCancel)).toHaveLength(1);
      expect(r.allText()).toContain(tr("sos.sendNow"));
      await tick(1050);
      expect(number(r)).toBe("44");
    } finally {
      dims.mockRestore();
    }
  });

  it("浅色外观：大号数字用更深的红（#B93229）压住浅灰底；环的底轨、联系人头像底、滑块描边都换成浅色那套", async () => {
    useThemeStore.setState({ mode: "light" });
    const r = await mount();
    const num = r.root.find(
      (n) => isHost(n, "Text") && n.children.join("") === "45",
    );
    expect(flat(num.props.style).color).toBe("#B93229");
    expect(r.root.findByType(CountdownRing).props.track).toBe("#E3E6EA");
    expect(
      r.root.findAll(
        (n) =>
          isHost(n, "View") &&
          flat(n.props.style).backgroundColor === "rgba(17,24,39,0.10)",
      ),
    ).not.toHaveLength(0);
    expect(r.root.findByType(SlideToCancel).props.colors.trackBorder).toBe(
      Colors.light.borderStrong,
    );
  });

  it("开着读屏（同系统「减弱动态效果」）：环每秒直接摆到当前秒数，不做补间——一直在变的动画让读屏等不到界面静止", async () => {
    sr.mockImplementation(() => Promise.resolve(true));
    let r = await mount();
    expect(number(r)).toBe("45");
    expect(ringProgress(r)).toBeCloseTo(45 / 60);
    await tick(1050);
    expect(number(r)).toBe("44");
    expect(ringProgress(r)).toBeCloseTo(44 / 60);
    r.unmount();
    // 对照：不开读屏时每秒朝下一格补间（替身里补间直接给终值）
    sr.mockImplementation(() => Promise.resolve(false));
    r = await mount();
    expect(number(r)).toBe("45");
    expect(ringProgress(r)).toBeCloseTo(44 / 60);
  });

  it("读屏状态还没查到就离开了页面：读屏监听撤掉，迟到的结果直接丢掉", async () => {
    let resolve!: (on: boolean) => void;
    sr.mockImplementation(() => new Promise<boolean>((res) => (resolve = res)));
    const r = await mount();
    const at = srSub.mock.calls.findIndex(
      (c: unknown[]) => c[0] === "screenReaderChanged",
    );
    const sub = srSub.mock.results[at]?.value as { remove: jest.Mock };
    r.unmount();
    expect(sub.remove).toHaveBeenCalled();
    await act(async () => {
      resolve(true);
      await Promise.resolve();
    });
    expect(r.tree.toJSON()).toBeNull();
  });

  it("震动 / 警报重播接口失败（没有震动马达、播放器被回收）：吞掉，倒计时、警报和「立即求救」照常", async () => {
    m(Haptics.impactAsync).mockImplementation(() =>
      Promise.reject(new Error("vibrator unavailable")),
    );
    mockAlarm.seekTo.mockImplementation(() =>
      Promise.reject(new Error("player released")),
    );
    m(sosApi.confirm).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "notified" })),
    );
    m(sosApi.accidentDetail).mockImplementation(
      () => new Promise(() => undefined),
    );
    try {
      const r = await mount();
      await tick(2050);
      expect(number(r)).toBe("43");
      expect(mockAlarm.play).toHaveBeenCalled();
      r.press(tr("sos.sendNow"));
      await tick(0);
      expect(sosApi.confirm).toHaveBeenCalledWith("s1");
    } finally {
      m(Haptics.impactAsync).mockImplementation(() => Promise.resolve());
      mockAlarm.seekTo.mockImplementation(() => Promise.resolve());
    }
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

  it("倒数期间别处改了紧急联系人：每 10 秒跟着刷新，页面写的名单跟上（到点按终态化那一刻的名单发，O24）", async () => {
    const r = await mount();
    expect(r.allText()).toContain(tr("sos.willNotify", { n: 1 }));
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve([
        { id: "c2", name: "爸爸" },
        { id: "c3", name: "朋友" },
      ]),
    );
    await tick(10_100);
    await tick(0);
    expect(r.allText()).toContain(tr("sos.willNotify", { n: 2 }));
    expect(r.allText()).toContain("爸爸");
    expect(r.allText()).not.toContain("妈妈");
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

  it("倒数期间登记 sosScreen.counting（外来链接不把这页挤掉，app/+native-intent）；到了已取消页撤掉，卸载也撤掉（10-21 夜测）", async () => {
    m(sosApi.cancel).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "cancelled" })),
    );
    const r = await mount();
    expect(sosScreen.counting).toBe(true);
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    await tick(0);
    expect(r.allText()).toContain(tr("sos.cancelledTitle"));
    expect(sosScreen.counting).toBe(false);
    expect(sosScreen.mounted).toBe(true);
    r.unmount();
    expect(sosScreen.counting).toBe(false);
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

  // 原来这两种失败弹系统提示框：盖住还在走的倒计时、不写剩余秒数，要先点「确定」才能再滑（O7，10-20 模拟器）
  it("滑动取消没成功（8 s 超时）：不弹框；按钮区上方写「取消没有成功」和约几秒后通知（按失败这一刻算、跟着倒计时走），倒计时和警报照常、滑块复位可再滑；读屏念一遍；点重试再发一次取消，成功 → 已取消页、提示条收起", async () => {
    // 跨过 10 s 轮询：快照每次给同一个 deadline（默认的 sosOf() 每次按当下现算）
    const s1 = sosOf();
    m(sosApi.snapshot).mockImplementation(() => Promise.resolve(s1));
    let calls = 0;
    m(sosApi.cancel).mockImplementation(() =>
      ++calls === 1
        ? failAfter(8_000)()
        : Promise.resolve({ ...s1, status: "cancelled" }),
    );
    const r = await mount();
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    // 在路上：滑块写「取消中…」，还没有提示条
    await tick(1_000);
    expect(r.allText()).toContain(tr("sos.cancelling"));
    expect(r.allText()).not.toContain(tr("sos.failCancel"));
    await tick(7_050);
    expect(alert).not.toHaveBeenCalled();
    expect(number(r)).toBe("37");
    expect(r.allText()).toContain(tr("sos.failCancel"));
    expect(r.allText()).toContain(tr("sos.failStillCounting", { n: 37 }));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      said("sos.failCancel", tr("sos.failStillCounting", { n: 37 })),
    );
    // 提示条在环和两个按钮之间、不是浮层：不盖住数字和按钮
    expect(flat(failBar(r).props.style).position).toBeUndefined();
    const order = r.texts();
    expect(order.indexOf("妈妈")).toBeLessThan(
      order.indexOf(tr("sos.failCancel")),
    );
    expect(order.indexOf(tr("sos.failCancel"))).toBeLessThan(
      order.indexOf(tr("sos.sendNow")),
    );
    // 倒计时、警报、返回键拦截照常；滑块已复位
    expect(slideButton(r).props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
    const seeks = mockAlarm.seekTo.mock.calls.length;
    await tick(3_000);
    expect(number(r)).toBe("34");
    expect(r.allText()).toContain(tr("sos.failStillCounting", { n: 34 }));
    expect(mockAlarm.seekTo.mock.calls.length).toBeGreaterThan(seeks);
    expect(back!()).toBe(true);
    // 重试 = 再发一次取消
    r.press(tr("sos.retry"));
    await tick(0);
    expect(m(sosApi.cancel).mock.calls.map((c) => c[0])).toEqual(["s1", "s1"]);
    expect(r.allText()).toContain(tr("sos.cancelledTitle"));
    expect(r.allText()).not.toContain(tr("sos.failCancel"));
    expect(alert).not.toHaveBeenCalled();
  });

  it("立即求救没成功：提示条写「立即求救没有发出」；重试再发确认、又没成功就再念一遍；之后服务端推来已通知（到期）→ 提示条收起", async () => {
    m(sosApi.confirm).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve({ notifications: [] } as unknown as AccidentDetail),
    );
    const r = await mount();
    r.press(tr("sos.sendNow"));
    await tick(0);
    expect(alert).not.toHaveBeenCalled();
    expect(number(r)).toBe("45");
    expect(r.allText()).toContain(tr("sos.failSend"));
    expect(r.allText()).toContain(tr("sos.failStillCounting", { n: 45 }));
    expect(r.byLabel(tr("sos.retrySendA11y"))).toBeTruthy();
    expect(announce).toHaveBeenLastCalledWith(
      said("sos.failSend", tr("sos.failStillCounting", { n: 45 })),
    );
    await tick(2_050);
    r.press(tr("sos.retry"));
    await tick(0);
    expect(m(sosApi.confirm).mock.calls.map((c) => c[0])).toEqual(["s1", "s1"]);
    expect(r.allText()).toContain(tr("sos.failSend"));
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(
      said("sos.failSend", tr("sos.failStillCounting", { n: 43 })),
    );
    act(() => {
      qc.setQueryData(["sos", "s1"], sosOf({ status: "notified" }));
    });
    await tick(0);
    // 发送记录里没有短信 = 没有联系人，标题写未发送（见「已通知页的标题」）
    expect(r.allText()).toContain(tr("sos.notified.none"));
    expect(r.allText()).not.toContain(tr("sos.failSend"));
    expect(alert).not.toHaveBeenCalled();
  });

  it("提示条挂着时倒计时走到 0（服务端还没推终态）：不写「约 0 秒」，写马上就会通知", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ deadline: secondsFromNow(3) })),
    );
    m(sosApi.cancel).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = await mount();
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    await tick(0);
    expect(r.allText()).toContain(tr("sos.failStillCounting", { n: 3 }));
    await tick(3_050);
    expect(number(r)).toBe("0");
    expect(r.allText()).toContain(tr("sos.failDueNow"));
    expect(r.allText()).not.toContain(tr("sos.failStillCounting", { n: 0 }));
  });

  it("状态还没拿到（离线，数字是一横）时取消没成功：提示条照样出，只说倒计时结束会通知、不编秒数", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    m(sosApi.cancel).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = await mount();
    expect(number(r)).toBe("—");
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    await tick(0);
    expect(alert).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("sos.failCancel"));
    // 上面的说明一行 + 提示条里一行
    expect(r.texts().filter((x) => x === tr("sos.pendingBody"))).toHaveLength(
      2,
    );
    expect(announce).toHaveBeenCalledWith(
      said("sos.failCancel", tr("sos.pendingBody")),
    );
  });

  it("「立即求救」请求超时但服务端已通知（短信慢、响应晚于超时）：不弹「出错了」，页面停在已通知", async () => {
    m(sosApi.confirm).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve({ notifications: [] } as unknown as AccidentDetail),
    );
    const r = await mount();
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "notified" })),
    );
    r.press(tr("sos.sendNow"));
    await tick(0);
    await tick(0);
    expect(sosApi.confirm).toHaveBeenCalledWith("s1");
    expect(alert).not.toHaveBeenCalled();
    await tick(1100);
    expect(r.allText()).toContain(tr("sos.notified.none"));
  });

  it("取消失败后补拉也挂住（坏网络）：最多等 3 秒就提示，不等补拉自己超时（倒计时一共 60 秒）", async () => {
    m(sosApi.cancel).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = await mount();
    m(sosApi.snapshot).mockImplementation(() => new Promise(() => undefined));
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    await tick(0);
    await tick(2_500);
    expect(r.allText()).not.toContain(tr("sos.failCancel"));
    await tick(600);
    // O7：不弹框，3 秒内挂出页内提示条
    expect(alert).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("sos.failCancel"));
  });

  it("滑动取消请求超时但服务端已取消：不弹错，页面是已取消；补拉也失败时才按缓存判断（仍在倒数就弹）", async () => {
    m(sosApi.cancel).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    let r = await mount();
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
    r.unmount();

    m(sosApi.snapshot).mockImplementation(() => Promise.resolve(sosOf()));
    r = await mount();
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    act(() =>
      slideButton(r).props.onAccessibilityAction({
        nativeEvent: { actionName: "activate" },
      }),
    );
    await tick(0);
    await tick(0);
    // O7：仍在倒数时不弹框，走页内提示条
    expect(alert).not.toHaveBeenCalled();
    expect(r.allText()).toContain(tr("sos.failCancel"));
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

  it("发给两位以上联系人：逐位列出（没存名字的写号码），第二位起上面有一条分隔线", async () => {
    const r = await notified([
      {
        id: "n1",
        channel: "sms",
        target: "138****0001",
        contactName: "妈妈",
        status: "sent",
      },
      {
        id: "n2",
        channel: "sms",
        target: "139****0002",
        contactName: null,
        status: "failed",
      },
    ]);
    expect(r.allText()).toContain(`${tr("sos.viaSms")} · 138****0001`);
    expect(r.texts()).toContain("139****0002");
    expect(r.allText()).toContain(tr("accident.notif.failed"));
    expect(
      r.root.findAll(
        (n) =>
          isHost(n, "View") &&
          flat(n.props.style).borderTopWidth === StyleSheet.hairlineWidth,
      ),
    ).toHaveLength(1);
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

  it("单号是乱码（服务端 400 VALIDATION_FAILED，带控制字符的假链接）：同 404，不画倒计时、不当成状态未知", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.reject(
        new ApiRequestError(400, { code: "VALIDATION_FAILED", message: "x" }),
      ),
    );
    const r = await mount();
    expect(r.allText()).toContain(tr("sos.gone.title"));
    expect(r.allText()).not.toContain("—");
    expect(sosApi.snapshot).toHaveBeenCalledTimes(1);
  });

  // 2026-10-20 补分支：isNotFound 认 404 / 400 / 403 三种，原来只有前两种有用例。
  // 403 是「这单 / 这顶头盔不归你」（头盔在倒数中被另一部手机解绑后重绑、点了别人转发的链接）：重试永远是同一个结果，
  // 当成「状态未知」的话页面停在「—」秒、每 10 秒白拉一次、返回键还被拦着
  it("不是你的单（服务端 403 FORBIDDEN）：同 404，不画倒计时、不重试也不轮询、不拦返回键", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.reject(new ApiRequestError(403, { code: "FORBIDDEN" })),
    );
    const r = await mount();
    expect(r.allText()).toContain(tr("sos.gone.title"));
    expect(r.allText()).not.toContain("—");
    await tick(30_000);
    expect(sosApi.snapshot).toHaveBeenCalledTimes(1);
    expect(back).toBeNull();
  });

  it("没有这一单、栈里有上一页（从别的页面点进来的）：关闭就是返回上一页", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.reject(new ApiRequestError(404, { code: "NOT_FOUND" })),
    );
    const r = await mount();
    expect(r.allText()).toContain(tr("sos.gone.title"));
    r.press(tr("sos.close"));
    expect(mockRouter.back).toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it("离线、缓存也没有：数字一横下面说一句在等什么，不写「秒」（O18，负责人 10-21 定）；网络回来拉到了就收起", async () => {
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = await mount();
    expect(number(r)).toBe("—");
    expect(r.allText()).toContain(tr("sos.connecting"));
    expect(r.texts()).not.toContain(tr("sos.autoSendSuffix"));

    m(sosApi.snapshot).mockImplementation(() => Promise.resolve(sosOf()));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["sos", "s1"] });
    });
    expect(number(r)).toBe("45");
    expect(r.allText()).not.toContain(tr("sos.connecting"));
    expect(r.texts()).toContain(tr("sos.autoSendSuffix"));
  });

  it("还在拉（第一次请求没回来）：不说「正在连接」，免得一打开就闪一下", async () => {
    m(sosApi.snapshot).mockImplementation(() => new Promise(() => undefined));
    const r = await mount();
    expect(r.allText()).not.toContain(tr("sos.connecting"));
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

describe("取消先落地、立即求救被拒时替他重发（O29，负责人 10-21 定）", () => {
  const finalizedOnce = () =>
    m(sosApi.confirm)
      .mockImplementationOnce(() =>
        Promise.reject(
          new ApiRequestError(409, { code: "SOS_ALREADY_FINALIZED" }),
        ),
      )
      .mockImplementation((id: unknown) =>
        Promise.resolve(sosOf({ sosId: id as string, status: "notified" })),
      );
  /** 最近一次注入的 manual_sos 的 eventId（服务端建出的单的 triggerEventId 就是它） */
  const lastPushedEventId = () =>
    (
      m(relayApi.push).mock.calls.at(-1)?.[0] as
        { envelopes: { eventId: string }[] } | undefined
    )?.envelopes[0].eventId ?? "e-none";
  /** 这顶头盔来了一单新的：默认是重发那条事件建出的单；传 triggerEventId 就是别的事件（比如一次新的摔倒） */
  const newSos = (sosId = "s9", triggerEventId = lastPushedEventId()) => {
    const fresh = sosOf({
      sosId,
      triggerType: "manual_sos",
      triggerEventId,
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    m(sosApi.snapshot).mockImplementation(() => Promise.resolve(fresh));
    act(() => {
      qc.setQueryData(["sos-active", "h1"], { sos: fresh });
    });
  };

  it("这单已被取消：提示已重发，替这顶头盔注入 manual_sos；新单一出现就立即确认，不再倒数", async () => {
    finalizedOnce();
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    const r = await mount();
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "cancelled" })),
    );
    r.press(tr("sos.sendNow"));
    await tick(0);
    await tick(0);
    expect(r.allText()).toContain(tr("sos.resentAfterCancel"));
    expect(announce).toHaveBeenCalledWith(tr("sos.resentAfterCancel"));
    const body = m(relayApi.push).mock.calls[0][0] as {
      deviceId: string;
      envelopes: { eventType: string }[];
    };
    expect(body.deviceId).toBe("h1");
    expect(body.envelopes[0].eventType).toBe("manual_sos");
    expect(alert).not.toHaveBeenCalled();
    // 新单到了：自动确认这一单（不是被取消的那单）
    newSos();
    await tick(0);
    await tick(0);
    expect(sosApi.confirm).toHaveBeenLastCalledWith("s9");
  });

  it("这单其实已通知（别处先点了 / 到期）：不重发", async () => {
    finalizedOnce();
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve({ notifications: [] } as unknown as AccidentDetail),
    );
    const r = await mount();
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "notified" })),
    );
    r.press(tr("sos.sendNow"));
    await tick(0);
    await tick(0);
    expect(relayApi.push).not.toHaveBeenCalled();
    expect(r.allText()).not.toContain(tr("sos.resentAfterCancel"));
  });

  it("重发后两分钟都没等到新单：之后才来的那一单不自动确认", async () => {
    finalizedOnce();
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    const r = await mount();
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "cancelled" })),
    );
    r.press(tr("sos.sendNow"));
    await tick(0);
    await tick(0);
    await tick(121_000);
    newSos("s10");
    await tick(0);
    await tick(0);
    expect(sosApi.confirm).not.toHaveBeenCalledWith("s10");
  });

  it("两分钟内这顶头盔来的是别的事件建的单（比如一次新的误报摔倒）：不自动确认，照常倒数（10-21 第二轮审查）", async () => {
    finalizedOnce();
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    const r = await mount();
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "cancelled" })),
    );
    r.press(tr("sos.sendNow"));
    await tick(0);
    await tick(0);
    newSos("s10", "fall-event-xyz");
    await tick(0);
    await tick(0);
    expect(sosApi.confirm).not.toHaveBeenCalledWith("s10");
    expect(number(r)).toBe("60");
  });

  it("几顶一起倒数、页面已切到别的头盔时重发的单才到（只是顶上一个胶囊）：切过去并立即确认它，不碰屏上那单", async () => {
    qc = makeQueryClient();
    qc.setQueryData(["sos-active", "h2"], {
      sos: sosOf({ sosId: "s2", deviceId: "h2", deadline: secondsFromNow(50) }),
    });
    finalizedOnce();
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    const r = await mount(false);
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(
        id === "s1"
          ? sosOf({ status: "cancelled" })
          : sosOf({
              sosId: id as string,
              deviceId: "h2",
              deadline: secondsFromNow(50),
            }),
      ),
    );
    r.press(tr("sos.sendNow"));
    await tick(0);
    await tick(0);
    await tick(0);
    m(sosApi.confirm).mockClear();
    const resentId = lastPushedEventId();
    const s9 = sosOf({
      sosId: "s9",
      triggerType: "manual_sos",
      triggerEventId: resentId,
      deadline: secondsFromNow(60),
    });
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(
        id === "s9"
          ? s9
          : sosOf({
              sosId: id as string,
              deviceId: "h2",
              deadline: secondsFromNow(50),
            }),
      ),
    );
    act(() => {
      qc.setQueryData(["sos-active", "h1"], { sos: s9 });
    });
    for (let i = 0; i < 4; i++) await tick(0);
    expect(sosApi.confirm).toHaveBeenCalledWith("s9");
    expect(sosApi.confirm).not.toHaveBeenCalledWith("s2");
  });

  it("「全部立即求救」里被拒、原因是取消先落地的那单：同样替他重发，新单出现就确认（10-21 第二轮审查）", async () => {
    qc = makeQueryClient();
    qc.setQueryData(["sos-active", "h2"], {
      sos: sosOf({ sosId: "s2", deviceId: "h2", deadline: secondsFromNow(50) }),
    });
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    m(sosApi.confirm).mockImplementation((id: unknown) =>
      id === "s1"
        ? Promise.reject(
            new ApiRequestError(409, { code: "SOS_ALREADY_FINALIZED" }),
          )
        : Promise.resolve(
            sosOf({ sosId: id as string, deviceId: "h2", status: "notified" }),
          ),
    );
    const r = await mount(false);
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(
        id === "s1"
          ? sosOf({ status: "cancelled" })
          : sosOf({ sosId: "s2", deviceId: "h2", status: "notified" }),
      ),
    );
    r.press(tr("sos.allSendNow"));
    const buttons = alert.mock.calls.at(-1)?.[2] as
      { text: string; onPress?: () => void }[] | undefined;
    act(() => buttons?.at(-1)?.onPress?.());
    await tick(0);
    await tick(0);
    await tick(0);
    const body = m(relayApi.push).mock.calls.at(-1)?.[0] as
      { deviceId: string } | undefined;
    expect(body?.deviceId).toBe("h1");
    expect(r.allText()).toContain(tr("sos.resentAfterCancel"));
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

  it("求助建出的新单也取消了，再点「我还是需要帮助」：换新的 eventId（原来整页复用一个，服务端判重复不建单、页面却当发出去了；10-21 代码审查）", async () => {
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    const r = await cancelled();
    r.press(tr("sos.needHelp"));
    await tick(0);
    // 第一次求助建出的新单 s2 出现、页面切过去，随后它也被取消
    const s2 = sosOf({
      sosId: "s2",
      triggerType: "manual_sos",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });
    m(sosApi.snapshot).mockImplementation(() => Promise.resolve(s2));
    act(() => {
      qc.setQueryData(["sos-active", "h1"], { sos: s2 });
    });
    await tick(0);
    await tick(0);
    expect(number(r)).toBe("60");
    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve({ ...s2, status: "cancelled" as const }),
    );
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["sos", "s2"] });
    });
    r.press(tr("sos.needHelp"));
    await tick(0);
    const ids = m(relayApi.push).mock.calls.map(
      (c) =>
        (c[0] as { envelopes: { eventId: string }[] }).envelopes[0].eventId,
    );
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("头盔已不在这个账号下（404）：不进补发队列，明说没发出、不会自动重发（10-17 安卓：倒数中被解绑）", async () => {
    m(relayApi.push).mockImplementation(() =>
      Promise.reject(
        new ApiRequestError(404, {
          code: "DEVICE_NOT_FOUND",
          message: "设备不存在或未绑定到当前用户",
        }),
      ),
    );
    const r = await cancelled();
    r.press(tr("sos.needHelp"));
    await tick(0);
    expect(enqueueRelayEvent).not.toHaveBeenCalled();
    const [title, body] = alert.mock.calls.at(-1) as [string, string];
    expect(title).toBe(tr("safety.sosSendFailed"));
    expect(body).toContain(tr("safety.sosNotSent"));
    expect(body).not.toContain(tr("safety.sosQueued"));
    // 第一行说「这顶头盔已不在你的账号下」，不是给手动绑定看的「请核对设备编号」（10-18 模拟器）
    expect(body).toContain(tr("safety.sosHelmetGone"));
    expect(body).not.toContain(tr("error.deviceNotFound"));
  });

  it("服务端判请求体不合格（400，如头盔编号格式不对）：同样不进补发队列，第一行写服务端给的原因（不是「头盔已不在账号下」）", async () => {
    const err = new ApiRequestError(400, {
      code: "VALIDATION_FAILED",
      message: "deviceId 格式不正确",
    });
    m(relayApi.push).mockImplementation(() => Promise.reject(err));
    const r = await cancelled();
    r.press(tr("sos.needHelp"));
    await tick(0);
    expect(enqueueRelayEvent).not.toHaveBeenCalled();
    expect(alert).toHaveBeenLastCalledWith(
      tr("safety.sosSendFailed"),
      `${toUserMessage(err)}\n${tr("safety.sosNotSent")}`,
      NOTICE_OK,
    );
  });

  it("震动接口失败（没有震动马达的设备）：照样发出", async () => {
    m(Haptics.impactAsync).mockImplementation(() =>
      Promise.reject(new Error("vibrator unavailable")),
    );
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    try {
      const r = await cancelled();
      r.press(tr("sos.needHelp"));
      await tick(0);
      expect(relayApi.push).toHaveBeenCalledTimes(1);
      expect(notifyCriticalAccepted).toHaveBeenCalledWith("h1");
    } finally {
      m(Haptics.impactAsync).mockImplementation(() => Promise.resolve());
    }
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

  it("慢网下取消 A 还没回来就切到 B：B 的按钮不被 A 的请求锁住，「立即求救」照常发给 B；A 的失败按 A 收尾（矩阵 Q9，10-20 模拟器）", async () => {
    twoHelmets();
    let rejectA: (e: unknown) => void = () => undefined;
    m(sosApi.cancel).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectA = reject;
        }),
    );
    m(sosApi.confirm).mockImplementation((id: unknown) =>
      Promise.resolve(
        id === "s2" ? { ...second(), status: "notified" } : sosOf(),
      ),
    );
    const r = await mount();
    arrive(second());
    await tick(0);
    slideCancel(r);
    await tick(0);
    expect(sosApi.cancel).toHaveBeenCalledWith("s1");
    expect(r.allText()).toContain(tr("sos.cancelling"));
    r.press(tr("sos.chipLeft", { n: 50 }));
    for (let i = 0; i < 3; i++) await tick(0);
    expect(number(r)).toBe("50");
    // 切到 B：B 没有在途请求，滑条不是「取消中…」，「立即求救」可点
    expect(r.allText()).not.toContain(tr("sos.cancelling"));
    r.press(tr("sos.sendNow"));
    await tick(0);
    expect(sosApi.confirm).toHaveBeenCalledWith("s2");
    // A 的取消这时才失败、而 A 仍在倒数：照常提示（按 A 的状态判断，不是按屏上 B 的）
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(
        id === "s2" ? { ...second(), status: "notified" } : sosOf(),
      ),
    );
    act(() => rejectA(new TypeError("Network request failed")));
    for (let i = 0; i < 3; i++) await tick(0);
    // O7：不弹框；提示条只挂在没成功的 A 上，屏上是 B 时不显示
    expect(alert).not.toHaveBeenCalled();
    expect(r.allText()).not.toContain(tr("sos.failCancel"));
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

  it("「全部取消」几单一起结束：屏上这单先结束时不提示「已取消，已切到下一单」（10-17 安卓：结果页顶上还挂着这句）", async () => {
    twoHelmets();
    // 请求逐单发、逐单回：屏上这单（s1）先回，其余两单晚一拍
    const settle = new Map<string, () => void>();
    m(sosApi.cancel).mockImplementation(
      (id: unknown) =>
        new Promise((resolve) => {
          settle.set(id as string, () =>
            resolve(
              sosOf({
                sosId: id as string,
                deviceId: id === "s2" ? "h2" : id === "s3" ? "h3" : "h1",
                status: "cancelled",
              }),
            ),
          );
        }),
    );
    const r = await mount();
    arrive(second());
    arrive(second("s3", "h3", 55));
    await tick(0);
    r.press(tr("sos.allCancel"));
    const buttons = alert.mock.calls[0][2] as {
      text: string;
      onPress?: () => void;
    }[];
    act(() => buttons[1].onPress?.());
    await tick(0);
    settle.get("s1")?.();
    for (let i = 0; i < 3; i++) await tick(0);
    settle.get("s2")?.();
    settle.get("s3")?.();
    for (let i = 0; i < 4; i++) await tick(0);
    expect(r.allText()).toContain(tr("sos.multiDoneTitle", { n: 3 }));
    for (const name of ["通勤", "滑雪", "山地"])
      expect(r.allText()).not.toContain(tr("sos.switchedCancelled", { name }));
  });

  it("「全部立即求救」：确认后每单都调确认接口；一单没成功不弹框，切到那单、提示条写立即求救没有发出；重试只重发那一单（O7）", async () => {
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
    // 只有「全部立即求救」那一下的确认框，失败不再弹框
    expect(alert).toHaveBeenCalledTimes(1);
    // s2 没成功还在倒数：页面切到它，提示条挂在它上面
    await tick(1100);
    expect(number(r)).toBe("49");
    expect(r.allText()).toContain(tr("sos.failSend"));
    expect(r.allText()).toContain(tr("sos.failStillCounting", { n: 49 }));
    expect(announce).toHaveBeenCalledWith(
      said("sos.failSend", tr("sos.failStillCounting", { n: 50 })),
    );
    m(sosApi.confirm).mockImplementation((id: unknown) =>
      Promise.resolve(
        sosOf({ sosId: id as string, deviceId: "h2", status: "notified" }),
      ),
    );
    r.press(tr("sos.retry"));
    for (let i = 0; i < 3; i++) await tick(0);
    expect(
      m(sosApi.confirm)
        .mock.calls.slice(2)
        .map((c) => c[0]),
    ).toEqual(["s2"]);
    expect(r.allText()).toContain(tr("sos.multiDoneTitle", { n: 2 }));
    expect(r.allText()).not.toContain(tr("sos.failSend"));
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("「全部取消」两单都没成功：提示条挂在屏上这单；切到另一单的胶囊，提示条跟着那单；点重试两单一起重发、不再弹确认；都成功 → 结果页、提示条收起（O7）", async () => {
    twoHelmets();
    m(sosApi.cancel).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = await mount();
    arrive(second());
    await tick(0);
    r.press(tr("sos.allCancel"));
    const buttons = alert.mock.calls[0][2] as {
      text: string;
      onPress?: () => void;
    }[];
    act(() => buttons[1].onPress?.());
    for (let i = 0; i < 4; i++) await tick(0);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(number(r)).toBe("45");
    expect(r.allText()).toContain(tr("sos.failCancel"));
    expect(r.byLabel(tr("sos.retryCancelA11y"))).toBeTruthy();
    // 两单都没成功：念最早到期的那单还剩几秒
    expect(announce).toHaveBeenCalledWith(
      said("sos.failCancel", tr("sos.failStillCounting", { n: 45 })),
    );
    // 另一单也没成功：切过去提示条还在，秒数是那单的
    r.press(tr("sos.chipLeft", { n: 50 }));
    for (let i = 0; i < 3; i++) await tick(0);
    expect(number(r)).toBe("50");
    expect(r.allText()).toContain(tr("sos.failStillCounting", { n: 50 }));
    m(sosApi.cancel).mockImplementation((id: unknown) =>
      Promise.resolve(
        sosOf({
          sosId: id as string,
          deviceId: id === "s2" ? "h2" : "h1",
          status: "cancelled",
        }),
      ),
    );
    r.press(tr("sos.retry"));
    for (let i = 0; i < 4; i++) await tick(0);
    expect(
      m(sosApi.cancel)
        .mock.calls.slice(2)
        .map((c) => c[0])
        .sort(),
    ).toEqual(["s1", "s2"]);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(r.allText()).toContain(tr("sos.multiDoneTitle", { n: 2 }));
    expect(r.allText()).not.toContain(tr("sos.failCancel"));
  });

  it("屏上这单本机还是倒计时、同一顶头盔却来了新单（旧单终态没收到）：不崩，直接切到新单，不等旧单的权威状态——中间不出新单的胶囊、「全部取消」「也在倒计时」；旧单撤锁屏提醒、照样拉一次权威状态；不提示「已切到下一单」（10-16 评审，10-17 华为 4.27）", async () => {
    const s9 = second("s9", "h1", 55);
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(id === "s9" ? s9 : sosOf()),
    );
    const r = await mount();
    expect(number(r)).toBe("45");
    const before = m(sosApi.snapshot).mock.calls.length;
    // 旧单的权威状态要 2 秒才回来（刚恢复的网络）：这 2 秒里屏上就该是新单
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      id === "s9"
        ? Promise.resolve(s9)
        : new Promise((res) =>
            setTimeout(() => res(sosOf({ status: "notified" })), 2_000),
          ),
    );
    arrive(s9);
    await tick(0);
    await tick(0);
    expect(r.tree.toJSON()).not.toBeNull();
    expect(number(r)).toBe("55");
    expect(r.allText()).not.toContain(tr("sos.alsoCounting", { name: "通勤" }));
    expect(r.allText()).not.toContain(tr("sos.allCancel"));
    expect(r.allText()).not.toContain(tr("sos.allSendNow"));
    expect(clearSosAlert).toHaveBeenCalledWith("s1");
    expect(clearSosAlert).not.toHaveBeenCalledWith("s9");
    expect(
      m(sosApi.snapshot)
        .mock.calls.slice(before)
        .some((c) => c[0] === "s1"),
    ).toBe(true);
    await tick(2_100);
    expect(qc.getQueryData<Sos>(["sos", "s1"])?.status).toBe("notified");
    expect(number(r)).toBe("53");
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
    expect(clearSosAlert).toHaveBeenCalledWith("s1");
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

  it("外部链接带着空的单号打到已开着的倒计时页（同一张页只换参数）：不切走，接着倒数当前这单", async () => {
    const r = await mount();
    const before = m(sosApi.snapshot).mock.calls.length;
    routerState.params = { sosId: "", deviceId: "h1" };
    r.rerender(
      <QueryClientProvider client={qc}>
        <SosActiveScreen />
      </QueryClientProvider>,
    );
    for (let i = 0; i < 3; i++) await tick(0);
    expect(number(r)).toBe("45");
    expect(
      m(sosApi.snapshot)
        .mock.calls.slice(before)
        .some((c) => c[0] === ""),
    ).toBe(false);
    await tick(1050);
    expect(number(r)).toBe("44");
  });

  it("当前单立即求救（变成已通知）而另一顶还在倒数：提示「通勤：已通知联系人，已切到下一单」并切过去", async () => {
    twoHelmets();
    m(sosApi.confirm).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "notified" })),
    );
    m(sosApi.accidentDetail).mockImplementation(
      () => new Promise(() => undefined),
    );
    const r = await mount();
    arrive(second());
    await tick(0);
    r.press(tr("sos.sendNow"));
    for (let i = 0; i < 3; i++) await tick(0);
    expect(sosApi.confirm).toHaveBeenCalledWith("s1");
    expect(r.allText()).toContain(tr("sos.switchedNotified", { name: "通勤" }));
    expect(number(r)).toBe("50");
  });

  it("顶上有头盔胶囊时，提示条量出胶囊区的底边后挪到它下面，不盖住胶囊和「全部」按钮（10-18 模拟器）", async () => {
    twoHelmets();
    // 替身 View 的 measureInWindow 是空函数：换成原生那样回调胶囊区在窗口里的位置（顶边 120、高 64）
    type Measure = (
      cb: (x: number, y: number, w: number, h: number) => void,
    ) => void;
    const measure = jest
      .spyOn(
        (View as unknown as { prototype: { measureInWindow: Measure } })
          .prototype,
        "measureInWindow",
      )
      .mockImplementation((cb) => cb(0, 120, 390, 64));
    try {
      const r = await mount();
      arrive(second());
      await tick(0);
      const toastTop = () =>
        flat(
          r.root.find(
            (n) =>
              isHost(n, "View") && n.props.accessibilityLiveRegion === "polite",
          ).props.style,
        ).top;
      expect(r.allText()).toContain(tr("sos.newAlarm", { name: "滑雪" }));
      // 量到之前先贴着顶
      expect(toastTop()).toBe(mockInsets.top + 8);
      const multi = r.root.find(
        (n) =>
          isHost(n, "View") &&
          typeof n.props.onLayout === "function" &&
          n.findAll(
            (c) =>
              isHost(c, "Text") && c.children.join("") === tr("sos.allCancel"),
          ).length > 0,
      );
      act(() =>
        multi.props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 64 } },
        }),
      );
      expect(toastTop()).toBe(120 + 64 + 8);
    } finally {
      measure.mockRestore();
    }
  });

  it("同时报警的头盔多于 20 顶：胶囊只画最前面 20 个，其余合成一个「+N」", async () => {
    const r = await mount();
    act(() => {
      for (let i = 0; i < 21; i++)
        qc.setQueryData(["sos-active", `x${i}`], {
          sos: sosOf({
            sosId: `x${i}`,
            deviceId: `x${i}`,
            deadline: secondsFromNow(50 + i),
          }),
        });
    });
    await tick(0);
    expect(r.allText()).toContain(tr("sos.moreAlarms", { n: 21 }));
    expect(
      r.root.findAll(
        (n) => n.type === Tappable && n.props.accessibilityState !== undefined,
      ),
    ).toHaveLength(20);
    expect(r.texts()).toContain("+2");
  });

  it("同一顶头盔接连又来两张新单（WS 断着，前两单的终态都没收到）：每次都直接切到最新那单；每张被顶掉的旧单只撤一次锁屏提醒、只补拉一次权威状态", async () => {
    const s9 = sosOf({
      sosId: "s9",
      deadline: secondsFromNow(55),
      createdAt: secondsFromNow(-5),
    });
    const s10 = sosOf({
      sosId: "s10",
      deadline: secondsFromNow(58),
      createdAt: secondsFromNow(-2),
    });
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(id === "s9" ? s9 : id === "s10" ? s10 : sosOf()),
    );
    const cleared = (id: string) =>
      m(clearSosAlert).mock.calls.filter((c) => c[0] === id).length;
    const fetched = (id: string) =>
      m(sosApi.snapshot).mock.calls.filter((c) => c[0] === id).length;
    const r = await mount();
    arrive(s9);
    await tick(0);
    await tick(0);
    expect(number(r)).toBe("55");
    expect(cleared("s1")).toBe(1);
    const s1Fetches = fetched("s1");
    arrive(s10);
    await tick(0);
    await tick(0);
    expect(number(r)).toBe("58");
    expect(cleared("s1")).toBe(1);
    expect(cleared("s9")).toBe(1);
    expect(cleared("s10")).toBe(0);
    expect(fetched("s1")).toBe(s1Fetches);
  });

  it("「全部立即求救」都成功：结果页逐顶写发送结果，另一顶的发送记录单独去拉；短信发出去的标绿，一条短信都没有的标红", async () => {
    twoHelmets();
    m(sosApi.confirm).mockImplementation((id: unknown) =>
      Promise.resolve(
        sosOf({
          sosId: id as string,
          deviceId: id === "s2" ? "h2" : "h1",
          status: "notified",
        }),
      ),
    );
    m(sosApi.accidentDetail).mockImplementation((id: unknown) =>
      Promise.resolve({
        notifications:
          id === "s1"
            ? [
                {
                  id: "n1",
                  channel: "sms",
                  target: "138****0001",
                  contactName: "妈妈",
                  status: "sent",
                },
              ]
            : [],
      } as unknown as AccidentDetail),
    );
    const r = await mount();
    arrive(second());
    await tick(0);
    r.press(tr("sos.allSendNow"));
    const buttons = alert.mock.calls[0][2] as { onPress?: () => void }[];
    act(() => buttons[1].onPress?.());
    for (let i = 0; i < 4; i++) await tick(0);
    await tick(1100);
    expect(r.allText()).toContain(tr("sos.multiDoneTitle", { n: 2 }));
    expect(sosApi.accidentDetail).toHaveBeenCalledWith("s1");
    expect(sosApi.accidentDetail).toHaveBeenCalledWith("s2");
    const badges = r.root
      .findAllByType(Badge)
      .map((b) => [b.props.label, b.props.variant]);
    expect(badges).toHaveLength(2);
    expect(badges).toEqual(
      expect.arrayContaining([
        [tr("sos.notified.sent"), "success"],
        [tr("sos.notified.none"), "danger"],
      ]),
    );
  });

  it("「全部立即求救」请求都超时但服务端都已通知（短信慢）：不弹「出错了」；补拉后仍有一单在倒数才弹（10-20 模拟器）", async () => {
    twoHelmets();
    m(sosApi.confirm).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve({ notifications: [] } as unknown as AccidentDetail),
    );
    let r = await mount();
    arrive(second());
    await tick(0);
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(
        id === "s2"
          ? { ...second(), status: "notified" }
          : sosOf({ status: "notified" }),
      ),
    );
    r.press(tr("sos.allSendNow"));
    let buttons = alert.mock.calls[0][2] as { onPress?: () => void }[];
    act(() => buttons[1].onPress?.());
    for (let i = 0; i < 6; i++) await tick(0);
    expect(sosApi.confirm).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(1);
    r.unmount();

    alert.mockClear();
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(id === "s2" ? second() : sosOf()),
    );
    r = await mount();
    arrive(second());
    await tick(0);
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      Promise.resolve(id === "s2" ? second() : sosOf({ status: "notified" })),
    );
    r.press(tr("sos.allSendNow"));
    buttons = alert.mock.calls[0][2] as { onPress?: () => void }[];
    act(() => buttons[1].onPress?.());
    for (let i = 0; i < 6; i++) await tick(0);
    // O7：仍在倒数的那单不弹框，切过去挂页内提示条；补拉到的状态写回了缓存，不等轮询就切到还在倒数的滑雪
    expect(alert).toHaveBeenCalledTimes(1);
    await tick(1100);
    expect(r.allText()).toContain(tr("sos.failSend"));
    expect(r.allText()).toContain(tr("sos.fromHelmet", { name: "滑雪" }));
  });

  it("结果页上每顶各自的「我还是需要帮助」：替那一行的头盔注入 manual_sos，两顶各用各的 eventId", async () => {
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
    m(relayApi.push).mockImplementation(() =>
      Promise.resolve({ accepted: 1, duplicate: 0, invalid: 0 }),
    );
    const r = await mount();
    arrive(second());
    await tick(0);
    r.press(tr("sos.allCancel"));
    const buttons = alert.mock.calls[0][2] as { onPress?: () => void }[];
    act(() => buttons[1].onPress?.());
    for (let i = 0; i < 4; i++) await tick(0);
    expect(r.allText()).toContain(tr("sos.multiDoneTitle", { n: 2 }));
    /** 名字所在那一行里的「我还是需要帮助」 */
    const helpOf = (name: string) => {
      let row = r.root.find(
        (n) => isHost(n, "Text") && n.children.join("") === name,
      );
      while (row.parent && row.findAllByType(Tappable).length === 0)
        row = row.parent;
      return row.findByType(Tappable);
    };
    act(() => helpOf("滑雪").props.onPress());
    await tick(0);
    act(() => helpOf("通勤").props.onPress());
    await tick(0);
    const sent = m(relayApi.push).mock.calls.map(
      (c) =>
        c[0] as {
          deviceId: string;
          envelopes: { eventType: string; eventId: string }[];
        },
    );
    expect(sent.map((b) => b.deviceId)).toEqual(["h2", "h1"]);
    expect(sent.every((b) => b.envelopes[0].eventType === "manual_sos")).toBe(
      true,
    );
    expect(sent[0].envelopes[0].eventId).not.toBe(sent[1].envelopes[0].eventId);
    expect(notifyCriticalAccepted).toHaveBeenCalledWith("h2");
  });

  // 另一顶的单在倒数中途从进行中消失（WS 断着、安全页账号级轮询写成「没有」），本机不知道它怎么结束的；
  // 屏上这单处理完进结果页时，要先补拉它的权威状态再写结论（10-19 夜测 D2，原来一律写「正在通知紧急联系人」）
  const vanishThenFinish = async (s2: () => Promise<Sos | null>) => {
    twoHelmets();
    m(sosApi.cancel).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "cancelled" })),
    );
    const r = await mount();
    arrive(second());
    await tick(0);
    act(() => {
      qc.setQueryData(["sos-active", "h2"], { sos: null });
    });
    await tick(0);
    expect(r.allText()).not.toContain(tr("sos.allCancel"));
    m(sosApi.snapshot).mockImplementation((id: unknown) =>
      id === "s2" ? s2() : Promise.resolve(sosOf()),
    );
    slideCancel(r);
    for (let i = 0; i < 6; i++) await tick(0);
    expect(r.allText()).toContain(tr("sos.multiDoneTitle", { n: 2 }));
    expect(m(sosApi.snapshot).mock.calls).toContainEqual(["s2", "h2"]);
    return r;
  };

  it("另一顶的单没拿到终态就离开了进行中：结果页补拉它的权威状态；在别处已取消就写已取消（可「我还是需要帮助」），不说正在通知", async () => {
    const r = await vanishThenFinish(() =>
      Promise.resolve({ ...second(), status: "cancelled" }),
    );
    // 两行都是「已取消」：没有徽标，各有一个「我还是需要帮助」
    expect(r.root.findAllByType(Badge)).toHaveLength(0);
    expect(r.texts().filter((x) => x === tr("sos.needHelp"))).toHaveLength(2);
    expect(r.allText()).not.toContain(tr("sos.notified.sending"));
    expect(sosApi.accidentDetail).not.toHaveBeenCalledWith("s2");
  });

  it("补拉到已通知：再去读它的发送结果，按结果写（短信已发出）", async () => {
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
        ],
      }),
    );
    const r = await vanishThenFinish(() =>
      Promise.resolve({ ...second(), status: "notified" }),
    );
    for (let i = 0; i < 3; i++) await tick(0);
    expect(sosApi.accidentDetail).toHaveBeenCalledWith("s2");
    expect(r.root.findAllByType(Badge).map((b) => b.props.label)).toEqual([
      tr("sos.notified.sent"),
    ]);
  });

  it("补拉失败（离线）：那一行写「状态待确认」，不说成正在通知紧急联系人", async () => {
    const r = await vanishThenFinish(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    expect(r.root.findAllByType(Badge).map((b) => b.props.label)).toEqual([
      tr("sos.multiStatusUnknown"),
    ]);
    expect(r.allText()).not.toContain(tr("sos.notified.sending"));
    expect(sosApi.accidentDetail).not.toHaveBeenCalledWith("s2");
  });
});

describe("演练（drill=1）", () => {
  beforeEach(() => {
    routerState.params = { drill: "1", deviceId: "h1" };
  });

  it("从首页 / 安全设置的入口打开（链接只有 drill=1、没有头盔号）：照常倒数；没有联系人时说明真实求救时也通知不了人", async () => {
    routerState.params = { drill: "1" };
    m(contactsApi.list).mockImplementation(() => Promise.resolve([]));
    const r = await mount();
    expect(number(r)).toBe("60");
    expect(r.allText()).toContain(tr("sos.noContactsDrill"));
    expect(r.allText()).not.toContain(tr("sos.noContacts"));
    expect(sosApi.snapshot).not.toHaveBeenCalled();
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

  it("演练中被真单页盖住（失焦）：演练立刻结束、警报停，不会和真单两路警报叠在一起", async () => {
    const r = await mount();
    expect(number(r)).toBe("60");
    await tick(2000);
    expect(mockAlarm.play).toHaveBeenCalled();
    routerState.focused = false;
    await act(async () => {
      r.rerender(
        <QueryClientProvider client={qc}>
          <SosActiveScreen />
        </QueryClientProvider>,
      );
    });
    await tick(0);
    expect(r.allText()).toContain(tr("sos.drillDoneTitle"));
    expect(mockAlarm.pause).toHaveBeenCalled();
    const plays = mockAlarm.play.mock.calls.length;
    await tick(3000);
    expect(mockAlarm.play.mock.calls.length).toBe(plays);
    expect(sosApi.cancel).not.toHaveBeenCalled();
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

  // 2026-10-20 补分支：失焦收尾只该结束「还在倒数」的演练（见页面 useFocusEffect 的注释），已经出了结果的不能改写
  const blur = async (r: Rendered) => {
    routerState.focused = false;
    await act(async () => {
      r.rerender(
        <QueryClientProvider client={qc}>
          <SosActiveScreen />
        </QueryClientProvider>,
      );
    });
    await tick(0);
  };

  it("演练里已按「立即求救」、之后页面被盖住（失焦）：结果页仍写「会尝试短信通知联系人」，不被改写成「已在倒计时内取消」", async () => {
    const r = await mount();
    r.press(tr("sos.sendNow"));
    expect(r.allText()).toContain(tr("sos.drillNotifiedBody"));
    await blur(r);
    expect(r.allText()).toContain(tr("sos.drillNotifiedBody"));
    expect(r.allText()).not.toContain(tr("sos.drillCancelledBody"));
  });

  // 演练倒数走完时「已通知」是渲染期按 deadline 推出来的，本地状态仍是 pending；失焦收尾原来只看本地状态，
  // 把一场已经走完的演练改写成「已取消」——演练要教的恰好反了（10-20 补测查出，#319 带进来的）。现在只结束还在倒数的演练
  it("演练倒数走完（显示已通知）后失焦：结果页仍是「已通知」，不被改写成「已在倒计时内取消」", async () => {
    const r = await mount();
    await tick(61_000);
    expect(r.allText()).toContain(tr("sos.drillNotifiedBody"));
    await blur(r);
    expect(r.allText()).toContain(tr("sos.drillNotifiedBody"));
    expect(r.allText()).not.toContain(tr("sos.drillCancelledBody"));
  });
});

describe("墙钟往前跳", () => {
  it("倒数中手机时间被拨快 90 秒（或睡醒）：页面立刻再拉一次快照，不等 10 s 轮询；演练不拉", async () => {
    // 先让时钟学到一个偏移（真机上每个响应的 Date 头都会喂；测试里 snapshot 是 mock，没有 HTTP）；
    // 用完重置，不然模块级的锚会把后面用例的假时钟当成「往回拨」
    __resetServerClockForTests();
    noteServerDate(new Date(Date.now()).toUTCString(), Date.now());
    const r = await mount();
    expect(number(r)).toBe("45");
    const before = m(sosApi.snapshot).mock.calls.length;
    jest.setSystemTime(Date.now() + 90_000);
    await tick(1100);
    expect(m(sosApi.snapshot).mock.calls.length).toBe(before + 1);
    r.unmount();
    __resetServerClockForTests();
  });
});

describe("状态未知时关掉页面", () => {
  it("快照一直不回（没网）时关掉页面：从「已拉起」里摘掉，之后推送 / 补拉还能再弹这单", async () => {
    m(sosApi.snapshot).mockImplementation(() => new Promise(() => undefined));
    const r = await mount();
    expect(number(r)).toBe("—");
    expect(presentedSos.current.has("s1")).toBe(true);
    r.unmount();
    expect(presentedSos.current.has("s1")).toBe(false);
  });
  it("拿到过状态（倒数中）再离开页面：仍登记为已拉起，不会被重复弹起", async () => {
    const r = await mount();
    expect(number(r)).toBe("45");
    r.unmount();
    expect(presentedSos.current.has("s1")).toBe(true);
  });
});

describe("会话被服务端否定时倒数结束才登出（O19-A，负责人 10-21 定）", () => {
  afterEach(() => {
    act(() => {
      useAuthStore.setState({ sessionDeadUntil: null });
    });
  });

  it("页面把这单的截止时刻（本机时钟）登记给 auth-store；这单结束或页面关掉就撤掉", async () => {
    const deadline = Date.now() + 45_000;
    const r = await mount();
    expect(countdownHoldUntil()).toBe(deadline - serverClockOffsetMs());

    m(sosApi.snapshot).mockImplementation(() =>
      Promise.resolve(sosOf({ status: "cancelled" })),
    );
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["sos", "s1"] });
    });
    expect(countdownHoldUntil()).toBeNull();
    r.unmount();
    expect(countdownHoldUntil()).toBeNull();

    m(sosApi.snapshot).mockImplementation(() => Promise.resolve(sosOf()));
    const again = await mount();
    expect(countdownHoldUntil()).not.toBeNull();
    again.unmount();
    expect(countdownHoldUntil()).toBeNull();
  });

  it("几单一起倒数：登记最晚的那一刻（最后一单倒数完才登出）", async () => {
    qc = makeQueryClient();
    const late = sosOf({
      sosId: "s2",
      deviceId: "h2",
      deadline: secondsFromNow(58),
    });
    qc.setQueryData(["sos-active", "h2"], { sos: late });
    await mount(false);
    expect(countdownHoldUntil()).toBe(
      new Date(late.deadline).getTime() - serverClockOffsetMs(),
    );
  });

  it("演练不登记：它不通知任何人，照常登出", async () => {
    routerState.params = { drill: "1", deviceId: "h1" };
    await mount();
    expect(countdownHoldUntil()).toBeNull();
  });

  it("会话已被否定：取消滑条和立即求救换成「重新登录后取消」+ 说明（到点照常通知），读屏念一遍；点它立刻回登录页", async () => {
    const endDeadSession = jest.fn(async () => undefined);
    const realEnd = useAuthStore.getState().endDeadSession;
    useAuthStore.setState({ endDeadSession });
    try {
      const r = await mount();
      expect(r.allText()).toContain(tr("sos.sendNow"));
      act(() => {
        useAuthStore.setState({ sessionDeadUntil: Date.now() + 45_000 });
      });
      expect(r.allText()).toContain(tr("sos.sessionDeadTitle"));
      expect(r.allText()).toContain(tr("sos.sessionDeadBody"));
      expect(r.allText()).not.toContain(tr("sos.sendNow"));
      expect(r.root.findAllByType(SlideToCancel)).toHaveLength(0);
      expect(number(r)).toBe("45"); // 倒计时照走
      expect(announce).toHaveBeenCalledWith(
        `${tr("sos.sessionDeadTitle")}. ${tr("sos.sessionDeadBody")}`,
      );
      r.press(tr("sos.reloginToCancel"));
      expect(endDeadSession).toHaveBeenCalledTimes(1);
    } finally {
      useAuthStore.setState({ endDeadSession: realEnd });
    }
  });

  it("失效期间这一页的单都结束了（还连着的实时通道推来取消 / 到点通知）：立刻回登录页，到点通知的告诉登录页联系人已收到（10-21 代码审查）", async () => {
    const endDeadSession = jest.fn(
      async (_o?: { duringSos?: boolean }) => undefined,
    );
    const realEnd = useAuthStore.getState().endDeadSession;
    useAuthStore.setState({ endDeadSession });
    try {
      for (const [status, duringSos] of [
        ["cancelled", false],
        ["notified", true],
      ] as const) {
        endDeadSession.mockClear();
        m(sosApi.snapshot).mockImplementation(() => Promise.resolve(sosOf()));
        const r = await mount();
        act(() => {
          useAuthStore.setState({ sessionDeadUntil: Date.now() + 45_000 });
        });
        expect(endDeadSession).not.toHaveBeenCalled();
        m(sosApi.snapshot).mockImplementation(() =>
          Promise.resolve(sosOf({ status })),
        );
        await act(async () => {
          await qc.refetchQueries({ queryKey: ["sos", "s1"] });
        });
        expect(endDeadSession).toHaveBeenCalledWith({ duringSos });
        r.unmount();
        act(() => {
          useAuthStore.setState({ sessionDeadUntil: null });
        });
      }
    } finally {
      useAuthStore.setState({ endDeadSession: realEnd });
    }
  });

  it("会话没失效时单子结束：不碰登录", async () => {
    const endDeadSession = jest.fn(async () => undefined);
    const realEnd = useAuthStore.getState().endDeadSession;
    useAuthStore.setState({ endDeadSession });
    try {
      await mount();
      m(sosApi.snapshot).mockImplementation(() =>
        Promise.resolve(sosOf({ status: "cancelled" })),
      );
      await act(async () => {
        await qc.refetchQueries({ queryKey: ["sos", "s1"] });
      });
      expect(endDeadSession).not.toHaveBeenCalled();
    } finally {
      useAuthStore.setState({ endDeadSession: realEnd });
    }
  });

  it("几单一起倒数时会话被否定：「全部取消 / 全部立即求救」也不放", async () => {
    qc = makeQueryClient();
    qc.setQueryData(["sos-active", "h2"], {
      sos: sosOf({ sosId: "s2", deviceId: "h2", deadline: secondsFromNow(50) }),
    });
    const r = await mount(false);
    expect(r.allText()).toContain(tr("sos.allCancel"));
    act(() => {
      useAuthStore.setState({ sessionDeadUntil: Date.now() + 50_000 });
    });
    expect(r.allText()).not.toContain(tr("sos.allCancel"));
    expect(r.allText()).not.toContain(tr("sos.allSendNow"));
  });
});
