// 安全标签页（只测不改：底部是长按 2 秒的手动求救）：
// 状态卡的各种结论（列表没拿到 / 没绑头盔 / 连接断开 / 身份不符 / 确认不了 / 通知关 / 没联系人 / 一切正常）、
// 三项核对、进行中的求救让位、最近一条 SOS、通知被拒的一次性说明，以及长按求救：
// 记在当前头盔名下、一次长按一个 eventId、发送成功立刻核对进行中的求救、失败按原 eventId 进持久队列并说明。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AccidentListItem, DevicePublic } from "@helmet/shared";
import * as Haptics from "expo-haptics";
import { Alert } from "react-native";
import { act } from "react-test-renderer";
import { mockRouter } from "@/__tests__/helpers/native-mocks";
import {
  makeQueryClient,
  render,
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { ApiRequestError } from "@/api/client";
import { contactsApi } from "@/api/contacts";
import { relayApi } from "@/api/relay";
import { sosApi } from "@/api/sos";
import { Tappable } from "@/components/tappable";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { shortDate } from "@/i18n/format";
import {
  enqueueRelayEvent,
  notifyCriticalAccepted,
} from "@/services/ble-relay-uplink";
import { useThemeStore } from "@/stores/theme-store";
import SafetyScreen from "@/app/(tabs)/safety";

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
  ImpactFeedbackStyle: { Light: "light", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
}));
jest.mock("@/api/contacts", () => ({ contactsApi: { list: jest.fn() } }));
jest.mock("@/api/sos", () => ({ sosApi: { accidents: jest.fn() } }));
jest.mock("@/api/relay", () => ({
  ...jest.requireActual<typeof import("@/api/relay")>("@/api/relay"),
  relayApi: { push: jest.fn(), pushEvent: jest.fn() },
}));
jest.mock("@/services/server-clock", () => ({
  serverNow: () => Date.UTC(2026, 9, 16, 2),
}));
jest.mock("@/services/ble-relay-uplink", () => ({
  enqueueRelayEvent: jest.fn(),
  notifyCriticalAccepted: jest.fn(),
}));
jest.mock("@/services/foreground-settled", () => ({
  whenForegroundSettled: (run: () => void) => {
    run();
    return () => undefined;
  },
}));
const mockOpenSettings = jest.fn(() => Promise.resolve());
jest.mock("@/services/notification-settings", () => ({
  openNotificationSettings: () => mockOpenSettings(),
}));
const mockSafety = {
  list: [] as DevicePublic[],
  known: true,
  stale: false,
  chosenId: null as string | null,
  refetch: jest.fn(() => Promise.resolve()),
  links: {} as Record<string, string>,
  notify: "granted" as string | null,
  pending: [] as { sosId: string; deviceId: string }[],
  drill: { unseen: false, open: jest.fn() },
};
jest.mock("@/hooks/use-safety", () => ({
  useHelmets: () => mockSafety,
  useHelmetLinks: () => mockSafety.links,
  useNotifyPermission: () => mockSafety.notify,
  usePendingSos: () => mockSafety.pending,
  useSosDrill: () => mockSafety.drill,
  useCurrentHelmetChoice: () => ({
    choose: jest.fn(),
    ready: true,
    chosenId: null,
  }),
}));

const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const dev = (id: string, name: string | null = null) =>
  ({ deviceId: id, name }) as DevicePublic;
const mount = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <SafetyScreen />
    </QueryClientProvider>,
  );
/** 底部的 SOS 长按按钮 */
const sosButton = (r: Rendered) =>
  r.root.find(
    (n) =>
      typeof n.type !== "string" &&
      n.props.delayLongPress === 2000 &&
      typeof n.props.onLongPress === "function",
  );

