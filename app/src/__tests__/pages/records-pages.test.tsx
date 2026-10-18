// 紧急联系人（列表 / 添加）、安全设置、关于这顶头盔、求救记录详情。
// 查询用测试版 QueryClient、接口逐个替换；钩子（通知权限 / 演练 / 更换提醒 / 省电白名单）替换成可控的值。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AccidentDetail, EmergencyContact } from "@helmet/shared";
import { Alert, Platform, Share, Switch, Text } from "react-native";
import { act } from "react-test-renderer";
import { mockRouter, routerState } from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  makeQueryClient,
  render,
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { ApiRequestError, SessionEndedError } from "@/api/client";
import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { sosApi } from "@/api/sos";
import { Tappable } from "@/components/tappable";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useBleStore } from "@/stores/ble-store";
import { useThemeStore } from "@/stores/theme-store";
import AccidentDetailScreen from "@/app/accident/[accidentId]";
import AddContactScreen from "@/app/add-contact";
import ContactsScreen from "@/app/contacts";
import DeviceAboutScreen from "@/app/device-about/[deviceId]";
import SafetySettingsScreen from "@/app/safety-settings";

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
jest.mock("@/api/contacts", () => ({
  contactsApi: { list: jest.fn(), create: jest.fn(), remove: jest.fn() },
}));
jest.mock("@/api/devices", () => ({
  devicesApi: { list: jest.fn(), detail: jest.fn(), status: jest.fn() },
}));
jest.mock("@/api/sos", () => ({ sosApi: { accidentDetail: jest.fn() } }));
const mockMap = { setHelmet: jest.fn() };
jest.mock("@/components/map/amap-view", () => {
  const { createElement: h, useEffect } =
    jest.requireActual<typeof import("react")>("react");
  return {
    AmapView: (props: {
      controllerRef: { current: unknown };
      onReady?: () => void;
    }) => {
      useEffect(() => {
        props.controllerRef.current = mockMap;
        return () => {
          props.controllerRef.current = null;
        };
      }, [props.controllerRef]);
      return h("AmapView", props);
    },
  };
});
const mockNavTo = jest.fn(() => Promise.resolve());
jest.mock("@/components/map/nav-links", () => ({
  openAmapNavigation: (...a: unknown[]) => mockNavTo(...(a as [])),
}));
const mockSafety = {
  notify: null as string | null,
  drillOpen: jest.fn(),
  reminder: { enabled: true as boolean | null, setEnabled: jest.fn() },
  steps: [] as { key: string; done: boolean; action?: () => void }[],
};
jest.mock("@/hooks/use-safety", () => ({
  useNotifyPermission: () => mockSafety.notify,
  useSosDrill: () => ({ open: mockSafety.drillOpen }),
}));
jest.mock("@/hooks/use-switch-reminder", () => ({
  useSwitchReminderSetting: () => mockSafety.reminder,
}));
jest.mock("@/components/ble-onboarding", () => ({
  useBleOnboardingSteps: () => mockSafety.steps,
}));
const mockOpenSettings = jest.fn(() => Promise.resolve());
jest.mock("@/services/notification-settings", () => ({
  openNotificationSettings: () => mockOpenSettings(),
}));

const dark = Colors.dark;
/** 只有一个按钮的提示统一走 services/notice 的 showNotice：第三个参数是一个「确定」 */
const NOTICE_OK = [{ text: translate("common.confirm", undefined, "zh-CN") }];
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const mount = (el: React.ReactElement, qc = makeQueryClient()) =>
  render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
const contact = (
  id: string,
  name: string,
  relation?: string,
): EmergencyContact =>
  ({
    id,
    name,
    phone: `1380000000${id}`,
    relation: relation ?? null,
  }) as EmergencyContact;

