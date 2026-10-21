// 「我的」标签页：账号卡（昵称 / 头像字 / 手机号 / 设备数）、各入口、语言与外观选择、清缓存、退出登录、
// 编辑资料（选头像压缩成 data-URI、保存成功画完勾才关、失败弹窗）。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClientProvider } from "@tanstack/react-query";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { Alert, Modal } from "react-native";
import { act } from "react-test-renderer";
import { mockRouter } from "@/__tests__/helpers/native-mocks";
import {
  isHost,
  makeQueryClient,
  render,
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { authApi } from "@/api/auth";
import { ApiRequestError } from "@/api/client";
import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { Tappable } from "@/components/tappable";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";
import ProfileScreen from "@/app/(tabs)/profile";

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
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-image", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  const Image = Object.assign(
    (props: Record<string, unknown>) => h("ExpoImage", props),
    {
      clearDiskCache: jest.fn(() => Promise.resolve(true)),
      clearMemoryCache: jest.fn(() => Promise.resolve(true)),
    },
  );
  return { Image };
});
const mockManip = { base64: "QUJD" as string | undefined, resize: jest.fn() };
jest.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  ImageManipulator: {
    manipulate: () => ({
      resize: (o: unknown) => mockManip.resize(o),
      renderAsync: async () => ({
        saveAsync: async () => ({ base64: mockManip.base64 }),
      }),
    }),
  },
}));
jest.mock("expo-image-picker", () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock("@/api/auth", () => ({
  ...jest.requireActual<typeof import("@/api/auth")>("@/api/auth"),
  authApi: { updateMe: jest.fn() },
}));
jest.mock("@/api/contacts", () => ({ contactsApi: { list: jest.fn() } }));
jest.mock("@/api/devices", () => ({ devicesApi: { list: jest.fn() } }));
const mockDrain = jest.fn((_ms: number) =>
  Promise.resolve({ total: 0, sos: 0 }),
);
jest.mock("@/services/ble-relay-uplink", () => ({
  ...jest.requireActual<typeof import("@/services/ble-relay-uplink")>(
    "@/services/ble-relay-uplink",
  ),
  drainRelayQueue: (ms: number) => mockDrain(ms),
}));

/** 只有一个按钮的提示统一走 services/notice 的 showNotice：第三个参数是一个「确定」 */
const NOTICE_OK = [{ text: translate("common.confirm", undefined, "zh-CN") }];
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const mount = (qc = makeQueryClient()) =>
  render(
    <QueryClientProvider client={qc}>
      <ProfileScreen />
    </QueryClientProvider>,
  );
/** 账号卡（最外层那个整卡可点的） */
const accountCard = (r: Rendered) =>
  r.root.findAll((n) => n.type === Tappable && n.props.feedback === "scale")[0];
const modals = (r: Rendered) =>
  r.root.findAllByType(Modal).map((x) => x.props.visible);

let alert: ReturnType<typeof jest.spyOn>;
let setUser: jest.Mock;
let signOut: jest.Mock;
let setLocale: jest.Mock;
beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  setLocale = jest.fn(() => Promise.resolve());
  useLocaleStore.setState({ locale: "zh-CN", setLocale } as never);
  setUser = jest.fn(() => Promise.resolve());
  signOut = jest.fn(() => Promise.resolve());
  useAuthStore.setState({
    user: { id: "u1", phone: "13900000042", nickname: "小李", avatarUrl: null },
    setUser,
    signOut,
  } as never);
  m(devicesApi.list).mockImplementation(() =>
    Promise.resolve([{ deviceId: "h1" }, { deviceId: "h2" }]),
  );
  m(contactsApi.list).mockImplementation(() => Promise.resolve([{ id: "c1" }]));
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
});
afterEach(() => {
  alert.mockRestore();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("账号卡", () => {
  it("昵称、头像上的首字、手机号和设备数；联系人数写在入口右边", async () => {
    const r = mount();
    await waitFor(() =>
      expect(r.allText()).toContain(tr("profile.devicesCount", { n: 2 })),
    );
    expect(r.texts()).toContain("小李");
    expect(r.texts()).toContain("小");
    expect(r.allText()).toContain("13900000042");
    // 手机号和设备数是两段文字（放不下时设备数整段换行，不在「2 台设 / 备」中间断开）
    expect(r.texts()).toContain("13900000042 · ");
    expect(r.texts()).toContain(tr("profile.devicesCount", { n: 2 }));
    expect(r.allText()).toContain(tr("profile.contactsValue", { n: 1 }));
  });

  it("没有昵称：提示设置，头像用手机号首位；有头像图就显示图", async () => {
    act(() =>
      useAuthStore.setState({
        user: {
          id: "u1",
          phone: "13900000042",
          nickname: null,
          avatarUrl: "https://x/a.jpg",
        } as never,
      }),
    );
    const r = mount();
    expect(r.texts()).toContain(tr("profile.setNickname"));
    expect(r.root.find((n) => isHost(n, "ExpoImage")).props.source).toEqual({
      uri: "https://x/a.jpg",
    });
  });

  it("昵称被清空后存成了空串 / 全空格：照样提示设置昵称，头像用手机号首位（修复前名字那行是空的）", () => {
    act(() =>
      useAuthStore.setState({
        user: {
          id: "u1",
          phone: "13900000042",
          nickname: "  ",
          avatarUrl: null,
        } as never,
      }),
    );
    const r = mount();
    expect(r.texts()).toContain(tr("profile.setNickname"));
    expect(r.texts()).toContain("1");
  });

  it("昵称以生僻字 / 表情开头：头像取整个字，不切成半个；英文首字母大写", () => {
    act(() =>
      useAuthStore.setState({
        user: {
          id: "u1",
          phone: "1",
          nickname: "𠮷田",
          avatarUrl: null,
        } as never,
      }),
    );
    let r = mount();
    expect(r.texts()).toContain("𠮷");
    act(() =>
      useAuthStore.setState({
        user: {
          id: "u1",
          phone: "1",
          nickname: "wesley",
          avatarUrl: null,
        } as never,
      }),
    );
    r = mount();
    expect(r.texts()).toContain("W");
  });

  // 拉失败写「0 人」会让人以为联系人被清掉了，回头又重复添加（10-17 评审）
  it("联系人列表还没拿到 / 拉失败：入口右边写一横，不写 0 人；拿到空列表才写 0 人", async () => {
    m(contactsApi.list).mockImplementation(() =>
      Promise.reject(new TypeError("Network request failed")),
    );
    const qc = makeQueryClient();
    const r = mount(qc);
    await waitFor(() =>
      expect(qc.getQueryState(["contacts"])?.status).toBe("error"),
    );
    expect(r.allText()).not.toContain(tr("profile.contactsValue", { n: 0 }));
    const row = r.root.findAll(
      (n) =>
        typeof n.type !== "string" &&
        n.props.title === tr("profile.contacts") &&
        "value" in n.props,
    )[0];
    expect(row.props.value).toBe("—");

    m(contactsApi.list).mockImplementation(() => Promise.resolve([]));
    const empty = mount();
    await waitFor(() =>
      expect(empty.allText()).toContain(tr("profile.contactsValue", { n: 0 })),
    );
  });

  it("没有用户档案：一横和问号", () => {
    act(() => useAuthStore.setState({ user: null }));
    const r = mount();
    expect(r.texts()).toContain("?");
    expect(r.allText()).toContain("—");
  });
});

describe("入口", () => {
  it("联系人 / 安全记录 / 账号与安全 / 帮助与关于各跳各的", () => {
    const r = mount();
    r.press(tr("profile.contacts"));
    r.press(tr("profile.records"));
    r.press(tr("profile.groupAccount"));
    r.press(tr("profile.groupHelp"));
    expect(mockRouter.navigate.mock.calls.map((c) => c[0])).toEqual([
      "/contacts",
      "/safety-records",
      "/account",
      "/about",
    ]);
  });

  it("语言：当前语言打勾；选了就切换并关掉", () => {
    const r = mount();
    r.press(tr("profile.language"));
    expect(modals(r)).toContain(true);
    const rows = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        n.props.accessibilityState?.selected !== undefined &&
        n.props.feedback === "fill",
    );
    expect(
      rows.map((x) => x.props.accessibilityState.selected).filter(Boolean),
    ).toHaveLength(1);
    r.press("English");
    expect(setLocale).toHaveBeenCalledWith("en");
    expect(modals(r).every((v) => v === false)).toBe(true);
  });

  it("外观：当前写深色；选浅色就切过去", () => {
    const r = mount();
    expect(r.allText()).toContain(tr("profile.appearance.dark"));
    r.press(tr("profile.appearance"));
    r.press(tr("profile.appearance.light"));
    expect(useThemeStore.getState().mode).toBe("light");
  });

  it("清缓存：确认后清掉查询缓存和图片缓存并提示", () => {
    const qc = makeQueryClient();
    const clear = jest.spyOn(qc, "clear");
    const r = mount(qc);
    r.press(tr("profile.clearCache"));
    const buttons = alert.mock.calls[0][2] as { onPress?: () => void }[];
    act(() => buttons[1].onPress!());
    expect(clear).toHaveBeenCalled();
    expect(Image.clearDiskCache).toHaveBeenCalled();
    expect(Image.clearMemoryCache).toHaveBeenCalled();
  });

  it("退出登录要确认，确认那一项是危险样式；手机里没有积压就直接退出", async () => {
    mockDrain.mockImplementation(() => Promise.resolve({ total: 0, sos: 0 }));
    const r = mount();
    r.press(tr("profile.signOut"));
    const buttons = alert.mock.calls[0][2] as {
      style?: string;
      onPress?: () => void;
    }[];
    expect(buttons[1].style).toBe("destructive");
    await act(async () => buttons[1].onPress!());
    expect(mockDrain).toHaveBeenCalledWith(5_000);
    expect(signOut).toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("还有没传上去的头盔事件（含摔倒）：先显示「正在上传」，送不完再问一次，说明后果；取消就不退，仍要退出才退（O21）", async () => {
    let finish!: (v: { total: number; sos: number }) => void;
    mockDrain.mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const r = mount();
    r.press(tr("profile.signOut"));
    const first = alert.mock.calls[0][2] as { onPress?: () => void }[];
    act(() => first[1].onPress!());
    expect(r.allText()).toContain(tr("profile.signOutUploading"));
    await act(async () => finish({ total: 3, sos: 1 }));
    expect(signOut).not.toHaveBeenCalled();
    expect(alert.mock.calls[1][0]).toBe(
      tr("profile.signOutPendingTitle", { n: 3 }),
    );
    expect(alert.mock.calls[1][1]).toBe(
      tr("profile.signOutPendingBodySos", { n: 1 }),
    );
    expect(r.allText()).toContain(tr("profile.signOut"));
    const second = alert.mock.calls[1][2] as {
      text: string;
      style?: string;
      onPress?: () => void;
    }[];
    expect(second[0].style).toBe("cancel");
    expect(second[1].text).toBe(tr("profile.signOutAnyway"));
    act(() => second[1].onPress!());
    expect(signOut).toHaveBeenCalled();
  });

  it("积压里没有摔倒：说明只写什么时候补传", async () => {
    mockDrain.mockImplementation(() => Promise.resolve({ total: 2, sos: 0 }));
    const r = mount();
    r.press(tr("profile.signOut"));
    const first = alert.mock.calls[0][2] as { onPress?: () => void }[];
    await act(async () => first[1].onPress!());
    expect(alert.mock.calls[1][1]).toBe(tr("profile.signOutPendingBody"));
  });
});

describe("编辑资料", () => {
  const nickBox = tr("profile.nicknamePlaceholder");

  it("点账号卡打开，草稿带上现在的昵称；改了昵称保存：去空格，没换头像不带头像", async () => {
    jest.useFakeTimers();
    const updated = {
      id: "u1",
      phone: "13900000042",
      nickname: "老李",
      avatarUrl: null,
    };
    m(authApi.updateMe).mockImplementation(() => Promise.resolve(updated));
    const r = mount();
    act(() => accountCard(r).props.onPress());
    expect(r.valueOf(nickBox)).toBe("小李");
    r.type(nickBox, "  老李 ");
    r.press(tr("common.save"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authApi.updateMe).toHaveBeenCalledWith({ nickname: "老李" });
    expect(setUser).toHaveBeenCalledWith(updated);
    // 画完勾才关弹层
    expect(modals(r)[0]).toBe(true);
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(modals(r)[0]).toBe(false);
  });

  it("选头像：方形裁剪、压到 256 宽、存成 data-URI 一起提交", async () => {
    m(ImagePicker.launchImageLibraryAsync).mockImplementation(() =>
      Promise.resolve({ assets: [{ uri: "file:///a.png" }] }),
    );
    m(authApi.updateMe).mockImplementation(() => Promise.resolve({}));
    const r = mount();
    act(() => accountCard(r).props.onPress());
    await act(async () => {
      r.press(tr("profile.changeAvatar"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsEditing: true, aspect: [1, 1] }),
    );
    expect(mockManip.resize).toHaveBeenCalledWith({ width: 256 });
    await waitFor(() =>
      expect(
        r.root
          .findAll((n) => isHost(n, "ExpoImage"))
          .some(
            (n) =>
              (n.props.source as { uri: string }).uri ===
              "data:image/jpeg;base64,QUJD",
          ),
      ).toBe(true),
    );
    r.press(tr("common.save"));
    // 只发改过的字段：只换了头像就不带昵称（本机存的昵称可能是旧的，带上会盖掉别处的修改）
    await waitFor(() =>
      expect(authApi.updateMe).toHaveBeenCalledWith({
        avatarUrl: "data:image/jpeg;base64,QUJD",
      }),
    );
  });

  it("取消选图不改；压缩没给出 base64 也不改；选图出错弹窗说明（固定文案，不露原生层的英文报错）", async () => {
    const r = mount();
    act(() => accountCard(r).props.onPress());
    m(ImagePicker.launchImageLibraryAsync).mockImplementationOnce(() =>
      Promise.resolve({ canceled: true, assets: null }),
    );
    await act(async () => {
      r.press(tr("profile.changeAvatar"));
      await Promise.resolve();
    });
    mockManip.base64 = undefined;
    m(ImagePicker.launchImageLibraryAsync).mockImplementationOnce(() =>
      Promise.resolve({ assets: [{ uri: "file:///b.png" }] }),
    );
    await act(async () => {
      r.press(tr("profile.changeAvatar"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    mockManip.base64 = "QUJD";
    expect(r.root.findAll((n) => isHost(n, "ExpoImage"))).toHaveLength(0);
    m(ImagePicker.launchImageLibraryAsync).mockImplementationOnce(() =>
      Promise.reject(new Error("no permission")),
    );
    await act(async () => {
      r.press(tr("profile.changeAvatar"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        translate("profile.pickFailed"),
        translate("profile.pickFailedBody"),
        NOTICE_OK,
      ),
    );
    expect(JSON.stringify(alert.mock.calls)).not.toContain("no permission");
  });

  it("什么都没改就保存：不发请求，照样画勾关掉弹层", async () => {
    jest.useFakeTimers();
    const r = mount();
    act(() => accountCard(r).props.onPress());
    r.press(tr("common.save"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(authApi.updateMe).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1100);
    });
    expect(modals(r)[0]).toBe(false);
  });

  it("10-17 评审：画勾途中点遮罩关掉弹层，再打开时按钮是可点的「保存」，不会自己关掉", async () => {
    jest.useFakeTimers();
    const r = mount();
    act(() => accountCard(r).props.onPress());
    r.press(tr("common.save"));
    await act(async () => {
      await Promise.resolve();
    });
    // 勾还没画完（约 1 秒）就关掉
    act(() => {
      jest.advanceTimersByTime(300);
    });
    act(() => r.root.findAllByType(Modal)[0].props.onRequestClose());
    expect(modals(r)[0]).toBe(false);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    act(() => accountCard(r).props.onPress());
    expect(modals(r)[0]).toBe(true);
    // 按钮回到平时：读屏不念「已保存」、可点
    const btn = r.root.find(
      (n) =>
        typeof n.type !== "string" &&
        n.props.accessibilityState !== undefined &&
        typeof n.props.onPressIn === "function" &&
        n.props.disabled !== undefined,
    );
    expect(btn.props.accessibilityLabel).toBeUndefined();
    expect(btn.props.disabled).toBe(false);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(modals(r)[0]).toBe(true);
  });

  it("保存失败：弹窗说明原因，弹层不关", async () => {
    m(authApi.updateMe).mockImplementation(() =>
      Promise.reject(new ApiRequestError(400, { code: "VALIDATION_FAILED" })),
    );
    const r = mount();
    act(() => accountCard(r).props.onPress());
    r.type(nickBox, "老李");
    r.press(tr("common.save"));
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        translate("profile.saveFailed"),
        translate("error.validationFailed"),
        NOTICE_OK,
      ),
    );
    expect(modals(r)[0]).toBe(true);
    expect(setUser).not.toHaveBeenCalled();
  });

  it("点遮罩 / 返回键关掉弹层；点卡片本身不关", () => {
    const r = mount();
    act(() => accountCard(r).props.onPress());
    const masks = r.root.findAll(
      (n) =>
        n.type === Tappable &&
        Array.isArray(n.props.feedback) &&
        n.props.feedback.length === 0,
    );
    // 第二个是卡片本身：点它不关
    act(() => masks[1].props.onPress());
    expect(modals(r)[0]).toBe(true);
    act(() => masks[0].props.onPress());
    expect(modals(r)[0]).toBe(false);
    act(() => accountCard(r).props.onPress());
    act(() => r.root.findAllByType(Modal)[0].props.onRequestClose());
    expect(modals(r)[0]).toBe(false);
  });
});