let alert: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  Object.assign(mockSafety, {
    list: [dev("h1", "通勤")],
    known: true,
    stale: false,
    chosenId: null,
    links: { h1: "connected" },
    notify: "granted",
    pending: [],
    drill: { unseen: false, open: jest.fn() },
  });
  m(contactsApi.list).mockImplementation(() =>
    Promise.resolve([{ id: "c1" }, { id: "c2" }]),
  );
  m(sosApi.accidents).mockImplementation(() =>
    Promise.resolve({ items: [], total: 0 }),
  );
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
});
afterEach(() => {
  alert.mockRestore();
  jest.clearAllMocks();
});

describe("通知被拒的一次性说明（每个进程只弹一次）", () => {
  it("通知被拒：说明锁屏收不到摔倒提醒，可去设置；再进页面不再弹", async () => {
    mockSafety.notify = "denied";
    const r = mount();
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    const [title, , buttons] = alert.mock.calls[0] as [
      string,
      string,
      { onPress?: () => void }[],
    ];
    expect(title).toBe(tr("safety.notifyAlertTitle"));
    act(() => buttons[1].onPress!());
    expect(mockOpenSettings).toHaveBeenCalled();
    // 状态卡持续提醒
    await waitFor(() =>
      expect(r.allText()).toContain(tr("safety.state.notifyOff")),
    );
    expect(r.allText()).toContain(tr("safety.check.notifyOff"));
    r.press(tr("safety.action.notifySettings"));
    expect(mockOpenSettings).toHaveBeenCalledTimes(2);
    mount();
    expect(alert).toHaveBeenCalledTimes(1);
  });
});