let alert: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  routerState.params = {};
});
afterEach(() => {
  alert.mockRestore();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("紧急联系人列表", () => {
  it("加载中不显示空态；拿到空列表显示空态，添加按钮可点", async () => {
    let resolve!: (v: EmergencyContact[]) => void;
    m(contactsApi.list).mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    const r = mount(<ContactsScreen />);
    expect(r.allText()).not.toContain(tr("empty.contactsTitle"));
    await act(async () => resolve([]));
    await waitFor(() =>
      expect(r.allText()).toContain(tr("empty.contactsTitle")),
    );
    r.press(tr("contacts.add"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/add-contact");
  });

  it("头像取名字的第一个字（生僻字 / 表情不切成半个）；关系跟在名字后面", async () => {
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve([
        contact("1", "妈妈", "母亲"),
        contact("2", "𠮷野"),
        contact("3", "😀小王"),
      ]),
    );
    const r = mount(<ContactsScreen />);
    await waitFor(() => expect(r.allText()).toContain("妈妈"));
    const texts = r.texts();
    expect(texts).toContain("妈");
    expect(texts).toContain("𠮷");
    expect(texts).toContain("😀");
    expect(texts).toContain("妈妈  母亲");
    expect(texts).toContain("13800000001");
  });

  it("满 5 个：添加按钮禁用并说明上限", async () => {
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve(
        ["1", "2", "3", "4", "5"].map((i) => contact(i, `人${i}`)),
      ),
    );
    const r = mount(<ContactsScreen />);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("contacts.full", { max: 5 })),
    );
    const btn = r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityState?.busy !== undefined,
    );
    expect(btn.props.accessibilityState.disabled).toBe(true);
  });

  it("删除要确认；确认后删掉并刷新列表；删失败弹提示", async () => {
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve([contact("1", "妈妈")]),
    );
    m(contactsApi.remove).mockImplementationOnce(() => Promise.resolve());
    const r = mount(<ContactsScreen />);
    await waitFor(() => expect(r.allText()).toContain("妈妈"));
    const del = r.root.find(
      (n) =>
        n.type === Tappable &&
        n.props.accessibilityLabel === tr("common.delete"),
    );
    act(() => del.props.onPress());
    const [title, body, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { style: string; onPress?: () => Promise<void> }[],
    ];
    expect(title).toBe(translate("contacts.deleteTitle"));
    expect(body).toBe(translate("contacts.deleteBody", { name: "妈妈" }));
    await act(async () => {
      await buttons[1].onPress!();
    });
    expect(contactsApi.remove).toHaveBeenCalledWith("1");
    expect(m(contactsApi.list).mock.calls.length).toBeGreaterThanOrEqual(2);
    m(contactsApi.remove).mockImplementationOnce(() =>
      Promise.reject(new ApiRequestError(500, { code: "INTERNAL_ERROR" })),
    );
    act(() => del.props.onPress());
    const again = alert.mock.calls[1][2] as { onPress?: () => Promise<void> }[];
    await act(async () => {
      await again[1].onPress!();
    });
    expect(alert).toHaveBeenLastCalledWith(
      translate("common.failed"),
      translate("error.internal"),
      NOTICE_OK,
    );
  });

  it("分享联系人说明：带上名字；分享被取消也不抛", async () => {
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve([contact("1", "妈妈")]),
    );
    const share = jest
      .spyOn(Share, "share")
      .mockImplementation(() => Promise.reject(new Error("dismissed")));
    const r = mount(<ContactsScreen />);
    await waitFor(() => expect(r.allText()).toContain("妈妈"));
    const btn = r.root.find(
      (n) =>
        n.type === Tappable &&
        n.props.accessibilityLabel === tr("contacts.tell"),
    );
    await act(async () => btn.props.onPress());
    expect(share).toHaveBeenCalledWith({
      message: tr("contacts.tellMessage", { name: "妈妈" }),
    });
    share.mockRestore();
  });

  it("拉列表失败：危险色说明原因", async () => {
    m(contactsApi.list).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = mount(<ContactsScreen />);
    await waitFor(() => expect(r.allText()).toContain(tr("error.network")));
    const err = r.root
      .findAllByType(Text)
      .find((t) => t.props.children === tr("error.network"));
    expect(flat(err!.props.style).color).toBe(dark.danger);
  });
});

