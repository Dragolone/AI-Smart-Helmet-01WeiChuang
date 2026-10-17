// 对讲标签页：频道列表三态（加载中 / 拉取失败 / 没有频道 / 有频道）、新建与邀请码加入、某个频道的「更多」面板、
// 进房（先退房清场、凭证、权限钥匙、超时与失败、双端麦克风权限、作废的进房不再进房开麦）、房间里（成员网格与进房时
// 的提示音、说话指示、对我静音、读屏、按住说话、持续通话与第一次的说明、掉线与重连、被动退出、TRTC 报错、头盔断开、
// 音频输出、结束通话、切换频道、频道从列表里消失），以及离开页面退房。
// TRTC 换成记录调用的替身，监听器由测试直接发事件；提示音模块换成记录调用的替身。
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
  VoiceChannel,
  VoiceChannelMemberPublic,
  VoiceTokenResponse,
} from "@helmet/shared";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as SecureStore from "expo-secure-store";
import {
  Alert,
  Animated as RNAnimated,
  Modal,
  PermissionsAndroid,
  Platform,
  Share,
} from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { routerState } from "@/__tests__/helpers/native-mocks";
import {
  flat,
  isHost,
  makeQueryClient,
  render,
  waitFor,
  type Rendered,
} from "@/__tests__/helpers/render";
import { channelsApi } from "@/api/channels";
import { ApiRequestError, SessionEndedError } from "@/api/client";
import { toUserMessage } from "@/api/error-messages";
import { DotsLoader } from "@/components/motion";
import { showToast } from "@/components/toast";
import { Tappable } from "@/components/tappable";
import { Colors } from "@/constants/theme";
import { translate, useLocaleStore, type MessageKey } from "@/i18n";
import { playCue, prepareCues } from "@/services/intercom-cues";
import { useAuthStore } from "@/stores/auth-store";
import { useBleStore } from "@/stores/ble-store";
import { useIntercomStore } from "@/stores/intercom-store";
import { useThemeStore } from "@/stores/theme-store";
import IntercomScreen from "@/app/(tabs)/intercom";

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
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
}));
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(() => Promise.resolve()),
  deactivateKeepAwake: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-image", () => {
  const { createElement: h } =
    jest.requireActual<typeof import("react")>("react");
  return { Image: (props: Record<string, unknown>) => h("ExpoImage", props) };
});
const mockMic = {
  ask: jest.fn(() => Promise.resolve({ granted: true, status: "granted" })),
};
jest.mock("expo-audio", () => ({
  requestRecordingPermissionsAsync: () => mockMic.ask(),
}));
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
  AFTER_FIRST_UNLOCK: 0,
}));
jest.mock("@/api/channels", () => ({
  channelsApi: {
    list: jest.fn(),
    create: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
    members: jest.fn(),
    token: jest.fn(),
  },
}));
jest.mock("@/services/intercom-cues", () => ({
  playCue: jest.fn(),
  prepareCues: jest.fn(),
}));
jest.mock("@/components/toast", () => ({
  ...jest.requireActual<typeof import("@/components/toast")>(
    "@/components/toast",
  ),
  showToast: jest.fn(),
}));

/** TRTC 单例的替身：记下每个调用；registerListener 收下的监听器由测试直接喊 */
let mockListener: ((type: string, params: unknown) => void) | null = null;
const mockDeviceManager = { setAudioRoute: jest.fn(() => Promise.resolve()) };
const mockCloud = {
  registerListener: jest.fn((l: (type: string, params: unknown) => void) => {
    mockListener = l;
  }),
  unRegisterListener: jest.fn(() => {
    mockListener = null;
  }),
  exitRoom: jest.fn(() => Promise.resolve()),
  enterRoom: jest.fn((..._args: unknown[]) => Promise.resolve()),
  startLocalAudio: jest.fn((..._args: unknown[]) => Promise.resolve()),
  stopLocalAudio: jest.fn(() => Promise.resolve()),
  muteLocalAudio: jest.fn((..._args: unknown[]) => Promise.resolve()),
  enableAudioVolumeEvaluation: jest.fn((..._args: unknown[]) =>
    Promise.resolve(),
  ),
  muteRemoteAudio: jest.fn((..._args: unknown[]) => Promise.resolve()),
  getDeviceManager: () => mockDeviceManager,
};
jest.mock("trtc-react-native", () => {
  class TRTCParams {
    constructor(p: Record<string, unknown>) {
      Object.assign(this, p);
    }
  }
  const events = [
    "onEnterRoom",
    "onExitRoom",
    "onRemoteUserEnterRoom",
    "onRemoteUserLeaveRoom",
    "onUserVoiceVolume",
    "onConnectionLost",
    "onTryToReconnect",
    "onConnectionRecovery",
    "onError",
  ];
  return {
    __esModule: true,
    default: { sharedInstance: () => mockCloud },
    TRTCParams,
    TRTCCloudDef: {
      TRTC_APP_SCENE_AUDIOCALL: 2,
      TRTC_AUDIO_QUALITY_SPEECH: 1,
      TRTC_AUDIO_ROUTE_SPEAKER: 0,
      TRTC_AUDIO_ROUTE_EARPIECE: 1,
    },
    TRTCCloudListener: Object.fromEntries(events.map((e) => [e, e])),
  };
});

/** 只有一个按钮的提示统一走 services/notice 的 showNotice：第三个参数是一个「确定」 */
const NOTICE_OK = [{ text: translate("common.confirm", undefined, "zh-CN") }];
const tr = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(key, params, "zh-CN");
const m = <T,>(fn: T) => fn as unknown as jest.Mock;
const dark = Colors.dark;

const chan = (
  channelId: string,
  name: string,
  memberCount: number,
): VoiceChannel => ({
  channelId,
  name,
  roomId: channelId === "c1" ? 101 : 202,
  inviteCode: channelId === "c1" ? "AB12CD" : "ZZ9900",
  ownerId: "u1",
  memberCount,
  createdAt: "2026-10-01T00:00:00Z",
});
const C1 = chan("c1", "周末骑行队", 1);
const C2 = chan("c2", "通勤小队", 5);
const member = (
  userId: string,
  nickname: string | null,
  phone: string,
  avatarUrl: string | null = null,
): VoiceChannelMemberPublic => ({
  userId,
  nickname,
  phone,
  avatarUrl,
  joinedAt: "2026-10-01T00:00:00Z",
});
const MEMBERS = [
  member("u1", "阿麦", "13900000042"),
  member("u2", null, "13800000002", "https://cdn.example/u2.png"),
  member("u3", "", "13800000003"),
];
const TOKEN: VoiceTokenResponse = {
  sdkAppId: 1400000001,
  userId: "u1",
  roomId: 101,
  userSig: "sig-u1",
  privateMapKey: "pmk-101",
  expiresAt: "2026-10-16T03:00:00Z",
};

let qc: QueryClient;
const screen = () => (
  <QueryClientProvider client={qc}>
    <IntercomScreen />
  </QueryClientProvider>
);
const mount = () => {
  qc = makeQueryClient();
  return render(screen());
};
/** 带这个读屏名、能按的那个组件（最外层那个：Tappable 而不是它里面的 Pressable） */
const node = (r: Rendered, label: string): ReactTestInstance => {
  const hit = r.root.findAll(
    (n) =>
      typeof n.type !== "string" &&
      n.props.accessibilityLabel === label &&
      (typeof n.props.onPress === "function" ||
        typeof n.props.onPressIn === "function"),
  );
  if (!hit.length) throw new Error(`没有读屏名为「${label}」的按钮`);
  return hit[0];
};
const has = (r: Rendered, label: string) =>
  r.root.findAll(
    (n) => typeof n.type !== "string" && n.props.accessibilityLabel === label,
  ).length > 0;
const tap = async (r: Rendered, label: string) => {
  const n = node(r, label);
  await act(async () => {
    n.props.onPress({ nativeEvent: {} });
  });
};
const press = async (r: Rendered, text: string) => {
  await act(async () => {
    r.press(text);
  });
};
const fire = (type: string, params: Record<string, unknown> = {}) => {
  act(() => {
    mockListener!(type, params);
  });
};
const textOf = (n: ReactTestInstance | string): string =>
  typeof n === "string"
    ? n
    : n.children.map((c) => textOf(c as ReactTestInstance | string)).join("");
/** 房间里某个成员的格子（只有别人的格子能点；认它带的「对我静音」读屏提示） */
const cellOf = (r: Rendered, name: string) =>
  r.root
    .findAll(
      (n) =>
        n.type === Tappable &&
        [
          tr("intercom.member.muteHint"),
          tr("intercom.member.unmuteHint"),
        ].includes(n.props.accessibilityHint),
    )
    .find(
      (n) => n.findAll((c) => isHost(c, "Text") && textOf(c) === name).length,
    )!;