describe("状态卡", () => {
  it("一切正常：只有结论和三项核对（头盔名 / 通知 / 联系人数），没有按钮", async () => {
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("safety.check.contacts", { n: 2 })),
    );
    expect(r.allText()).toContain(tr("safety.state.ready"));
    expect(r.texts()).toContain("通勤");
    expect(r.texts()).toContain(tr("safety.check.notify"));
  });

  it("头盔列表还没拿到：骨架；拿不到：失败卡可重试（不能说成没绑头盔）", () => {
    Object.assign(mockSafety, { known: false, stale: false });
    let r = mount();
    expect(r.allText()).not.toContain(tr("safety.state.noHelmet"));
    Object.assign(mockSafety, { known: false, stale: true });
    r = mount();
    expect(r.allText()).toContain(tr("safety.state.loadFailed"));
    r.press(tr("safety.action.retry"));
    expect(mockSafety.refetch).toHaveBeenCalled();
  });

  it("没绑头盔：去绑定；也没有 SOS 按钮", () => {
    mockSafety.list = [];
    const r = mount();
    expect(r.allText()).toContain(tr("safety.state.noHelmet"));
    r.press(tr("safety.action.bind"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/bind-device");
    expect(r.root.findAll((n) => n.props.delayLongPress === 2000)).toHaveLength(
      0,
    );
  });

  it("头盔没连上：提醒色说明并去看连接；蓝牙关 / 身份不符各有说明", async () => {
    mockSafety.links = { h1: "searching" };
    let r = mount();
    expect(r.allText()).toContain(tr("safety.state.linkDownBody"));
    r.press(tr("safety.action.checkLink"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/device/h1");
    mockSafety.links = { h1: "bluetoothOff" };
    r = mount();
    expect(r.allText()).toContain(tr("safety.state.bluetoothBody"));
    mockSafety.links = { h1: "mismatch" };
    r = mount();
    expect(r.allText()).toContain(tr("safety.state.mismatchBody"));
  });

  it("确认不了：服务端状态拿不到时写「以下为上次获取的状态」；通知 / 联系人待确认", async () => {
    mockSafety.links = { h1: "unknown" };
    let r = mount();
    expect(r.allText()).toContain(tr("safety.state.unknownBody"));
    Object.assign(mockSafety, { stale: true });
    r = mount();
    expect(r.allText()).toContain(tr("safety.state.staleBody"));
    r.press(tr("safety.action.helmetDetail"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/device/h1");
    Object.assign(mockSafety, {
      stale: false,
      links: { h1: "connected" },
      notify: null,
    });
    m(contactsApi.list).mockImplementation(() => new Promise(() => undefined));
    r = mount();
    expect(r.allText()).toContain(tr("safety.check.notifyUnknown"));
    expect(r.allText()).toContain(tr("safety.check.contactsUnknown"));
  });

  it("没有联系人：去添加", async () => {
    m(contactsApi.list).mockImplementation(() => Promise.resolve([]));
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("safety.state.noContacts")),
    );
    expect(r.allText()).toContain(tr("safety.check.contactsNone"));
    r.press(tr("safety.action.addContact"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/add-contact");
  });

  it("进行中的求救：状态卡让位给红框卡片（哪顶头盔上的都列出来），SOS 按钮收起", () => {
    mockSafety.pending = [{ sosId: "s1", deviceId: "h9" }];
    const r = mount();
    expect(r.allText()).toContain(tr("safety.state.sosBody", { device: "h9" }));
    expect(r.allText()).not.toContain(tr("safety.state.ready"));
    r.press(tr("safety.action.openCountdown"));
    expect(mockRouter.navigate).toHaveBeenCalledWith(
      "/sos-active?sosId=s1&deviceId=h9",
    );
    expect(r.root.findAll((n) => n.props.delayLongPress === 2000)).toHaveLength(
      0,
    );
  });
});

describe("最近一条 SOS 与入口", () => {
  it("还在拉写省略号；有就写日期 / 类型 / 状态（取所有头盔里最近的）；拉失败不说成暂无", async () => {
    mockSafety.list = [dev("h1"), dev("h2")];
    m(sosApi.accidents).mockImplementation((...args: unknown[]) =>
      Promise.resolve({
        items:
          args[0] === "h1"
            ? [
                {
                  sosId: "a",
                  createdAt: "2026-10-10T01:00:00.000Z",
                  triggerType: "possible_fall",
                  status: "cancelled",
                } as AccidentListItem,
              ]
            : [
                {
                  sosId: "b",
                  createdAt: "2026-10-12T01:00:00.000Z",
                  triggerType: "manual_sos",
                  status: "notified",
                } as AccidentListItem,
              ],
        total: 1,
      }),
    );
    let r = mount();
    expect(r.texts()).toContain("…");
    await waitFor(() =>
      expect(r.allText()).toContain(
        tr("safety.recordsLatest", {
          date: shortDate("2026-10-12T01:00:00.000Z", "zh-CN"),
          type: tr("safety.manualSos"),
          status: tr("safety.status.notified"),
        }),
      ),
    );
    r.press(tr("safety.records"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/safety-records?tab=sos");
    m(sosApi.accidents).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("safety.latestSosFailed")),
    );
    m(sosApi.accidents).mockImplementation(() =>
      Promise.resolve({ items: [], total: 0 }),
    );
    r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.sosEmptyAll")),
    );
  });

  it("右上角设置；没打开过演练的显示演练入口", () => {
    mockSafety.drill = { unseen: true, open: jest.fn() };
    const r = mount();
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("safety.settingsA11y"),
        )
        .props.onPress(),
    );
    expect(mockRouter.navigate).toHaveBeenCalledWith("/safety-settings");
    r.press(tr("safety.drillLink"));
    expect(mockSafety.drill.open).toHaveBeenCalled();
  });

  it("绑了两顶以上时按钮上方写明求救记在哪一顶", () => {
    Object.assign(mockSafety, {
      list: [dev("h1", "通勤"), dev("h2", "滑雪")],
      links: { h1: "connected", h2: "connected" },
      chosenId: "h2",
    });
    const r = mount();
    expect(r.allText()).toContain(tr("safety.sosTarget", { device: "滑雪" }));
  });
});

describe("长按求救", () => {
  it("按下就有重触觉；没按满 2 秒松手不触发（只抖一下）", () => {
    const r = mount();
    const btn = sosButton(r);
    act(() => btn.props.onPressIn());
    expect(Haptics.impactAsync).toHaveBeenCalledWith("heavy");
    act(() => btn.props.onPressOut());
    expect(relayApi.push).not.toHaveBeenCalled();
  });

  it("按满 2 秒：经 app-relay 给当前头盔注入 manual_sos；成功后立刻核对进行中的求救", async () => {
    m(relayApi.push).mockImplementation(() => Promise.resolve({ accepted: 1 }));
    const r = mount();
    const btn = sosButton(r);
    act(() => btn.props.onPressIn());
    await act(async () => {
      btn.props.onLongPress();
      await Promise.resolve();
    });
    act(() => btn.props.onPressOut());
    expect(Haptics.notificationAsync).toHaveBeenCalledWith("warning");
    const body = m(relayApi.push).mock.calls[0][0] as {
      deviceId: string;
      envelopes: { eventType: string; deviceId: string; eventId: string }[];
    };
    expect(body.deviceId).toBe("h1");
    expect(body.envelopes).toHaveLength(1);
    expect(body.envelopes[0]).toMatchObject({
      eventType: "manual_sos",
      deviceId: "h1",
    });
    await waitFor(() =>
      expect(notifyCriticalAccepted).toHaveBeenCalledWith("h1"),
    );
    expect(enqueueRelayEvent).not.toHaveBeenCalled();
  });

  it("发送失败：同一个 envelope（同一个 eventId）进持久队列重试，并说明已暂存", async () => {
    m(relayApi.push).mockImplementation(() =>
      Promise.reject(new ApiRequestError(503, { code: "INTERNAL_ERROR" })),
    );
    const r = mount();
    await act(async () => {
      sosButton(r).props.onLongPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    const sent = (
      m(relayApi.push).mock.calls[0][0] as { envelopes: { eventId: string }[] }
    ).envelopes[0];
    await waitFor(() => expect(enqueueRelayEvent).toHaveBeenCalledTimes(1));
    expect(m(enqueueRelayEvent).mock.calls[0][0]).toBe(sent);
    expect(alert).toHaveBeenCalledWith(
      translate("safety.sosSendFailed"),
      `${translate("error.internal")}\n${translate("safety.sosQueued")}`,
    );
    expect(notifyCriticalAccepted).not.toHaveBeenCalled();
  });

  it("两次长按是两个不同的 eventId（服务端按它幂等，不能复用）", async () => {
    m(relayApi.push).mockImplementation(() => Promise.resolve({}));
    const r = mount();
    await act(async () => {
      sosButton(r).props.onLongPress();
      sosButton(r).props.onLongPress();
      await Promise.resolve();
    });
    const ids = m(relayApi.push).mock.calls.map(
      (c) =>
        (c[0] as { envelopes: { eventId: string }[] }).envelopes[0].eventId,
    );
    expect(new Set(ids).size).toBe(2);
  });
});

describe("开发测试入口（DEV 构建）", () => {
  it("展开后能注入摔倒 / 碰撞风险；注入失败弹窗", async () => {
    m(relayApi.pushEvent)
      .mockImplementationOnce(() => Promise.resolve({}))
      .mockImplementationOnce(() =>
        Promise.reject(new TypeError("Network request failed")),
      );
    const r = mount();
    r.press(tr("safety.dev.title"));
    r.press(tr("safety.dev.fall"));
    expect(relayApi.pushEvent).toHaveBeenCalledWith("h1", "possible_fall", {
      confidence: 0.95,
    });
    r.press(tr("safety.dev.collision"));
    expect(relayApi.pushEvent).toHaveBeenLastCalledWith(
      "h1",
      "collision_risk",
      { riskLevel: "high", direction: "rear" },
    );
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        translate("safety.dev.failed"),
        translate("error.network"),
      ),
    );
  });
});