// 拉失败原来也显示「尚未添加紧急联系人」、添加照样可点：用户以为丢了又加一遍，联系人重复（10-17 评审）
describe("紧急联系人列表没拿到", () => {
  const addButton = (r: Rendered) =>
    r.root.find(
      (n) =>
        typeof n.type === "string" &&
        n.props.accessibilityState?.busy !== undefined &&
        n.findAll((c) => c.props.children === tr("contacts.add")).length > 0,
    );

  it("拉失败：不说「尚未添加」，说没拿到并给重试；添加按钮不可点；重试拿到了就恢复", async () => {
    m(contactsApi.list).mockImplementationOnce(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = mount(<ContactsScreen />);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("contacts.loadFailed")),
    );
    expect(r.allText()).not.toContain(tr("empty.contactsTitle"));
    expect(r.allText()).toContain(tr("contacts.loadFailedBody"));
    expect(addButton(r).props.accessibilityState.disabled).toBe(true);
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve([contact("1", "妈妈")]),
    );
    r.press(tr("contacts.retry"));
    await waitFor(() => expect(r.allText()).toContain("妈妈"));
    expect(r.allText()).not.toContain(tr("contacts.loadFailed"));
    expect(addButton(r).props.accessibilityState.disabled).toBe(false);
  });

  it("还在拉：既不显示空态也不显示失败，添加按钮先不可点", () => {
    m(contactsApi.list).mockImplementation(() => new Promise(() => undefined));
    const r = mount(<ContactsScreen />);
    expect(r.allText()).not.toContain(tr("empty.contactsTitle"));
    expect(r.allText()).not.toContain(tr("contacts.loadFailed"));
    expect(addButton(r).props.accessibilityState.disabled).toBe(true);
  });

  it("删除时会话已失效（正被送回登录页）：不弹失败提示", async () => {
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve([contact("1", "妈妈")]),
    );
    m(contactsApi.remove).mockImplementationOnce(() =>
      Promise.reject(new SessionEndedError()),
    );
    const r = mount(<ContactsScreen />);
    await waitFor(() => expect(r.allText()).toContain("妈妈"));
    const del = r.root.find(
      (n) =>
        n.type === Tappable &&
        n.props.accessibilityLabel === tr("common.delete"),
    );
    act(() => del.props.onPress());
    const buttons = alert.mock.calls[0][2] as {
      onPress?: () => Promise<void>;
    }[];
    await act(async () => {
      await buttons[1].onPress!();
    });
    expect(alert).toHaveBeenCalledTimes(1); // 只有那个删除确认框
  });
});