/** 自己的格子：不能点，但读屏能读到 */
const selfCell = (r: Rendered) =>
  r.root.find(
    (n) =>
      isHost(n, "View") &&
      n.props.accessible === true &&
      n.props.accessibilityRole === "text",
  );
const SEP = translate("common.a11ySep", undefined, "zh-CN");
/** 说话方式的两段：[按住说话, 持续通话] */
const modeSegs = (r: Rendered) =>
  r.root.findAll(
    (n) =>
      typeof n.type !== "string" &&
      n.props.accessibilityRole === "radio" &&
      typeof n.props.onPress === "function",
  );
const pttIn = async (r: Rendered) => {
  const n = node(r, tr("intercom.holdToTalk"));
  await act(async () => {
    n.props.onPressIn();
  });
};
const pttOut = async (r: Rendered) => {
  const n = node(r, tr("intercom.holdToTalk"));
  await act(async () => {
    n.props.onPressOut();
  });
};
const count = (r: Rendered, text: string) =>
  r.texts().filter((t) => t === text).length;
const sheetVisible = (r: Rendered) =>
  r.root.findAllByType(Modal)[0].props.visible as boolean;
/** 从列表进某个频道并让进房回调成功 */
const enter = async (r: Rendered, name = C1.name) => {
  const calls = mockCloud.enableAudioVolumeEvaluation.mock.calls.length;
  await tap(r, tr("intercom.enter.a11y", { name }));
  await waitFor(() =>
    expect(mockCloud.enableAudioVolumeEvaluation.mock.calls.length).toBe(
      calls + 1,
    ),
  );
  fire("onEnterRoom", { result: 120 });
};
const lastMute = () => mockCloud.muteLocalAudio.mock.calls.at(-1)?.[0];
const cues = () => m(playCue).mock.calls.map((c) => c[0]);
/** 让「现在」往后挪 ms（进房后头一秒房里已有的人补发的进房事件不响提示音） */
let nowSpy: ReturnType<typeof jest.spyOn> | null = null;
const later = (ms: number) => {
  const at = Date.now() + ms;
  nowSpy?.mockRestore();
  nowSpy = jest.spyOn(Date, "now").mockReturnValue(at);
};

let alert: ReturnType<typeof jest.spyOn>;
let share: ReturnType<typeof jest.spyOn>;
let loop: ReturnType<typeof jest.spyOn>;
const os = Platform.OS;
beforeEach(() => {
  useThemeStore.setState({ mode: "dark" });
  useLocaleStore.setState({ locale: "zh-CN" });
  useAuthStore.setState({
    user: {
      id: "u1",
      nickname: "阿麦",
      phone: "13900000042",
      avatarUrl: null,
    } as never,
  });
  useIntercomStore.setState({ session: null, openMicSeen: { u1: true } });
  useBleStore.setState({ links: {} });
  routerState.focused = true;
  mockListener = null;
  m(channelsApi.list).mockImplementation(() => Promise.resolve([C1, C2]));
  m(channelsApi.members).mockImplementation(() => Promise.resolve(MEMBERS));
  m(channelsApi.token).mockImplementation(() => Promise.resolve(TOKEN));
  m(channelsApi.create).mockImplementation(() => Promise.resolve(C1));
  m(channelsApi.join).mockImplementation(() => Promise.resolve(C1));
  m(channelsApi.leave).mockImplementation(() => Promise.resolve());
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  share = jest
    .spyOn(Share, "share")
    .mockImplementation(() => Promise.resolve({ action: "sharedAction" }));
  // 波纹 / 骨架的 RN Animated.loop：jest 里每段瞬间结束、同步重启会卡死，换成只记起停的假循环
  loop = jest
    .spyOn(RNAnimated, "loop")
    .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
});
afterEach(() => {
  alert.mockRestore();
  share.mockRestore();
  loop.mockRestore();
  nowSpy?.mockRestore();
  nowSpy = null;
  Object.defineProperty(Platform, "OS", { value: os, configurable: true });
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe("频道列表三态", () => {
  it("列表没拉到前是骨架，不说「还没有频道」；拉取失败写加载失败，点重试再拉一次", async () => {
    m(channelsApi.list).mockImplementation(() => new Promise(() => undefined));
    let r = mount();
    expect(r.texts()).toEqual([tr("intercom.title")]);

    m(channelsApi.list).mockImplementation(() =>
      Promise.reject(new ApiRequestError(500, { code: "INTERNAL" })),
    );
    r = mount();
    await waitFor(() => expect(r.texts()).toContain(tr("intercom.loadFailed")));
    expect(r.allText()).not.toContain(tr("intercom.emptyTitle"));
    expect(r.texts()).toContain(tr("intercom.loadFailedBody"));
    m(channelsApi.list).mockImplementation(() => Promise.resolve([]));
    await press(r, tr("intercom.retry"));
    await waitFor(() => expect(r.texts()).toContain(tr("intercom.emptyTitle")));
  });

  it("没有频道：空态两个按钮；新建频道空名字不提交、去空格提交，成功后关弹层并重拉列表", async () => {
    m(channelsApi.list).mockImplementation(() => Promise.resolve([]));
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(tr("intercom.emptyBody")));
    const placeholder = tr("intercom.channelNamePlaceholder");
    expect(() => r.valueOf(placeholder)).toThrow();
    await press(r, tr("intercom.create"));
    expect(r.valueOf(placeholder)).toBe("");
    r.type(placeholder, "   ");
    await press(r, tr("intercom.createAction"));
    expect(channelsApi.create).not.toHaveBeenCalled();

    const before = m(channelsApi.list).mock.calls.length;
    r.type(placeholder, "  周末骑行队 ");
    await press(r, tr("intercom.createAction"));
    await waitFor(() => expect(() => r.valueOf(placeholder)).toThrow());
    expect(channelsApi.create).toHaveBeenCalledWith({ name: "周末骑行队" });
    expect(m(channelsApi.list).mock.calls.length).toBe(before + 1);
    // 再打开时草稿已清空
    await press(r, tr("intercom.create"));
    expect(r.valueOf(placeholder)).toBe("");
  });

  it("新建失败：弹窗说原因，弹层不关；遮罩 / 返回键关弹层", async () => {
    m(channelsApi.list).mockImplementation(() => Promise.resolve([]));
    const err = new ApiRequestError(409, { code: "CHANNEL_LIMIT" });
    m(channelsApi.create).mockImplementation(() => Promise.reject(err));
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(tr("intercom.emptyBody")));
    const placeholder = tr("intercom.channelNamePlaceholder");
    await press(r, tr("intercom.create"));
    r.type(placeholder, "车队");
    await press(r, tr("intercom.createAction"));
    await waitFor(() =>
      expect(alert).toHaveBeenCalledWith(
        tr("intercom.createFailed"),
        toUserMessage(err),
        NOTICE_OK,
      ),
    );
    expect(r.valueOf(placeholder)).toBe("车队");
    const create = r.root.findAllByType(Modal)[1];
    act(() => create.props.onRequestClose());
    expect(() => r.valueOf(placeholder)).toThrow();
    // 遮罩：点空白处关；点卡片本身不关
    await press(r, tr("intercom.create"));
    const mask = r.root
      .findAllByType(Modal)[1]
      .findAll(
        (n) =>
          typeof n.type !== "string" &&
          n.props.accessible === false &&
          typeof n.props.onPress === "function",
      );
    act(() => mask[1].props.onPress());
    expect(r.valueOf(placeholder)).toBe("车队");
    act(() => mask[0].props.onPress());
    expect(() => r.valueOf(placeholder)).toThrow();
  });

  it("输入邀请码加入：不是 6 位字母数字先提示、不发请求；对了去空格提交，成功关弹层重拉；码没找到 / 其它失败分别说明", async () => {
    m(channelsApi.list).mockImplementation(() => Promise.resolve([]));
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(tr("intercom.emptyBody")));
    const placeholder = tr("intercom.inviteCodePlaceholder");
    await press(r, tr("intercom.joinWithCode"));
    r.type(placeholder, "AB12C");
    await press(r, tr("intercom.join"));
    expect(alert).toHaveBeenCalledWith(
      tr("intercom.inviteCode"),
      tr("intercom.inviteCodeFormat"),
      NOTICE_OK,
    );
    r.type(placeholder, "AB-12C");
    await press(r, tr("intercom.join"));
    expect(channelsApi.join).not.toHaveBeenCalled();

    // 码对不上任何频道（后端回 404）：明说是邀请码没找到
    m(channelsApi.join).mockImplementationOnce(() =>
      Promise.reject(new ApiRequestError(404, { code: "NOT_FOUND" })),
    );
    r.type(placeholder, " ab12cd ");
    await press(r, tr("intercom.join"));
    await waitFor(() =>
      expect(alert).toHaveBeenLastCalledWith(
        tr("intercom.joinError"),
        tr("intercom.inviteNotFound"),
        NOTICE_OK,
      ),
    );
    expect(channelsApi.join).toHaveBeenCalledWith({ inviteCode: "ab12cd" });
    // 输入框收到能认出的邀请码时就整理好（去掉空格等）；失败了弹层不关、码留着
    expect(r.valueOf(placeholder)).toBe("ab12cd");
    // 其它失败：按错误码说原因
    const err = new ApiRequestError(500, { code: "INTERNAL" });
    m(channelsApi.join).mockImplementationOnce(() => Promise.reject(err));
    await press(r, tr("intercom.join"));
    await waitFor(() =>
      expect(alert).toHaveBeenLastCalledWith(
        tr("intercom.joinError"),
        toUserMessage(err),
        NOTICE_OK,
      ),
    );

    const before = m(channelsApi.list).mock.calls.length;
    await press(r, tr("intercom.join"));
    await waitFor(() => expect(() => r.valueOf(placeholder)).toThrow());
    expect(m(channelsApi.list).mock.calls.length).toBe(before + 1);
    // 返回键关弹层
    await press(r, tr("intercom.joinWithCode"));
    expect(r.valueOf(placeholder)).toBe("");
    act(() => r.root.findAllByType(Modal)[2].props.onRequestClose());
    expect(() => r.valueOf(placeholder)).toThrow();
  });

  it("有频道：名字和人数，只有第一个进入键是品牌色；右上角 + 打开「创建或加入」，两项各开对应弹层；关闭按钮 / 遮罩 / 返回键收面板", async () => {
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C2.name));
    expect(r.texts()).toEqual(
      expect.arrayContaining([
        C1.name,
        tr("intercom.memberTotal", { n: 1 }),
        tr("intercom.memberTotal", { n: 5 }),
      ]),
    );
    expect(count(r, tr("intercom.enter"))).toBe(2);
    const first = flat(
      node(r, tr("intercom.enter.a11y", { name: C1.name })).props.style,
    );
    const second = flat(
      node(r, tr("intercom.enter.a11y", { name: C2.name })).props.style,
    );
    expect(first.backgroundColor).toBe(dark.brand);
    expect(second.backgroundColor).toBeUndefined();
    expect(second.borderColor).toBe(dark.borderStrong);

    expect(sheetVisible(r)).toBe(false);
    await tap(r, tr("intercom.add.a11y"));
    expect(sheetVisible(r)).toBe(true);
    expect(r.texts()).toEqual(
      expect.arrayContaining([
        tr("intercom.add.title"),
        tr("intercom.add.create"),
        tr("intercom.add.join"),
      ]),
    );
    await press(r, tr("intercom.add.join"));
    expect(sheetVisible(r)).toBe(false);
    expect(r.valueOf(tr("intercom.inviteCodePlaceholder"))).toBe("");
    act(() => r.root.findAllByType(Modal)[2].props.onRequestClose());

    await tap(r, tr("intercom.add.a11y"));
    await press(r, tr("intercom.add.create"));
    expect(sheetVisible(r)).toBe(false);
    expect(r.valueOf(tr("intercom.channelNamePlaceholder"))).toBe("");
    act(() => r.root.findAllByType(Modal)[1].props.onRequestClose());

    // 三种收法：右上角关闭、点遮罩、返回键
    const closers = () =>
      r.root
        .findAllByType(Modal)[0]
        .findAll(
          (n) =>
            typeof n.type !== "string" &&
            n.props.accessibilityLabel === tr("intercom.sheet.close") &&
            typeof n.props.onPress === "function",
        );
    for (const close of [
      () => closers()[0].props.onPress(),
      () => closers().at(-1)!.props.onPress(),
      () => r.root.findAllByType(Modal)[0].props.onRequestClose(),
    ]) {
      await tap(r, tr("intercom.add.a11y"));
      expect(sheetVisible(r)).toBe(true);
      act(() => close());
      expect(sheetVisible(r)).toBe(false);
    }
  });

  it("「更多」：成员（我标出来、有头像用头像、空昵称落到手机号、表情开头的首字完整）、人数以档案为准回写列表、分享邀请码", async () => {
    m(channelsApi.members).mockImplementation(() =>
      Promise.resolve([...MEMBERS, member("u4", "😀骑手", "13800000004")]),
    );
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.more.a11y", { name: C1.name }));
    expect(channelsApi.members).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(r.texts()).toContain("13800000003"));
    const names = r.texts();
    expect(names).toContain(`阿麦 (${tr("intercom.me")})`);
    expect(names).toContain("13800000002");
    expect(names).toContain("😀骑手");
    // 首字：我 → 阿、空昵称 → 手机号首位、表情 → 整个表情（不是半个）；有头像的不画首字
    expect(names).toEqual(expect.arrayContaining(["阿", "1", "😀"]));
    expect(names.filter((t) => t === "1")).toHaveLength(1);
    expect(
      r.root.findAll((n) => isHost(n, "ExpoImage")).map((n) => n.props.source),
    ).toEqual([{ uri: "https://cdn.example/u2.png" }]);
    // 列表上写的 1 位成员，档案拉回来 4 人：以档案为准
    await waitFor(() =>
      expect(r.texts()).toContain(tr("intercom.more.lead", { n: 4 })),
    );
    expect(r.texts()).toContain(tr("intercom.memberTotal", { n: 4 }));
    expect(r.texts()).not.toContain(tr("intercom.memberTotal", { n: 1 }));

    expect(r.texts()).toContain(C1.inviteCode);
    await press(r, tr("intercom.shareInvite"));
    expect(share).toHaveBeenCalledWith({
      message: tr("intercom.shareMessage", {
        name: C1.name,
        code: C1.inviteCode,
      }),
    });
  });

  it("「更多」里退出频道：先确认，确认后收面板、调退出并重拉列表；失败弹窗说原因", async () => {
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.more.a11y", { name: C1.name }));
    await press(r, tr("intercom.more.quit"));
    const [title, body, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; style?: string; onPress?: () => void }[],
    ];
    expect(title).toBe(tr("intercom.leaveChannel"));
    expect(body).toBe(tr("intercom.leaveChannelBody", { name: C1.name }));
    expect(buttons.map((b) => b.style)).toEqual(["cancel", "destructive"]);
    const before = m(channelsApi.list).mock.calls.length;
    await act(async () => {
      buttons[1].onPress!();
    });
    expect(sheetVisible(r)).toBe(false);
    expect(channelsApi.leave).toHaveBeenCalledWith("c1");
    // 不在房间里：不用退房
    expect(mockCloud.exitRoom).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(m(channelsApi.list).mock.calls.length).toBe(before + 1),
    );

    const err = new ApiRequestError(500, { code: "INTERNAL" });
    m(channelsApi.leave).mockImplementation(() => Promise.reject(err));
    await tap(r, tr("intercom.more.a11y", { name: C2.name }));
    await press(r, tr("intercom.more.quit"));
    const again = alert.mock.calls.at(-1)![2] as { onPress?: () => void }[];
    await act(async () => {
      again[1].onPress!();
    });
    await waitFor(() =>
      expect(alert).toHaveBeenLastCalledWith(
        tr("intercom.leaveFailed"),
        toUserMessage(err),
        NOTICE_OK,
      ),
    );
  });
});