describe("添加紧急联系人", () => {
  const P = {
    name: tr("contacts.namePlaceholder"),
    phone: tr("contacts.phonePlaceholder"),
    rel: tr("contacts.relationPlaceholder"),
  };
  const errors = (r: Rendered) =>
    r.root
      .findAllByType(Text)
      .filter((t) => flat(t.props.style).color === dark.danger)
      .map((t) => t.props.children);

  it("姓名和号码必填；号码规整后仍不合法就拦下", () => {
    const r = mount(<AddContactScreen />);
    r.press(tr("common.save"));
    expect(errors(r)).toEqual([tr("contacts.required")]);
    r.type(P.name, "妈妈");
    r.type(P.phone, "12345");
    r.press(tr("common.save"));
    expect(errors(r)).toEqual([tr("contacts.invalidPhone")]);
    expect(contactsApi.create).not.toHaveBeenCalled();
  });

  it("+86 / 空格 / 横线规整成 11 位；关系空着不带；保存后刷新列表，画完勾返回", async () => {
    jest.useFakeTimers();
    m(contactsApi.create).mockImplementation(() => Promise.resolve({}));
    const qc = makeQueryClient();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    const r = mount(<AddContactScreen />, qc);
    r.type(P.name, "  妈妈 ");
    r.type(P.phone, "+86 138-0000-0001");
    r.press(tr("common.save"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(contactsApi.create).toHaveBeenCalledWith({
      name: "妈妈",
      phone: "13800000001",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["contacts"] });
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it("号码已经是联系人了（规整后相同）：页面级说明，不提交", () => {
    const qc = makeQueryClient();
    qc.setQueryData(["contacts"], [contact("1", "妈妈")]);
    const r = mount(<AddContactScreen />, qc);
    r.type(P.name, "妈");
    r.type(P.phone, "+86 138 0000 0001");
    r.press(tr("common.save"));
    expect(errors(r)).toEqual([tr("contacts.duplicatePhone")]);
    expect(contactsApi.create).not.toHaveBeenCalled();
  });

  it("填的是自己的手机号：先弹窗问清楚（求救短信会发到自己手机上）；取消什么都不做，坚持添加才保存", async () => {
    m(contactsApi.create).mockImplementation(() => Promise.resolve({}));
    act(() =>
      useAuthStore.setState({ user: { phone: "13900000042" } } as never),
    );
    try {
      const r = mount(<AddContactScreen />);
      r.type(P.name, "我");
      r.type(P.phone, "139 0000 0042");
      r.press(tr("common.save"));
      expect(alert).toHaveBeenCalledTimes(1);
      const [title, body, buttons] = alert.mock.calls[0] as [
        string,
        string,
        { text: string; style?: string; onPress?: () => void }[],
      ];
      expect([title, body]).toEqual([
        tr("contacts.selfPhoneTitle"),
        tr("contacts.selfPhoneBody"),
      ]);
      expect(buttons.map((b) => b.text)).toEqual([
        tr("common.cancel"),
        tr("contacts.selfPhoneConfirm"),
      ]);
      expect(buttons[0].style).toBe("cancel");
      expect(contactsApi.create).not.toHaveBeenCalled();
      await act(async () => {
        buttons[1].onPress!();
      });
      expect(contactsApi.create).toHaveBeenCalledWith({
        name: "我",
        phone: "13900000042",
      });
    } finally {
      act(() => useAuthStore.setState({ user: null } as never));
    }
  });

  it("带关系一起提交；服务端拒绝时页面级说明", async () => {
    m(contactsApi.create).mockImplementation(() =>
      Promise.reject(new ApiRequestError(400, { code: "VALIDATION_FAILED" })),
    );
    const r = mount(<AddContactScreen />);
    r.type(P.name, "爸爸");
    r.type(P.phone, "13800000002");
    r.type(P.rel, " 父亲 ");
    r.press(tr("common.save"));
    await waitFor(() =>
      expect(errors(r)).toEqual([tr("error.validationFailed")]),
    );
    expect(contactsApi.create).toHaveBeenCalledWith({
      name: "爸爸",
      phone: "13800000002",
      relation: "父亲",
    });
  });
});

describe("安全设置", () => {
  const original = Platform.OS;
  beforeEach(() => {
    mockSafety.notify = null;
    mockSafety.reminder = { enabled: true, setEnabled: jest.fn() };
    mockSafety.steps = [];
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([{ deviceId: "h1" }]),
    );
  });
  afterEach(() => {
    Object.defineProperty(Platform, "OS", {
      value: original,
      configurable: true,
    });
  });

  it("联系人数：没拿到写待确认、0 个写没有、有就写几个 / 上限", async () => {
    m(contactsApi.list).mockImplementation(() => new Promise(() => undefined));
    let r = mount(<SafetySettingsScreen />);
    expect(r.allText()).toContain(tr("safetySettings.contactsUnknown"));
    m(contactsApi.list).mockImplementation(() => Promise.resolve([]));
    r = mount(<SafetySettingsScreen />);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("safety.contactsNone")),
    );
    m(contactsApi.list).mockImplementation(() =>
      Promise.resolve([contact("1", "a"), contact("2", "b")]),
    );
    r = mount(<SafetySettingsScreen />);
    await waitFor(() =>
      expect(r.allText()).toContain(
        tr("safety.contactsCaption", { n: 2, max: 5 }),
      ),
    );
    r.press(tr("nav.contacts"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/contacts");
  });

  it("通知权限：没查到写未知、拒绝换图标；点了去系统设置", () => {
    m(contactsApi.list).mockImplementation(() => new Promise(() => undefined));
    let r = mount(<SafetySettingsScreen />);
    expect(r.allText()).toContain(tr("safetySettings.notify.unknown"));
    mockSafety.notify = "denied";
    r = mount(<SafetySettingsScreen />);
    expect(r.allText()).toContain(tr("safetySettings.notify.denied"));
    expect(r.icons()).toContain("notifications-off-outline");
    r.press(tr("safetySettings.notify"));
    expect(mockOpenSettings).toHaveBeenCalled();
  });

  it("Android 省电白名单：没加入时可点去设置、加入了只显示状态；Android 多一句锁定最近任务", () => {
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    m(contactsApi.list).mockImplementation(() => new Promise(() => undefined));
    const action = jest.fn();
    mockSafety.steps = [{ key: "whitelist", done: false, action }];
    let r = mount(<SafetySettingsScreen />);
    expect(r.allText()).toContain(tr("device.batteryOpt.limited"));
    expect(r.allText()).toContain(tr("keepalive.androidTip"));
    r.press(tr("device.batteryOpt"));
    expect(action).toHaveBeenCalled();
    mockSafety.steps = [{ key: "whitelist", done: true, action }];
    r = mount(<SafetySettingsScreen />);
    expect(r.allText()).toContain(tr("device.batteryOpt.ok"));
    expect(r.icons()).toContain("battery-charging-outline");
  });

  it("只有一顶头盔不显示更换提醒开关；两顶以上显示，拨动转给设置；读到之前按开着显示且不能拨", async () => {
    m(contactsApi.list).mockImplementation(() => new Promise(() => undefined));
    let r = mount(<SafetySettingsScreen />);
    await waitFor(() => expect(devicesApi.list).toHaveBeenCalled());
    expect(r.root.findAllByType(Switch)).toHaveLength(0);
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([{ deviceId: "h1" }, { deviceId: "h2" }]),
    );
    r = mount(<SafetySettingsScreen />);
    await waitFor(() => expect(r.root.findAllByType(Switch)).toHaveLength(1));
    const sw = r.root.findByType(Switch);
    expect(sw.props.value).toBe(true);
    act(() => sw.props.onValueChange(false));
    expect(mockSafety.reminder.setEnabled).toHaveBeenCalledWith(false);
    mockSafety.reminder = { enabled: null, setEnabled: jest.fn() };
    r = mount(<SafetySettingsScreen />);
    await waitFor(() => expect(r.root.findAllByType(Switch)).toHaveLength(1));
    expect(r.root.findByType(Switch).props.disabled).toBe(true);
    expect(r.root.findByType(Switch).props.value).toBe(true);
  });

  it("演练入口打开演练", () => {
    m(contactsApi.list).mockImplementation(() => new Promise(() => undefined));
    const r = mount(<SafetySettingsScreen />);
    r.press(tr("safetySettings.drill"));
    expect(mockSafety.drillOpen).toHaveBeenCalled();
  });
});

describe("关于这顶头盔", () => {
  beforeEach(() => {
    routerState.params = { deviceId: "h1" };
    m(devicesApi.detail).mockImplementation(() =>
      Promise.resolve({ name: "通勤", bindCode: "AB12CD34" }),
    );
  });
  afterEach(() => {
    act(() => useBleStore.setState({ links: {} }));
  });

  it("在线：信号、工作中、最后上报时间；固件取服务端的", async () => {
    m(devicesApi.status).mockImplementation(() =>
      Promise.resolve({
        online: true,
        signalLevel: 4,
        sleeping: false,
        firmwareVersion: "1.2.0",
        lastSeenAt: "2026-10-16T01:02:00.000Z",
      }),
    );
    const r = mount(<DeviceAboutScreen />);
    await waitFor(() => expect(r.allText()).toContain(tr("device.active")));
    expect(r.texts()).toContain("1.2.0");
    expect(r.texts()).toContain("4");
    expect(r.texts()).toContain("h1");
  });

  it("离线：信号写上次的值、工作状态写待确认；睡眠中写休眠；没上报过写从未上报 / 未上报", async () => {
    m(devicesApi.status).mockImplementation(() =>
      Promise.resolve({
        online: false,
        signalLevel: 2,
        sleeping: false,
        firmwareVersion: null,
        lastSeenAt: null,
      }),
    );
    useBleStore.setState({
      links: {
        h1: {
          phase: "connected",
          eventsReceived: 0,
          resent: 0,
          firmwareVersion: "0.9.1",
        },
      },
    });
    let r = mount(<DeviceAboutScreen />);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("device.about.unconfirmed")),
    );
    expect(r.allText()).toContain(tr("device.about.lastValue", { value: 2 }));
    expect(r.allText()).toContain(tr("device.neverReported"));
    // 服务端没有固件版本：用本机蓝牙握手读到的
    expect(r.texts()).toContain("0.9.1");
    m(devicesApi.status).mockImplementation(() =>
      Promise.resolve({
        online: true,
        signalLevel: null,
        sleeping: true,
        firmwareVersion: null,
        lastSeenAt: null,
      }),
    );
    act(() => useBleStore.setState({ links: {} }));
    r = mount(<DeviceAboutScreen />);
    await waitFor(() => expect(r.allText()).toContain(tr("device.sleeping")));
    expect(r.allText()).toContain(tr("device.notReported"));
    expect(r.allText()).toContain(tr("common.unknown"));
  });

  it("状态拉不到：危险色说明，状态那三行不显示", async () => {
    m(devicesApi.status).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const r = mount(<DeviceAboutScreen />);
    await waitFor(() => expect(r.allText()).toContain(tr("error.network")));
    expect(r.allText()).not.toContain(tr("device.signal"));
  });

  it("绑定码默认打码；点开显示 10 秒后自动收起；手动收起再点开重新计时", async () => {
    jest.useFakeTimers();
    m(devicesApi.status).mockImplementation(() => new Promise(() => undefined));
    const r = mount(<DeviceAboutScreen />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(r.texts()).toContain("••••••••");
    const eye = () =>
      r.root.find(
        (n) =>
          n.type === Tappable &&
          String(n.props.accessibilityLabel).length > 0 &&
          n.props.feedback === "opacity" &&
          n.props.accessibilityRole === "button",
      );
    act(() => eye().props.onPress());
    await act(async () => {
      await Promise.resolve();
    });
    expect(r.texts()).toContain("AB12CD34");
    act(() => {
      jest.advanceTimersByTime(6000);
    });
    // 手动收起，再点开：上一次的计时器不能在 4 秒后把它收掉
    act(() => eye().props.onPress());
    expect(r.texts()).toContain("••••••••");
    act(() => eye().props.onPress());
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(r.texts()).toContain("AB12CD34");
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(r.texts()).toContain("••••••••");
  });

  it("还没拿到绑定码（详情里没有）：点开显示一横", async () => {
    m(devicesApi.status).mockImplementation(() => new Promise(() => undefined));
    m(devicesApi.detail).mockImplementation(() =>
      Promise.resolve({ name: "通勤", bindCode: null }),
    );
    const r = mount(<DeviceAboutScreen />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("device.about.showBindCode"),
        )
        .props.onPress(),
    );
    expect(r.texts()).toContain("—");
    expect(r.texts()).not.toContain("••••••••");
  });

  it("绑定码显示着就离开了页面：那个 10 秒后收起的计时器跟着撤掉", async () => {
    jest.useFakeTimers();
    m(devicesApi.status).mockImplementation(() => new Promise(() => undefined));
    const r = mount(<DeviceAboutScreen />);
    await act(async () => {
      await Promise.resolve();
    });
    const set = jest.spyOn(globalThis, "setTimeout");
    act(() =>
      r.root
        .find(
          (n) =>
            n.type === Tappable &&
            n.props.accessibilityLabel === tr("device.about.showBindCode"),
        )
        .props.onPress(),
    );
    const at = set.mock.calls.findIndex((c) => c[1] === 10_000);
    const timer = set.mock.results[at].value;
    set.mockRestore();
    const clear = jest.spyOn(globalThis, "clearTimeout");
    r.unmount();
    expect(clear).toHaveBeenCalledWith(timer);
    clear.mockRestore();
  });

  it("蓝牙工程模式入口带上设备号", () => {
    m(devicesApi.status).mockImplementation(() => new Promise(() => undefined));
    const r = mount(<DeviceAboutScreen />);
    r.press(tr("device.bleBench"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/ble-bench?deviceId=h1");
  });
});

describe("求救记录详情", () => {
  const detail = (over: Partial<AccidentDetail> = {}): AccidentDetail => ({
    sosId: "s1",
    deviceId: "h1",
    triggerEventId: "e1",
    triggerType: "possible_fall",
    status: "notified",
    deadline: "2026-10-16T01:01:00.000Z",
    createdAt: "2026-10-16T01:00:00.000Z",
    updatedAt: "2026-10-16T01:01:00.000Z",
    location: {
      latitude: 22.54321,
      longitude: 113.93456,
      source: "event",
    } as never,
    triggerPayload: null,
    notifications: [],
    ...over,
  });
  beforeEach(() => {
    routerState.params = { accidentId: "s1" };
    m(devicesApi.list).mockImplementation(() =>
      Promise.resolve([{ deviceId: "h1", name: "通勤头盔" }]),
    );
  });

  it("记录不存在（404）：空态 + 返回；栈里没有上一页就回首页", async () => {
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.reject(new ApiRequestError(404, { code: "NOT_FOUND" })),
    );
    const r = mount(<AccidentDetailScreen />);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.gone.title")),
    );
    // 404 不重试
    expect(sosApi.accidentDetail).toHaveBeenCalledTimes(1);
    r.press(tr("nav.back"));
    expect(mockRouter.back).toHaveBeenCalled();
    mockRouter.canGoBack.mockReturnValueOnce(false);
    r.press(tr("nav.back"));
    expect(mockRouter.navigate).toHaveBeenCalledWith("/");
  });

  it("其它错误：只写一行原因（重试一次之后）", async () => {
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.reject(new ApiRequestError(500, { code: "INTERNAL_ERROR" })),
    );
    jest.useFakeTimers();
    const r = mount(<AccidentDetailScreen />);
    // 第一次失败后按 react-query 的退避等约 1 秒重试一次，再失败才报错
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(r.allText()).toContain(tr("error.internal"));
    expect(m(sosApi.accidentDetail).mock.calls.length).toBe(2);
  });

  it("已通知的摔倒：标题、状态、来源头盔带名字、位置（事件内嵌）、小地图落点和导航", async () => {
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve(
        detail({
          triggeredAt: "2026-10-16T00:59:00.000Z",
          notifications: [
            {
              id: "n1",
              channel: "sms",
              target: "138****0001",
              contactName: "妈妈",
              status: "sent",
              attempts: 1,
              lastError: null,
              sentAt: "2026-10-16T01:01:05.000Z",
              createdAt: "x",
            },
            {
              id: "n2",
              channel: "push",
              target: "u2",
              contactName: null,
              status: "failed",
              attempts: 3,
              lastError: "x",
              sentAt: null,
              createdAt: "x",
            },
            {
              id: "n3",
              channel: "sms",
              target: "139****0002",
              contactName: "爸爸",
              status: "pending",
              attempts: 0,
              lastError: null,
              sentAt: null,
              createdAt: "x",
            },
          ],
        }),
      ),
    );
    const r = mount(<AccidentDetailScreen />);
    await waitFor(() => expect(r.allText()).toContain("通勤头盔 · h1"));
    const text = r.allText();
    expect(text).toContain(tr("records.sos.fall"));
    expect(text).toContain(tr("safety.status.notified"));
    expect(text).toContain(tr("accident.helmetTriggeredAt"));
    expect(text).toContain(
      `22.54321, 113.93456 (${tr("accident.locationSource.event")})`,
    );
    expect(text).toContain(`妈妈 · 138****0001`);
    expect(text).toContain(`${tr("accident.contact")} · u2`);
    expect(text).toContain(tr("accident.notif.sent"));
    expect(text).toContain(tr("accident.notif.failed"));
    expect(text).toContain(tr("accident.notif.sending"));
    expect(r.icons()).toEqual(
      expect.arrayContaining(["chatbubble-outline", "notifications-outline"]),
    );
    expect(mockMap.setHelmet).toHaveBeenCalled();
    act(() =>
      (r.root.find((n) => isHost(n, "AmapView")).props.onReady as () => void)(),
    );
    r.press(tr("accident.navigate"));
    expect(mockNavTo).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: expect.any(Number) }),
      tr("accident.site"),
    );
    // 进行中才有回倒计时页的按钮
    expect(text).not.toContain(tr("accident.openCountdown"));
  });

  it("进行中的手动求救：危险色状态 + 回倒计时页；(0,0) 占位位置不当成地点；没通知写还没通知", async () => {
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve(
        detail({
          triggerType: "manual_sos",
          status: "pending",
          location: {
            latitude: 0,
            longitude: 0,
            source: "last_point",
          } as never,
        }),
      ),
    );
    m(devicesApi.list).mockImplementation(() => Promise.resolve([]));
    const r = mount(<AccidentDetailScreen />);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("records.sos.manual")),
    );
    const text = r.allText();
    expect(text).toContain(tr("safety.status.pending"));
    expect(text).toContain(tr("accident.noLocation"));
    expect(text).toContain(tr("accident.notNotified"));
    expect(r.root.findAll((n) => isHost(n, "AmapView"))).toHaveLength(0);
    // 解绑后查不到名字：只写设备号
    expect(r.texts()).toContain("h1");
    r.press(tr("accident.openCountdown"));
    expect(mockRouter.navigate).toHaveBeenCalledWith(
      "/sos-active?sosId=s1&deviceId=h1",
    );
  });

  it("已取消：中性色状态；轨迹回落的位置写来源", async () => {
    m(sosApi.accidentDetail).mockImplementation(() =>
      Promise.resolve(
        detail({
          status: "cancelled",
          location: {
            latitude: 22.5,
            longitude: 113.9,
            source: "last_point",
          } as never,
        }),
      ),
    );
    const r = mount(<AccidentDetailScreen />);
    await waitFor(() =>
      expect(r.allText()).toContain(tr("safety.status.cancelled")),
    );
    expect(r.allText()).toContain(tr("accident.locationSource.track"));
  });
});