describe("进房", () => {
  it("先退房清场再拿凭证进房：带房间权限钥匙、语音通话场景，开本地音频但先静音、开音量回调；进入中这一个转圈、别的进不去", async () => {
    let give!: (t: VoiceTokenResponse) => void;
    m(channelsApi.token).mockImplementation(
      () => new Promise<VoiceTokenResponse>((res) => (give = res)),
    );
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    expect(channelsApi.token).toHaveBeenCalledWith("c1");
    expect(mockCloud.exitRoom.mock.invocationCallOrder[0]).toBeLessThan(
      m(channelsApi.token).mock.invocationCallOrder[0],
    );
    expect(r.root.findAllByType(DotsLoader)).toHaveLength(1);
    expect(count(r, tr("intercom.enter"))).toBe(1);
    expect(
      node(r, tr("intercom.enter.a11y", { name: C2.name })).props.disabled,
    ).toBe(true);
    expect(
      node(r, tr("intercom.enter.a11y", { name: C1.name })).props.disabled,
    ).toBe(false);
    // 进入中再点：不重来
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    expect(mockCloud.exitRoom).toHaveBeenCalledTimes(1);

    await act(async () => {
      give(TOKEN);
    });
    await waitFor(() =>
      expect(mockCloud.enableAudioVolumeEvaluation).toHaveBeenCalledWith(300),
    );
    const [params, scene] = mockCloud.enterRoom.mock.calls[0] as [
      Record<string, unknown>,
      number,
    ];
    expect({ ...params }).toEqual({
      sdkAppId: 1400000001,
      userId: "u1",
      userSig: "sig-u1",
      roomId: 101,
      privateMapKey: "pmk-101",
    });
    expect(scene).toBe(2);
    expect(mockCloud.startLocalAudio).toHaveBeenCalledWith(1);
    expect(mockCloud.muteLocalAudio).toHaveBeenCalledWith(true);
    // 还没收到进房回调：仍是列表
    expect(r.texts()).toContain(C2.name);
  });

  it("进房回调成功：进房间（1 人在线、我在格子里）、提示音与震动、按住说话时常亮、给小条的摘要；失败码写出来", async () => {
    let r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await enter(r);
    expect(r.texts()).toEqual(
      expect.arrayContaining([
        C1.name,
        tr("intercom.onlineCount", { n: 1 }),
        `阿麦 (${tr("intercom.me")})`,
        tr("intercom.caption.hold"),
      ]),
    );
    expect(r.texts()).not.toContain(C2.name);
    expect(prepareCues).toHaveBeenCalled();
    expect(cues()).toEqual(["enter"]);
    expect(Haptics.notificationAsync).toHaveBeenCalledWith("success");
    expect(activateKeepAwakeAsync).toHaveBeenCalledWith("intercom");
    expect(useIntercomStore.getState().session).toEqual({
      channelId: "c1",
      channelName: C1.name,
      micOpen: false,
      reconnecting: false,
    });

    r.unmount();
    jest.clearAllMocks();
    r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() =>
      expect(mockCloud.enableAudioVolumeEvaluation).toHaveBeenCalled(),
    );
    fire("onEnterRoom", { result: -100018 });
    expect(r.texts()).toContain(tr("intercom.joinFailed", { code: -100018 }));
    // 采集在进房回调之前就开了：失败时停掉并退房，麦克风不能一直开着
    expect(mockCloud.stopLocalAudio).toHaveBeenCalledTimes(1);
    expect(mockCloud.exitRoom).toHaveBeenCalledTimes(2);
    expect(r.texts()).toContain(C2.name);
    expect(count(r, tr("intercom.enter"))).toBe(2);
    expect(playCue).not.toHaveBeenCalled();
    expect(useIntercomStore.getState().session).toBeNull();
  });

  it("凭证拿不到：写出原因，不卡在进入中", async () => {
    const err = new ApiRequestError(403, { code: "FORBIDDEN" });
    m(channelsApi.token).mockImplementation(() => Promise.reject(err));
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(r.texts()).toContain(toUserMessage(err)));
    expect(count(r, tr("intercom.enter"))).toBe(2);
    expect(mockCloud.enterRoom).not.toHaveBeenCalled();
  });

  it("8 秒没有进房回调写超时；进房成功的那次，旧定时器不会在下一次进入时误报超时", async () => {
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    jest.useFakeTimers();
    const advance = async (ms: number) => {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    };
    // 第一次：进房成功，8 秒后什么也不报
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await advance(0);
    fire("onEnterRoom", { result: 80 });
    await advance(5000);
    // 马上结束通话，退房回调回到列表
    await tap(r, tr("intercom.leaveRoom"));
    await advance(260);
    fire("onExitRoom");
    expect(r.texts()).toContain(C2.name);
    // 第二次：凭证一直不回
    m(channelsApi.token).mockImplementation(() => new Promise(() => undefined));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await advance(4000);
    // 第一次的定时器若没清，这时（第一次之后 9 秒多）已经误报
    expect(r.allText()).not.toContain(tr("intercom.joinTimeout"));
    expect(r.root.findAllByType(DotsLoader)).toHaveLength(1);
    await advance(3999);
    expect(r.allText()).not.toContain(tr("intercom.joinTimeout"));
    await advance(1);
    expect(r.texts()).toContain(tr("intercom.joinTimeout"));
    expect(r.root.findAllByType(DotsLoader)).toHaveLength(0);
  });

  it("Android：麦克风权限被拒写清原因、不进房；允许了照常进", async () => {
    Object.defineProperty(Platform, "OS", {
      value: "android",
      configurable: true,
    });
    const ask = jest
      .spyOn(PermissionsAndroid, "request")
      .mockImplementationOnce(() => Promise.resolve("denied"))
      .mockImplementationOnce(() => Promise.resolve("granted"));
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(r.texts()).toContain(tr("intercom.micDenied")));
    expect(ask).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    );
    expect(mockMic.ask).not.toHaveBeenCalled();
    expect(mockCloud.exitRoom).not.toHaveBeenCalled();
    expect(channelsApi.token).not.toHaveBeenCalled();

    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(channelsApi.token).toHaveBeenCalledWith("c1"));
    expect(r.allText()).not.toContain(tr("intercom.micDenied"));
    ask.mockRestore();
  });

  it("iOS：进房前也先问麦克风权限，拒了写清原因、不进房；允许了照常进；问不出结果（原生异常）不拦", async () => {
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    mockMic.ask.mockImplementationOnce(() =>
      Promise.resolve({ granted: false, status: "denied" }),
    );
    let r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(r.texts()).toContain(tr("intercom.micDenied")));
    expect(mockCloud.exitRoom).not.toHaveBeenCalled();
    expect(channelsApi.token).not.toHaveBeenCalled();

    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(channelsApi.token).toHaveBeenCalledWith("c1"));
    expect(r.allText()).not.toContain(tr("intercom.micDenied"));
    expect(mockMic.ask).toHaveBeenCalledTimes(2);
    r.unmount();

    m(channelsApi.token).mockClear();
    mockMic.ask.mockImplementationOnce(() => Promise.reject(new Error("x")));
    r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(channelsApi.token).toHaveBeenCalledWith("c1"));
  });

  it("进房途中离开页面（含退出登录）：凭证晚到不进房；已经在进房的，进房回来也不再开麦", async () => {
    let give!: (t: VoiceTokenResponse) => void;
    m(channelsApi.token).mockImplementation(
      () => new Promise<VoiceTokenResponse>((res) => (give = res)),
    );
    let r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(channelsApi.token).toHaveBeenCalled());
    r.unmount();
    await act(async () => {
      give(TOKEN);
    });
    expect(mockCloud.enterRoom).not.toHaveBeenCalled();
    expect(mockCloud.startLocalAudio).not.toHaveBeenCalled();

    m(channelsApi.token).mockImplementation(() => Promise.resolve(TOKEN));
    let entered!: () => void;
    mockCloud.enterRoom.mockImplementationOnce(
      () => new Promise<void>((res) => (entered = () => res())),
    );
    r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(mockCloud.enterRoom).toHaveBeenCalled());
    r.unmount();
    await act(async () => {
      entered();
    });
    expect(mockCloud.startLocalAudio).not.toHaveBeenCalled();
  });

  it("超时：停采集并主动退房；之后第一次的凭证才回来也不进房，换个频道照常进", async () => {
    const gives: ((t: VoiceTokenResponse) => void)[] = [];
    m(channelsApi.token).mockImplementation(
      () => new Promise<VoiceTokenResponse>((res) => gives.push(res)),
    );
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    jest.useFakeTimers();
    const advance = async (ms: number) => {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    };
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await advance(0);
    const exits = mockCloud.exitRoom.mock.calls.length;
    await advance(8000);
    expect(r.texts()).toContain(tr("intercom.joinTimeout"));
    expect(mockCloud.exitRoom.mock.calls.length).toBe(exits + 1);
    expect(mockCloud.stopLocalAudio).toHaveBeenCalledTimes(1);

    await tap(r, tr("intercom.enter.a11y", { name: C2.name }));
    await advance(0);
    expect(gives).toHaveLength(2);
    await act(async () => {
      gives[0](TOKEN);
    });
    expect(mockCloud.enterRoom).not.toHaveBeenCalled();
    await act(async () => {
      gives[1]({ ...TOKEN, roomId: 202 });
    });
    await advance(0);
    expect(mockCloud.enterRoom).toHaveBeenCalledTimes(1);
    expect(
      (mockCloud.enterRoom.mock.calls[0][0] as { roomId: number }).roomId,
    ).toBe(202);
  });

  it("已经进了房、回调却一直没来：超时退房；之后才到的进房回调不把界面切进房间", async () => {
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    jest.useFakeTimers();
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(8000);
    });
    expect(mockCloud.enableAudioVolumeEvaluation).toHaveBeenCalled();
    expect(r.texts()).toContain(tr("intercom.joinTimeout"));
    expect(mockCloud.stopLocalAudio).toHaveBeenCalledTimes(1);
    fire("onEnterRoom", { result: 120 });
    expect(r.texts()).toContain(C2.name);
    expect(cues()).not.toContain("enter");
    expect(useIntercomStore.getState().session).toBeNull();
  });

  it("进房回调说失败时 enterRoom 还没返回：之后不再开采集", async () => {
    let entered!: () => void;
    mockCloud.enterRoom.mockImplementationOnce(
      () => new Promise<void>((res) => (entered = () => res())),
    );
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(mockCloud.enterRoom).toHaveBeenCalled());
    fire("onEnterRoom", { result: -3301 });
    expect(r.texts()).toContain(tr("intercom.joinFailed", { code: -3301 }));
    await act(async () => {
      entered();
    });
    expect(mockCloud.startLocalAudio).not.toHaveBeenCalled();
    expect(mockCloud.exitRoom).toHaveBeenCalledTimes(2);
  });

  it("进房途中在「更多」里退出这个频道：这次进房作废并退房，凭证晚到也不进房", async () => {
    let give!: (t: VoiceTokenResponse) => void;
    m(channelsApi.token).mockImplementation(
      () => new Promise<VoiceTokenResponse>((res) => (give = res)),
    );
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(channelsApi.token).toHaveBeenCalled());
    expect(r.root.findAllByType(DotsLoader)).toHaveLength(1);
    await tap(r, tr("intercom.more.a11y", { name: C1.name }));
    await press(r, tr("intercom.more.quit"));
    const buttons = alert.mock.calls.at(-1)![2] as { onPress?: () => void }[];
    await act(async () => {
      buttons[1].onPress!();
    });
    expect(channelsApi.leave).toHaveBeenCalledWith("c1");
    expect(mockCloud.exitRoom).toHaveBeenCalledTimes(2);
    expect(r.root.findAllByType(DotsLoader)).toHaveLength(0);
    await act(async () => {
      give(TOKEN);
    });
    expect(mockCloud.enterRoom).not.toHaveBeenCalled();
  });
});

describe("房间里", () => {
  const inRoom = async (list: VoiceChannel[] = [C1, C2]) => {
    m(channelsApi.list).mockImplementation(() => Promise.resolve(list));
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await enter(r);
    await waitFor(() =>
      expect(qc.getQueryData(["voice-members", "c1"])).toBeDefined(),
    );
    return r;
  };

  it("成员网格：刚进房那一秒房里已有的人不响，之后有人进来才响；档案里没有的人才重拉档案（连着来几个只拉一次）；名字依次取昵称 / 手机号（空昵称也算没设）/ id 后四位；离开的移除；在线人数跟着变", async () => {
    const r = await inRoom();
    const pulls = m(channelsApi.members).mock.calls.length;
    // 进了一个已经有人的房间：每个人都补发一次「进来了」，原来一进房就连响 N 声、连拉 N 次档案
    fire("onRemoteUserEnterRoom", { userId: "u2" });
    expect(cues()).not.toContain("join");
    await act(async () => undefined);
    expect(m(channelsApi.members).mock.calls.length).toBe(pulls);
    later(1000);
    fire("onRemoteUserEnterRoom", { userId: "u3" });
    expect(cues().filter((c) => c === "join")).toHaveLength(1);
    // 档案里没有的人：重拉；同一时间来了两个也只拉一次
    act(() => {
      mockListener!("onRemoteUserEnterRoom", { userId: "stranger-9a7f" });
      mockListener!("onRemoteUserEnterRoom", { userId: "stranger-0001" });
    });
    await waitFor(() =>
      expect(m(channelsApi.members).mock.calls.length).toBe(pulls + 1),
    );
    await act(async () => undefined);
    expect(m(channelsApi.members).mock.calls.length).toBe(pulls + 1);
    fire("onRemoteUserLeaveRoom", { userId: "stranger-0001" });
    // 同一个人重复进房事件不重复算
    fire("onRemoteUserEnterRoom", { userId: "u2" });
    await waitFor(() => expect(r.texts()).toContain("13800000003"));
    expect(r.texts()).toEqual(
      expect.arrayContaining([
        "13800000002",
        "9a7f",
        tr("intercom.onlineCount", { n: 4 }),
      ]),
    );
    // 有头像的用头像，没有的画首字
    expect(
      r.root.findAll((n) => isHost(n, "ExpoImage")).map((n) => n.props.source),
    ).toEqual([{ uri: "https://cdn.example/u2.png" }]);
    expect(r.texts()).toEqual(expect.arrayContaining(["阿", "1", "9"]));

    fire("onRemoteUserLeaveRoom", { userId: "u3" });
    expect(r.texts()).not.toContain("13800000003");
    expect(r.texts()).toContain(tr("intercom.onlineCount", { n: 3 }));
  });

  it("自己的昵称是空串时格子里写手机号，表情开头的昵称首字完整", async () => {
    useAuthStore.setState({
      user: { id: "u1", nickname: " ", phone: "13900000042" } as never,
    });
    let r = await inRoom();
    expect(r.texts()).toContain(`13900000042 (${tr("intercom.me")})`);
    r.unmount();
    useAuthStore.setState({
      user: { id: "u1", nickname: "🏍️阿麦", phone: "13900000042" } as never,
    });
    r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await enter(r);
    expect(r.texts()).toContain(`🏍️阿麦 (${tr("intercom.me")})`);
    expect(r.texts()).toContain("🏍");
  });

  it("说话指示：音量过阈值标「说话中」（本端的 userId 是空串）；点成员对我静音后不再标、出静音角标，再点取消", async () => {
    const r = await inRoom();
    fire("onRemoteUserEnterRoom", { userId: "u2" });
    await waitFor(() => expect(r.texts()).toContain("13800000002"));
    fire("onUserVoiceVolume", {
      userVolumes: [
        { userId: "", volume: 30 },
        { userId: "u2", volume: 9 },
      ],
    });
    expect(count(r, tr("intercom.speaking"))).toBe(1);
    const mine = cellOf(r, `阿麦 (${tr("intercom.me")})`);
    expect(mine).toBeUndefined(); // 自己的格子不能点
    fire("onUserVoiceVolume", {
      userVolumes: [
        { userId: "", volume: 0 },
        { userId: "u2", volume: 60 },
      ],
    });
    expect(count(r, tr("intercom.speaking"))).toBe(1);
    // 只是音量数值变了、谁在说话没变：不换状态
    fire("onUserVoiceVolume", {
      userVolumes: [{ userId: "u2", volume: 70 }],
    });
    expect(count(r, tr("intercom.speaking"))).toBe(1);

    // 读屏：别人的格子是按钮，读出名字和在说话，提示点了是对我静音
    const u2 = cellOf(r, "13800000002");
    expect(u2.props.accessibilityRole).toBe("button");
    expect(u2.props.accessibilityLabel).toBe(
      `13800000002${SEP}${tr("intercom.speaking")}`,
    );
    expect(u2.props.accessibilityHint).toBe(tr("intercom.member.muteHint"));
    expect(selfCell(r).props.accessibilityLabel).toBe(
      `阿麦 (${tr("intercom.me")})`,
    );
    await act(async () => {
      cellOf(r, "13800000002").props.onPress();
    });
    expect(mockCloud.muteRemoteAudio).toHaveBeenLastCalledWith("u2", true);
    expect(count(r, tr("intercom.speaking"))).toBe(0);
    expect(r.icons()).toContain("volume-mute");
    expect(cellOf(r, "13800000002").props.accessibilityLabel).toBe(
      `13800000002${SEP}${tr("intercom.mutedForMe")}`,
    );
    expect(cellOf(r, "13800000002").props.accessibilityHint).toBe(
      tr("intercom.member.unmuteHint"),
    );
    await act(async () => {
      cellOf(r, "13800000002").props.onPress();
    });
    expect(mockCloud.muteRemoteAudio).toHaveBeenLastCalledWith("u2", false);
    expect(r.icons()).not.toContain("volume-mute");
    expect(count(r, tr("intercom.speaking"))).toBe(1);
    // 没带列表的音量回调：当作都不说话
    fire("onUserVoiceVolume", {});
    expect(count(r, tr("intercom.speaking"))).toBe(0);
  });

  it("按住说话：按下开麦、震动、提示音、写正在说话、我的格子标说话中；松开关麦", async () => {
    const r = await inRoom();
    m(playCue).mockClear();
    await pttIn(r);
    expect(lastMute()).toBe(false);
    expect(Haptics.impactAsync).toHaveBeenLastCalledWith("medium");
    expect(cues()).toEqual(["talkOn"]);
    expect(r.texts()).toContain(tr("intercom.talking"));
    expect(count(r, tr("intercom.speaking"))).toBe(1);
    await pttOut(r);
    expect(lastMute()).toBe(true);
    expect(Haptics.impactAsync).toHaveBeenLastCalledWith("light");
    expect(cues()).toEqual(["talkOn", "talkOff"]);
    expect(r.texts()).not.toContain(tr("intercom.talking"));
    expect(count(r, tr("intercom.speaking"))).toBe(0);
  });

  it("读屏：按住说话有提示，读屏的双击当开关——双击开始说话（读出正在说话），再双击结束；别的动作不管", async () => {
    const r = await inRoom();
    const ptt = () => node(r, tr("intercom.holdToTalk"));
    expect(ptt().props.accessibilityHint).toBe(tr("intercom.ptt.a11yHint"));
    expect(ptt().props.accessibilityActions).toEqual([{ name: "activate" }]);
    expect(ptt().props.accessibilityValue).toBeUndefined();
    const act11y = async (actionName: string) => {
      await act(async () => {
        ptt().props.onAccessibilityAction({ nativeEvent: { actionName } });
      });
    };
    await act11y("activate");
    expect(lastMute()).toBe(false);
    expect(r.texts()).toContain(tr("intercom.talking"));
    expect(ptt().props.accessibilityValue).toEqual({
      text: tr("intercom.talking"),
    });
    expect(selfCell(r).props.accessibilityLabel).toBe(
      `阿麦 (${tr("intercom.me")})${SEP}${tr("intercom.speaking")}`,
    );
    const mutes = mockCloud.muteLocalAudio.mock.calls.length;
    await act11y("magicTap");
    expect(mockCloud.muteLocalAudio.mock.calls.length).toBe(mutes);
    await act11y("activate");
    expect(lastMute()).toBe(true);
    expect(r.texts()).not.toContain(tr("intercom.talking"));
  });

  it("持续通话第一次先看说明：暂不开启不切；开启后麦克风开、记住看过、小条标麦克风开、不再常亮；点大按钮静音 / 再开；切回按住说话关麦", async () => {
    useIntercomStore.setState({ openMicSeen: {} });
    const r = await inRoom();
    await waitFor(() =>
      expect(useIntercomStore.getState().openMicSeen.u1).toBe(false),
    );
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(
      "helmet.intercomOpenMicSeen.u1",
    );
    const [hold, open] = modeSegs(r);
    expect(hold.props.accessibilityState).toEqual({ selected: true });
    expect(flat(hold.props.style).backgroundColor).toBe(dark.borderStrong);
    await act(async () => {
      open.props.onPress();
    });
    expect(sheetVisible(r)).toBe(true);
    expect(r.texts()).toContain(tr("intercom.openMic.lead"));
    await press(r, tr("intercom.openMic.later"));
    expect(sheetVisible(r)).toBe(false);
    expect(modeSegs(r)[0].props.accessibilityState).toEqual({ selected: true });

    m(playCue).mockClear();
    await act(async () => {
      modeSegs(r)[1].props.onPress();
    });
    await press(r, tr("intercom.openMic.confirm"));
    expect(sheetVisible(r)).toBe(false);
    expect(useIntercomStore.getState().openMicSeen.u1).toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "helmet.intercomOpenMicSeen.u1",
      "1",
    );
    expect(lastMute()).toBe(false);
    expect(cues()).toEqual(["micOn"]);
    // 大按钮下面那行 + 我的格子里的「麦克风已开启」
    expect(count(r, tr("intercom.micOn"))).toBe(2);
    expect(r.texts()).toContain(tr("intercom.caption.micOn"));
    expect(useIntercomStore.getState().session?.micOpen).toBe(true);
    expect(deactivateKeepAwake).toHaveBeenCalledWith("intercom");

    const sw = node(r, tr("intercom.micOn.a11y"));
    expect(sw.props.accessibilityState).toEqual({ checked: true });
    act(() => sw.props.onPressIn());
    act(() => sw.props.onPressOut());
    await tap(r, tr("intercom.micOn.a11y"));
    expect(lastMute()).toBe(true);
    expect(cues()).toEqual(["micOn", "micOff"]);
    expect(r.texts()).toContain(tr("intercom.micOff"));
    expect(r.texts()).toContain(tr("intercom.caption.micOff"));
    expect(r.icons()).toContain("mic-off");
    expect(useIntercomStore.getState().session?.micOpen).toBe(false);
    await tap(r, tr("intercom.micOff.a11y"));
    expect(lastMute()).toBe(false);
    expect(useIntercomStore.getState().session?.micOpen).toBe(true);

    // 切回按住说话：关麦（开着时响一声关麦）、又常亮
    const keep = m(activateKeepAwakeAsync).mock.calls.length;
    await act(async () => {
      modeSegs(r)[0].props.onPress();
    });
    expect(lastMute()).toBe(true);
    expect(cues().at(-1)).toBe("micOff");
    expect(r.texts()).toContain(tr("intercom.caption.hold"));
    expect(m(activateKeepAwakeAsync).mock.calls.length).toBe(keep + 1);
    // 已经是按住说话：再点不动
    const mutes = mockCloud.muteLocalAudio.mock.calls.length;
    await act(async () => {
      modeSegs(r)[0].props.onPress();
    });
    expect(mockCloud.muteLocalAudio.mock.calls.length).toBe(mutes);
  });

  it("看过说明的直接切到持续通话；已在持续通话再点不动；静音状态切回按住说话不响关麦音；浅色下选中段是元素底色", async () => {
    useThemeStore.setState({ mode: "light" });
    const r = await inRoom();
    await act(async () => {
      modeSegs(r)[1].props.onPress();
    });
    expect(sheetVisible(r)).toBe(false);
    expect(modeSegs(r)[1].props.accessibilityState).toEqual({
      selected: true,
    });
    expect(flat(modeSegs(r)[1].props.style).backgroundColor).toBe(
      Colors.light.backgroundElement,
    );
    const mutes = mockCloud.muteLocalAudio.mock.calls.length;
    await act(async () => {
      modeSegs(r)[1].props.onPress();
    });
    expect(mockCloud.muteLocalAudio.mock.calls.length).toBe(mutes);

    await tap(r, tr("intercom.micOn.a11y"));
    m(playCue).mockClear();
    await act(async () => {
      modeSegs(r)[0].props.onPress();
    });
    expect(cues()).toEqual([]);
    expect(lastMute()).toBe(true);
  });

  it("掉线：横幅、正按着说话当作松手、按了没反应、标题和按钮写重连中；恢复后提示「连接已恢复」并响一声；小条标重连中", async () => {
    const r = await inRoom();
    await pttIn(r);
    m(playCue).mockClear();
    fire("onConnectionLost");
    expect(r.texts()).toContain(tr("intercom.banner.net"));
    expect(cues()).toEqual(["lost"]);
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith("warning");
    expect(lastMute()).toBe(true);
    expect(r.texts()).not.toContain(tr("intercom.talking"));
    expect(count(r, tr("intercom.reconnecting"))).toBe(2);
    expect(r.texts()).toContain(tr("intercom.caption.net"));
    expect(useIntercomStore.getState().session?.reconnecting).toBe(true);

    const mutes = mockCloud.muteLocalAudio.mock.calls.length;
    await pttIn(r);
    await pttOut(r);
    expect(mockCloud.muteLocalAudio.mock.calls.length).toBe(mutes);
    expect(cues()).toEqual(["lost"]);

    fire("onTryToReconnect");
    expect(r.texts()).toContain(tr("intercom.banner.net"));
    fire("onConnectionRecovery");
    expect(showToast).toHaveBeenCalledWith(tr("intercom.reconnected"));
    expect(cues()).toEqual(["lost", "back"]);
    expect(r.texts()).not.toContain(tr("intercom.banner.net"));
    expect(r.texts()).toContain(tr("intercom.onlineCount", { n: 1 }));
    expect(useIntercomStore.getState().session?.reconnecting).toBe(false);

    // 只是重连中（没先报掉线）也写重连中
    fire("onTryToReconnect");
    expect(r.texts()).toContain(tr("intercom.banner.net"));
  });

  it("被动退出（被服务器移出 / 房间解散）：响掉线音、震动、说明原因、回到列表；自己退的不提示", async () => {
    const r = await inRoom();
    m(playCue).mockClear();
    fire("onExitRoom", { reason: 1 });
    expect(r.texts()).toContain(C2.name);
    expect(cues()).toEqual(["lost"]);
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith("warning");
    expect(showToast).toHaveBeenLastCalledWith(tr("intercom.exit.kicked"));
    expect(useIntercomStore.getState().session).toBeNull();

    await enter(r);
    fire("onExitRoom", { reason: 2 });
    expect(showToast).toHaveBeenLastCalledWith(tr("intercom.exit.dismissed"));

    await enter(r);
    const toasts = m(showToast).mock.calls.length;
    m(playCue).mockClear();
    fire("onExitRoom", { reason: 0 });
    expect(r.texts()).toContain(C2.name);
    expect(m(showToast).mock.calls.length).toBe(toasts);
    expect(cues()).toEqual([]);
  });

  it("TRTC 报错：提示错误码；正按着说话的当作松手、持续通话开着的麦克风也关上（界面和实际一致）", async () => {
    const r = await inRoom();
    await pttIn(r);
    expect(r.texts()).toContain(tr("intercom.talking"));
    fire("onError", { errCode: -1302, errMsg: "mic" });
    expect(showToast).toHaveBeenLastCalledWith(
      tr("intercom.error", { code: -1302 }),
    );
    expect(lastMute()).toBe(true);
    expect(r.texts()).not.toContain(tr("intercom.talking"));

    await act(async () => {
      modeSegs(r)[1].props.onPress();
    });
    expect(lastMute()).toBe(false);
    fire("onError", {});
    expect(showToast).toHaveBeenLastCalledWith(
      tr("intercom.error", { code: "?" }),
    );
    expect(lastMute()).toBe(true);
    expect(r.texts()).toContain(tr("intercom.micOff"));
    expect(useIntercomStore.getState().session?.micOpen).toBe(false);
  });

  it("持续通话时掉线：麦克风不动（连上后照常开着），点大按钮没反应；没按着说话时掉线也不额外关麦", async () => {
    const r = await inRoom();
    fire("onConnectionLost");
    expect(mockCloud.muteLocalAudio.mock.calls.length).toBe(1); // 只有进房时那次
    fire("onConnectionRecovery");
    await act(async () => {
      modeSegs(r)[1].props.onPress();
    });
    const mutes = mockCloud.muteLocalAudio.mock.calls.length;
    fire("onConnectionLost");
    expect(mockCloud.muteLocalAudio.mock.calls.length).toBe(mutes);
    await tap(r, tr("intercom.micOn.a11y"));
    expect(mockCloud.muteLocalAudio.mock.calls.length).toBe(mutes);
    expect(r.texts()).toContain(tr("intercom.reconnecting"));
  });

  it("头盔断开：没进房时不管；按住说话写已切到手机；持续通话开着麦时自动静音并写出来；头盔回来横幅消失；断着时开持续通话不替他开麦", async () => {
    useBleStore.setState({
      links: { h1: { phase: "connected", eventsReceived: 0, resent: 0 } },
    });
    const link = (phase: "connected" | "disconnected") =>
      act(() => useBleStore.getState().patchLink("h1", { phase }));
    m(channelsApi.list).mockImplementation(() => Promise.resolve([C1]));
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    link("disconnected");
    link("connected");
    expect(playCue).not.toHaveBeenCalled();

    await enter(r);
    m(playCue).mockClear();
    // 别的字段变了、连没连上没变：不管
    act(() => useBleStore.getState().patchLink("h1", { lastFrameAt: 1 }));
    expect(playCue).not.toHaveBeenCalled();
    link("disconnected");
    expect(r.texts()).toContain(tr("intercom.banner.helmet"));
    expect(cues()).toEqual(["helmet"]);
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith("warning");
    link("connected");
    expect(r.texts()).not.toContain(tr("intercom.banner.helmet"));

    await act(async () => {
      modeSegs(r)[1].props.onPress();
    });
    expect(lastMute()).toBe(false);
    link("disconnected");
    expect(r.texts()).toContain(tr("intercom.banner.helmetMuted"));
    expect(lastMute()).toBe(true);
    expect(r.texts()).toContain(tr("intercom.micOff"));

    // 头盔断着：切回按住说话再切持续通话，麦克风保持关着
    await act(async () => {
      modeSegs(r)[0].props.onPress();
    });
    expect(r.texts()).toContain(tr("intercom.banner.helmet"));
    m(playCue).mockClear();
    await act(async () => {
      modeSegs(r)[1].props.onPress();
    });
    expect(lastMute()).toBe(true);
    expect(cues()).toEqual([]);
    expect(r.texts()).toContain(tr("intercom.micOff"));
    // 静音着断开：不再重复关麦
    link("connected");
    const mutes = mockCloud.muteLocalAudio.mock.calls.length;
    link("disconnected");
    expect(mockCloud.muteLocalAudio.mock.calls.length).toBe(mutes);
  });

  it("音频输出：扬声器 ↔ 听筒（切的是手机听筒，不叫「耳机」），切完提示当前输出；邀请按钮走系统分享", async () => {
    const r = await inRoom();
    expect(r.icons()).toContain("volume-high-outline");
    await tap(r, tr("intercom.speaker"));
    expect(mockDeviceManager.setAudioRoute).toHaveBeenLastCalledWith(1);
    expect(showToast).toHaveBeenLastCalledWith(
      tr("intercom.routeToast", { route: tr("intercom.earpiece") }),
    );
    expect(tr("intercom.earpiece")).toBe("听筒");
    expect(r.icons()).toContain("ear-outline");
    expect(r.texts()).toContain(tr("intercom.earpiece"));
    await tap(r, tr("intercom.earpiece"));
    expect(mockDeviceManager.setAudioRoute).toHaveBeenLastCalledWith(0);
    expect(showToast).toHaveBeenLastCalledWith(
      tr("intercom.routeToast", { route: tr("intercom.speaker") }),
    );

    await tap(r, tr("intercom.shareInvite"));
    expect(share).toHaveBeenCalledWith({
      message: tr("intercom.shareMessage", {
        name: C1.name,
        code: C1.inviteCode,
      }),
    });
  });

  it("结束通话：先关麦、响离开音，等提示音响完再退房（连点只退一次）；退房回调回到列表、小条清空，下次进房从按住说话开始", async () => {
    const r = await inRoom();
    await act(async () => {
      modeSegs(r)[1].props.onPress();
    });
    m(playCue).mockClear();
    const exits = mockCloud.exitRoom.mock.calls.length;
    jest.useFakeTimers();
    const advance = async (ms: number) => {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    };
    await tap(r, tr("intercom.leaveRoom"));
    await tap(r, tr("intercom.leaveRoom"));
    expect(lastMute()).toBe(true);
    expect(cues()).toEqual(["leave"]);
    await advance(259);
    expect(mockCloud.exitRoom.mock.calls.length).toBe(exits);
    await advance(1);
    expect(mockCloud.exitRoom.mock.calls.length).toBe(exits + 1);
    jest.useRealTimers();
    fire("onExitRoom");
    expect(r.texts()).toContain(C2.name);
    expect(useIntercomStore.getState().session).toBeNull();

    await enter(r);
    expect(modeSegs(r)[0].props.accessibilityState).toEqual({
      selected: true,
    });
    expect(r.texts()).toContain(tr("intercom.caption.hold"));
    // 上一次的离开已经结束：这次还能再离开
    m(playCue).mockClear();
    await tap(r, tr("intercom.leaveRoom"));
    expect(cues()).toEqual(["leave"]);
  });

  it("多个频道：点频道名打开切换面板（当前那个标出来）；选同一个只收面板，选另一个提示已结束并切过去；面板里还能去创建或加入", async () => {
    const r = await inRoom();
    expect(r.icons()).toContain("chevron-down");
    await tap(r, tr("intercom.switch.a11y", { name: C1.name }));
    expect(sheetVisible(r)).toBe(true);
    expect(r.texts()).toEqual(
      expect.arrayContaining([
        tr("intercom.switch.title"),
        tr("intercom.switch.lead"),
        tr("intercom.switch.here"),
        C2.name,
        tr("intercom.memberTotal", { n: 5 }),
      ]),
    );
    expect(r.icons()).toContain("checkmark");
    const exits = mockCloud.exitRoom.mock.calls.length;
    await press(r, tr("intercom.switch.here"));
    expect(sheetVisible(r)).toBe(false);
    expect(mockCloud.exitRoom.mock.calls.length).toBe(exits);

    await tap(r, tr("intercom.switch.a11y", { name: C1.name }));
    await press(r, tr("intercom.add.a11y"));
    expect(r.texts()).toContain(tr("intercom.add.join"));
    act(() => r.root.findAllByType(Modal)[0].props.onRequestClose());

    await tap(r, tr("intercom.switch.a11y", { name: C1.name }));
    await press(r, C2.name);
    expect(showToast).toHaveBeenCalledWith(
      tr("intercom.leftRoom", { name: C1.name }),
    );
    await waitFor(() =>
      expect(channelsApi.token).toHaveBeenLastCalledWith("c2"),
    );
    expect(mockCloud.exitRoom.mock.calls.length).toBe(exits + 1);
  });

  it("通话中这个频道从列表里消失（在另一台手机上退了频道）：房间标题、邀请按钮、小条照样在", async () => {
    const r = await inRoom();
    m(channelsApi.list).mockImplementation(() => Promise.resolve([C2]));
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["voice-channels"] });
    });
    expect(qc.getQueryData<VoiceChannel[]>(["voice-channels"])).toEqual([C2]);
    // 列表只剩一个：已经按新列表重画了（切换频道的下拉箭头没了）
    await waitFor(() => expect(r.icons()).not.toContain("chevron-down"));
    expect(r.texts()).toContain(C1.name);
    expect(has(r, tr("intercom.shareInvite"))).toBe(true);
    expect(useIntercomStore.getState().session).toEqual({
      channelId: "c1",
      channelName: C1.name,
      micOpen: false,
      reconnecting: false,
    });
    await tap(r, tr("intercom.shareInvite"));
    expect(share).toHaveBeenCalledWith({
      message: tr("intercom.shareMessage", {
        name: C1.name,
        code: C1.inviteCode,
      }),
    });
  });

  it("只有一个频道：频道名不是按钮，也没有下拉箭头", async () => {
    const r = await inRoom([C1]);
    expect(has(r, tr("intercom.switch.a11y", { name: C1.name }))).toBe(false);
    expect(r.icons()).not.toContain("chevron-down");
    expect(r.texts()).toContain(C1.name);
  });
});

describe("页面进出", () => {
  it("回到这一页重拉频道列表；离开页面（卸载）注销监听、退房、清掉小条和常亮", async () => {
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    const pulls = m(channelsApi.list).mock.calls.length;
    routerState.focused = false;
    r.rerender(screen());
    routerState.focused = true;
    r.rerender(screen());
    await waitFor(() =>
      expect(m(channelsApi.list).mock.calls.length).toBe(pulls + 1),
    );

    await enter(r);
    expect(useIntercomStore.getState().session).not.toBeNull();
    // 在房间里切到别的标签：按住说话也不再常亮
    routerState.focused = false;
    r.rerender(screen());
    expect(deactivateKeepAwake).toHaveBeenCalledWith("intercom");
    const exits = mockCloud.exitRoom.mock.calls.length;
    r.unmount();
    expect(mockCloud.unRegisterListener).toHaveBeenCalled();
    expect(mockCloud.exitRoom.mock.calls.length).toBe(exits + 1);
    expect(useIntercomStore.getState().session).toBeNull();
  });
});

describe("会话已失效（正被送回登录页）：不再单独提示，登录页自有说明", () => {
  it("新建、邀请码加入、退出频道遇到会话已失效：都不弹失败提示", async () => {
    m(channelsApi.create).mockImplementation(() =>
      Promise.reject(new SessionEndedError()),
    );
    m(channelsApi.join).mockImplementation(() =>
      Promise.reject(new SessionEndedError()),
    );
    m(channelsApi.leave).mockImplementation(() =>
      Promise.reject(new SessionEndedError()),
    );
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));

    await tap(r, tr("intercom.add.a11y"));
    await press(r, tr("intercom.add.create"));
    r.type(tr("intercom.channelNamePlaceholder"), "车队");
    await press(r, tr("intercom.createAction"));
    await waitFor(() => expect(channelsApi.create).toHaveBeenCalled());
    act(() => r.root.findAllByType(Modal)[1].props.onRequestClose());

    await tap(r, tr("intercom.add.a11y"));
    await press(r, tr("intercom.add.join"));
    r.type(tr("intercom.inviteCodePlaceholder"), "AB12CD");
    await press(r, tr("intercom.join"));
    await waitFor(() => expect(channelsApi.join).toHaveBeenCalled());
    act(() => r.root.findAllByType(Modal)[2].props.onRequestClose());

    await tap(r, tr("intercom.more.a11y", { name: C1.name }));
    await press(r, tr("intercom.more.quit"));
    const confirm = alert.mock.calls.find(
      (c: unknown[]) => c[0] === tr("intercom.leaveChannel"),
    )!;
    await act(async () => {
      (confirm[2] as { onPress?: () => void }[])[1].onPress!();
    });
    await waitFor(() => expect(channelsApi.leave).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    // 只有退出频道前的那个确认框
    expect(alert.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      tr("intercom.leaveChannel"),
    ]);
  });

  it("进房拿凭证时会话已失效：列表下不写「登录已失效」，也不卡在进入中", async () => {
    m(channelsApi.token).mockImplementation(() =>
      Promise.reject(new SessionEndedError()),
    );
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    await tap(r, tr("intercom.enter.a11y", { name: C1.name }));
    await waitFor(() => expect(count(r, tr("intercom.enter"))).toBe(2));
    expect(r.allText()).not.toContain(tr("error.sessionEnded"));
    expect(mockCloud.enterRoom).not.toHaveBeenCalled();
  });
});

// 夜测 N8（2026-10-16）：系统「显示大小」调到最大（约 600dpi，1080 像素宽的屏只剩约 288dp）时，
// 一行里图标、「更多」、定宽的「进入」把名字挤得只剩 1 个字，「进入」也被切。名字要先留够几个字，
// 放不下时「更多」「进入」整组换到下一行靠右，「进入」按字的大小撑开
describe("频道行：窄屏 / 大字体下名字不被挤没（夜测 N8）", () => {
  const NAME_MIN_CHARS = 6;
  const NAME_FONT_SIZE = 16;
  let dims: { mockRestore: () => void } | null = null;
  const at = (fontScale: number) => {
    // 同 edge-large-font：react-native 的导出是 getter，换原模块上的 getter 本身
    const raw = require("react-native") as { useWindowDimensions: object };
    dims = jest
      .spyOn(raw, "useWindowDimensions", "get")
      .mockReturnValue(() => ({
        width: 288,
        height: 592,
        scale: 3.75,
        fontScale,
      }));
  };
  afterEach(() => {
    dims?.mockRestore();
    dims = null;
  });

  /** 从 n 往上到 stop（不含）的祖先 */
  const chain = (n: ReactTestInstance, stop?: ReactTestInstance) => {
    const out: ReactTestInstance[] = [];
    for (let p = n.parent; p && p !== stop; p = p.parent) out.push(p);
    return out;
  };
  const rowParts = (r: Rendered) => {
    const name = r.root.find(
      (n) => isHost(n, "Text") && textOf(n) === C1.name,
    );
    const enterBtn = node(r, tr("intercom.enter.a11y", { name: C1.name }));
    const moreBtn = node(r, tr("intercom.more.a11y", { name: C1.name }));
    // 一行 = 同时包着名字和「进入」的最近那层
    const row = chain(name).find(
      (a) => a.findAll((x) => x === enterBtn).length > 0,
    )!;
    /** 行里直接的那一块（包着 n 的、父节点就是行的那层） */
    const slotOf = (n: ReactTestInstance) =>
      [n, ...chain(n, row)].find((a) => a.parent === row)!;
    return { name, enterBtn, moreBtn, row, slotOf };
  };

  it.each([1, 1.3, 2])(
    "字体 %s 倍：名字那一块要够 6 个字宽才和「更多」「进入」同排；只占一行、放不下省略",
    async (fontScale) => {
      at(fontScale);
      const r = mount();
      await waitFor(() => expect(r.texts()).toContain(C1.name));
      const { name, slotOf } = rowParts(r);
      expect(name.props.numberOfLines).toBe(1);
      const style = flat(slotOf(name).props.style);
      // 换不换行按这一块的 flexBasis 算：不够就把「更多」「进入」挤到下一行，而不是把名字挤窄
      expect(style.flexBasis).toBeGreaterThanOrEqual(
        NAME_MIN_CHARS * NAME_FONT_SIZE * fontScale,
      );
      expect(style.flexGrow).toBe(1);
      // 屏比这还窄（288dp + 2 倍字体）时收进卡片里，不撑出去
      expect(style.flexShrink).toBe(1);
      expect(style.minWidth).toBeUndefined();
    },
  );

  it("放不下时「更多」「进入」整组换到下一行、靠右，不和名字抢一行", async () => {
    at(1);
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    const { row, enterBtn, moreBtn, slotOf } = rowParts(r);
    expect(flat(row.props.style)).toMatchObject({
      flexDirection: "row",
      flexWrap: "wrap",
    });
    const actions = slotOf(enterBtn);
    expect(actions).toBe(slotOf(moreBtn));
    expect(flat(actions.props.style).marginLeft).toBe("auto");
  });

  it("「进入」不定宽定高：大字体下按字撑开，不被切", async () => {
    at(2);
    const r = mount();
    await waitFor(() => expect(r.texts()).toContain(C1.name));
    const style = flat(
      node(r, tr("intercom.enter.a11y", { name: C1.name })).props.style,
    );
    expect(style.width).toBeUndefined();
    expect(style.height).toBeUndefined();
    expect(style.minWidth).toBeGreaterThanOrEqual(76);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });
});
