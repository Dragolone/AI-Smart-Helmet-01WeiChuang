// 对讲（底部标签）：后端频道体系（API.md §13,#43）+ TRTC 语音（决策 #22/#27⑤⑥）。
// 频道创建/邀请码加入/成员档案(昵称头像)走后端;UserSig 由服务端签发,App 不持有 TRTC 密钥。
// 2026-10-07 按定稿重排：
// - 三态：还没有频道（保持 2026-09-10 的样子）/ 频道列表 / 房间里；
// - 能看到自己加入的所有频道，同一时间只在一个里面通话；房间里点频道名切换（先离开当前房间）；
// - 说话方式可切：按住说话 / 一直开麦（第一次用一直开麦先看一段说明）。每次进房都从按住说话开始，
//   不会一进房麦克风就开着；
// - 提示音（services/intercom-cues）、掉线提示、头盔断开时一直开麦自动静音；
// - 别的标签页上的「对讲中」小条看的是 stores/intercom-store 里的 session；
// - 屏幕常亮只在「按住说话」且停在这一页时开（随时要按）；一直开麦可以锁屏。
// 2026-10-17 对讲原生批次：在房期间每 5 分钟续一把房间钥匙（决策 #56 补充，services/intercom-room-key）、
// 断线重连被拒时自动重新拿凭证进房、Android 进房期间给前台服务加麦克风类型（锁屏后对端不再只听到静音）。
// 照原样保留的（负责人 2026-10-07 点名）：按住说话的按压回弹与震动、成员说话时的波纹和亮圈、
// 邀请码走系统分享面板、点成员头像对我静音、退出频道前的确认、音频输出切换、新建频道 / 输入邀请码两个弹层。
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requestRecordingPermissionsAsync } from "expo-audio";
import { Image } from "expo-image";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AccessibilityActionEvent,
  Alert,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import Animated, {
  FadeInDown,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { HelmetLinkService } from "helmet-link-service";
import TRTCCloud, {
  TRTCCloudDef,
  TRTCCloudListener,
  TRTCParams,
} from "trtc-react-native";
import type { VoiceChannel, VoiceChannelMemberPublic } from "@helmet/shared";

import { channelsApi } from "@/api/channels";
import { inviteCodeFrom } from "@/services/invite-code";
import { ApiRequestError } from "@/api/client";
import { sameSpeakers } from "@/services/voice-volume";
import { toUserMessage } from "@/api/error-messages";
import { FormInput, PrimaryButton, SecondaryButton } from "@/components/form";
import { DotsLoader } from "@/components/motion";
import { PulseRing } from "@/components/pulse-ring";
import { Skeleton } from "@/components/skeleton";
import { Tappable } from "@/components/tappable";
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { showToast } from "@/components/toast";
import { Fonts, Radius } from "@/constants/theme";
import { useAppActive } from "@/hooks/use-app-active";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { translate, useT } from "@/i18n";
import { playCue, prepareCues } from "@/services/intercom-cues";
import {
  AUTO_REJOIN_GAP_MS,
  RoomKeyRenewer,
  isRejoinError,
  isRejoinExit,
  updatePrivateMapKeyJson,
} from "@/services/intercom-room-key";
import { useAuthStore } from "@/stores/auth-store";
import { useBleStore } from "@/stores/ble-store";
import { useIntercomStore } from "@/stores/intercom-store";
import { showNotice } from "@/services/notice";
import {
  avatarInitial,
  channelNameOf,
  cleanNickname,
  personNameOf,
} from "@/services/user-name";

const SPEAKING_THRESHOLD = 10; // onUserVoiceVolume 0–100
/** 屏幕常亮的标记：只管对讲页自己开的这一份，不影响地图页开的 */
const KEEP_AWAKE_TAG = "intercom";
/** 进了一个已经有人的房间，房里每个人都会补发一次「进来了」：这段时间内只记人、不响提示音 */
const JOIN_CUE_QUIET_MS = 1000;

/** 进房没成功（失败 / 超时 / 作废）：本地采集在进房回调之前就开了，停采集再退房，麦克风不能一直开着 */
const abandonRoom = (cloud: TRTCCloud) => {
  cloud.stopLocalAudio().catch(() => {});
  cloud.exitRoom().catch(() => {});
};

type TalkMode = "hold" | "open";
/** 自动重进时带着的掉线前的说话方式 */
type Resume = { mode: TalkMode; micOn: boolean };
type Sheet =
  | { kind: "switch" }
  | { kind: "add" }
  | { kind: "more"; channelId: string }
  | { kind: "openMic" };

const anyHelmetConnected = (links: Record<string, { phase: string }>) =>
  Object.values(links).some((l) => l.phase === "connected");

/** 房内成员网格单元：56 头像 + 发言环/波纹 + 名字 + 22px 状态槽 */
function MemberCell({
  name,
  speaking,
  self = false,
  muted = false,
  micOpen = false,
  avatarUrl,
  onPress,
}: {
  name: string;
  speaking: boolean;
  self?: boolean;
  muted?: boolean;
  /** 自己一直开着麦（没在说话时也标出来：别人随时听得到） */
  micOpen?: boolean;
  avatarUrl?: string | null;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const t = useT();
  // 读屏要能听出是谁、在不在说话、是不是被我静音了；格子里这几样原来只有图标和颜色
  const a11yLabel = [
    self ? `${name} (${t("intercom.me")})` : name,
    speaking ? t("intercom.speaking") : micOpen ? t("intercom.micOpen") : "",
    muted ? t("intercom.mutedForMe") : "",
  ]
    .filter(Boolean)
    .join(t("common.a11ySep"));
  const body = (
    <>
      <View style={styles.cellRingBox}>
        <PulseRing
          active={speaking}
          size={64}
          color={theme.brand}
          maxScale={1.3}
        />
        <View
          style={[
            styles.cellAvatarRing,
            { borderColor: speaking ? theme.brand : "transparent" },
          ]}
        >
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.cellAvatar} />
          ) : (
            <View
              style={[
                styles.cellAvatar,
                { backgroundColor: theme.backgroundSelected },
              ]}
            >
              <ThemedText type="smallBold" style={{ fontSize: 18 }}>
                {avatarInitial(name)}
              </ThemedText>
            </View>
          )}
          {muted && (
            <View
              style={[styles.cellMuteBadge, { backgroundColor: theme.danger }]}
            >
              <Ionicons name="volume-mute" size={11} color="#fff" />
            </View>
          )}
        </View>
      </View>
      <ThemedText numberOfLines={1} style={styles.cellName}>
        {name}
        {self && (
          <ThemedText themeColor="textSecondary" style={styles.cellName}>
            {` (${t("intercom.me")})`}
          </ThemedText>
        )}
      </ThemedText>
      <View style={styles.cellSlot}>
        {speaking ? (
          <View style={[styles.speakPill, { backgroundColor: theme.brand }]}>
            <ThemedText
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              style={[styles.speakPillText, { color: theme.onBrand }]}
            >
              {t("intercom.speaking")}
            </ThemedText>
          </View>
        ) : (
          micOpen && (
            <View
              style={[
                styles.speakPill,
                { backgroundColor: theme.backgroundSelected },
              ]}
            >
              <ThemedText
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                style={styles.speakPillText}
              >
                {t("intercom.micOpen")}
              </ThemedText>
            </View>
          )
        )}
      </View>
    </>
  );
  return onPress ? (
    <Tappable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint={t(
        muted ? "intercom.member.unmuteHint" : "intercom.member.muteHint",
      )}
      onPress={onPress}
      style={styles.cell}
    >
      {body}
    </Tappable>
  ) : (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={a11yLabel}
      style={styles.cell}
    >
      {body}
    </View>
  );
}

export default function IntercomScreen() {
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  const t = useT();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const trtc = useRef(TRTCCloud.sharedInstance());
  /**
   * 正在进 / 已经在里面的那个频道，进房时记下一份：通话中它从列表里消失（在另一台手机上退出了频道）时，
   * 房间标题、邀请按钮和别的标签页上的小条照样有名字可显示（原来一起消失，TRTC 却还在房间里）
   */
  const [active, setActive] = useState<VoiceChannel | null>(null);
  const activeId = active?.channelId ?? null;
  const [inRoom, setInRoom] = useState(false);
  const [talking, setTalking] = useState(false);
  /** 说话方式。每次进房都从「按住说话」开始 */
  const [mode, setMode] = useState<TalkMode>("hold");
  /** 一直开麦时麦克风开没开（可以点大按钮临时静音） */
  const [micOn, setMicOn] = useState(false);
  const [netDown, setNetDown] = useState(false);
  /** 进房期间头盔的蓝牙断了 */
  const [helmetDown, setHelmetDown] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  /** PTT 按压动效:下陷缩放 + 辉光增强 */
  const pttScale = useSharedValue(1);
  const pttPressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pttScale.get() }],
  }));
  const pttGlowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pttScale.get(), [0.92, 1], [0.95, 0.35]),
    transform: [{ scale: interpolate(pttScale.get(), [0.92, 1], [1.12, 1]) }],
  }));
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [joining, setJoining] = useState(false);
  /** 断线重连被拒后正在自动重进：麦克风前台服务不能撤（锁着屏撤了就加不回来） */
  const [resuming, setResuming] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  // 创建/加入频道弹层
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // TRTC userId = 后端用户 id（token 接口签发口径）
  const myId = user?.id ?? "";

  // TRTC 监听器和蓝牙订阅里要读这几样的最新值，又不能因为它们变了就重注册——重注册的清理会退房
  const live = useRef({ inRoom, mode, micOn, talking, activeId, joining });
  useEffect(() => {
    live.current = { inRoom, mode, micOn, talking, activeId, joining };
  });

  const openMicSeen = useIntercomStore((s) =>
    myId ? s.openMicSeen[myId] : undefined,
  );
  const loadOpenMicSeen = useIntercomStore((s) => s.loadOpenMicSeen);
  useEffect(() => {
    if (myId) void loadOpenMicSeen(myId);
  }, [myId, loadOpenMicSeen]);

  const channels = useQuery({
    queryKey: ["voice-channels"],
    queryFn: channelsApi.list,
  });
  const list = channels.data ?? [];
  const channel = list.find((c) => c.channelId === activeId) ?? active;
  const moreChannel =
    sheet?.kind === "more"
      ? (list.find((c) => c.channelId === sheet.channelId) ?? null)
      : null;

  // 成员档案：房间里看当前频道的；频道列表里点开某个频道的「更多」时看它的
  const membersOf = inRoom ? activeId : (moreChannel?.channelId ?? null);
  const members = useQuery({
    queryKey: ["voice-members", membersOf],
    queryFn: () => channelsApi.members(membersOf!),
    enabled: !!membersOf,
    // 新成员的档案(昵称/头像)15s 内出现;实时"在房"由 TRTC 事件驱动
    refetchInterval: 15_000,
  });

  // 别人加入 / 退出频道不会推到这台手机：每次切回这一页重拉一次列表；
  // 成员档案拉回来的人数和列表里的对不上时以档案为准（同一张弹层曾写「1 位成员」却列出两人）
  useEffect(() => {
    if (!focused) return;
    void queryClient.refetchQueries(
      { queryKey: ["voice-channels"], type: "active" },
      { cancelRefetch: false },
    );
    // 离开这一页就收起上次进房的报错：断网时点「进入」报的「网络连接失败」，
    // 原来联网后切走再切回还一直挂在底部（2026-10-16 华为）；再点「进入」本来也会清掉
    return () => setJoinError(null);
  }, [focused, queryClient]);
  const loadedCount = members.data?.length;
  useEffect(() => {
    if (loadedCount == null || !membersOf) return;
    queryClient.setQueryData<VoiceChannel[]>(["voice-channels"], (old) =>
      old?.map((c) =>
        c.channelId === membersOf && c.memberCount !== loadedCount
          ? { ...c, memberCount: loadedCount }
          : c,
      ),
    );
  }, [loadedCount, membersOf, queryClient]);

  const memberMap = useMemo(() => {
    const map = new Map<string, VoiceChannelMemberPublic>();
    for (const m of members.data ?? []) map.set(m.userId, m);
    return map;
  }, [members.data]);

  const nameOf = (id: string) => {
    if (id === myId) return personNameOf(user, t("intercom.me"));
    return personNameOf(memberMap.get(id), id.slice(-4));
  };
  const avatarOf = (id: string) =>
    id === myId ? user?.avatarUrl : memberMap.get(id)?.avatarUrl;

  // 进房兜底定时器：有了结果（成功 / 失败 / 抛错 / 离开页面）就要清掉。原来从不清：进房成功后马上退房，
  // 8 秒内再点一次进入，上一次的定时器到点会把这一次的「进入中」解除并误报「进入超时」（B 线 10-05 指出）
  const joinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearJoinTimer = () => {
    if (joinTimer.current) clearTimeout(joinTimer.current);
    joinTimer.current = null;
  };
  // 每次进房一个序号；超时、换频道、结束通话、退出这个频道、离开页面都让它作废，晚到的凭证 / 进房回调不再进房开麦
  // （原来进房途中退出登录，凭证回来照样进房开麦，登录页上还在收发声音）
  const joinSeq = useRef(0);
  /** 已经调了 enterRoom、正等它回调的那一次的序号（0 = 没在等） */
  const awaitingEnter = useRef(0);
  const cancelJoin = () => {
    joinSeq.current += 1;
    awaitingEnter.current = 0;
    clearJoinTimer();
  };
  /** 自己这次进房成功的时刻：之后一小段时间里房里已有的人补发的「进来了」不响提示音 */
  const enteredAt = useRef(0);
  /** SDK 正在断线重连（掉线到恢复之间）：这期间被拒 / 被请出房间才自动重进 */
  const reconnecting = useRef(false);
  /** 这次进房是自动重进：进去后照掉线前的说话方式恢复 */
  const resume = useRef<Resume | null>(null);
  /** 上次自动重进的时刻：新钥匙也进不去时不能一直进进出出 */
  const lastRejoinAt = useRef(0);
  /** 自动重进要调最新的 join：监听器只注册一次，拿不到每次渲染的 join */
  const rejoinRef = useRef<(from: Resume) => void>(() => {});
  /** 正在结束通话（提示音响完才真退房） */
  const leaving = useRef(false);

  useEffect(() => {
    const cloud = trtc.current;
    const keys = new RoomKeyRenewer({
      fetchKey: (id) => channelsApi.token(id).then((tk) => tk.privateMapKey),
      applyKey: (key) => cloud.callExperimentalAPI(updatePrivateMapKeyJson(key)),
      // 在另一台手机上退出了这个频道：钥匙续不上了。主动结束这次通话，不等手里那把过期、到重连时才被拒
      onRemoved: () => {
        joinSeq.current += 1;
        awaitingEnter.current = 0;
        abandonRoom(cloud);
        playCue("lost");
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Warning,
        ).catch(() => {});
        showToast(translate("intercom.exit.removed"));
        void queryClient.invalidateQueries({ queryKey: ["voice-channels"] });
      },
    });
    /**
     * 断线重连被拒（多半是拿着过期的钥匙重新进房）：还在房间里、不是正在结束通话、一分钟内没自动重进过，
     * 就重新拿凭证进同一个频道，原来只弹「对讲出错」，人留在一个再也连不上的房间里
     */
    const tryRejoin = (): boolean => {
      if (!keys.channelId || leaving.current) return false;
      if (Date.now() - lastRejoinAt.current < AUTO_REJOIN_GAP_MS) return false;
      lastRejoinAt.current = Date.now();
      keys.stop();
      setResuming(true);
      rejoinRef.current({ mode: live.current.mode, micOn: live.current.micOn });
      return true;
    };
    // 监听器内用 translate 而非 t：避免语言切换时重注册监听并触发 cleanup 的 exitRoom
    const listener = (type: TRTCCloudListener, params: any) => {
      switch (type) {
        case TRTCCloudListener.onEnterRoom: {
          // 已经作废的那次进房晚到的回调：那边已经退房了，不能再把界面切进房间
          if (
            !awaitingEnter.current ||
            awaitingEnter.current !== joinSeq.current
          )
            break;
          awaitingEnter.current = 0;
          if (joinTimer.current) clearTimeout(joinTimer.current);
          joinTimer.current = null;
          const ok = params.result >= 0;
          const resumed = resume.current;
          resume.current = null;
          reconnecting.current = false;
          setInRoom(ok);
          setJoining(false);
          setResuming(false);
          setJoinError(
            ok
              ? null
              : translate("intercom.joinFailed", { code: params.result }),
          );
          if (ok) {
            enteredAt.current = Date.now();
            setNetDown(false);
            const id = live.current.activeId;
            if (id) keys.start(id);
            prepareCues();
            if (resumed) {
              // 自动重进：照掉线前的说话方式接着来（麦克风在进房链里就没关过），只说一声连上了
              if (resumed.mode === "open") {
                setMode("open");
                setMicOn(resumed.micOn);
              }
              playCue("back");
              showToast(translate("intercom.reconnected"));
            } else {
              playCue("enter");
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Success,
              ).catch(() => {});
            }
          } else {
            // 进房链后面的开麦不再执行；已经开了的采集停掉
            joinSeq.current += 1;
            abandonRoom(cloud);
            if (resumed) {
              playCue("lost");
              Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Warning,
              ).catch(() => {});
            }
          }
          break;
        }
        case TRTCCloudListener.onExitRoom: {
          const reason = params?.reason;
          // 断线重连途中被请出房间：多半是重新进房时钥匙被拒，自动重新拿凭证进（已经在重进的不再提示）
          const rejoined =
            resume.current !== null ||
            (isRejoinExit(reason, reconnecting.current) && tryRejoin());
          keys.stop();
          reconnecting.current = false;
          setInRoom(false);
          setOnlineIds([]);
          setVolumes({});
          setMuted({});
          // 下次进房从头来：按住说话、麦克风关着
          setMode("hold");
          setMicOn(false);
          setTalking(false);
          setNetDown(false);
          setHelmetDown(false);
          // 不是自己退的（1 = 被服务器移出，常见是同一账号在另一台手机进了对讲；2 = 房间被解散）：
          // 原来一声不响回到列表，骑行中根本不知道通话断了
          if (!rejoined && typeof reason === "number" && reason !== 0) {
            playCue("lost");
            Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Warning,
            ).catch(() => {});
            showToast(
              translate(
                reason === 2 ? "intercom.exit.dismissed" : "intercom.exit.kicked",
              ),
            );
          }
          break;
        }
        case TRTCCloudListener.onRemoteUserEnterRoom: {
          const id: string = params.userId;
          setOnlineIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
          if (
            live.current.inRoom &&
            Date.now() - enteredAt.current >= JOIN_CUE_QUIET_MS
          )
            playCue("join");
          // 档案里没有这个人（刚用邀请码加入的新成员）才重拉；正在拉就不再起一次，一进房不会连拉 N 次
          const key = ["voice-members", live.current.activeId];
          const known = queryClient
            .getQueryData<VoiceChannelMemberPublic[]>(key)
            ?.some((m) => m.userId === id);
          if (!known)
            void queryClient.invalidateQueries(
              { queryKey: key },
              { cancelRefetch: false },
            );
          break;
        }
        case TRTCCloudListener.onRemoteUserLeaveRoom:
          setOnlineIds((prev) => prev.filter((m) => m !== params.userId));
          break;
        case TRTCCloudListener.onUserVoiceVolume: {
          // userId 为空串 = 本端；音量 0–100
          const next: Record<string, number> = {};
          for (const v of params.userVolumes ?? []) {
            next[v.userId === "" ? myId : v.userId] = v.volume;
          }
          // 音量数值每 300 ms 都在变，但指示环只看是否过阈值：没人开口或闭口就沿用旧状态，不重画
          setVolumes((prev) =>
            sameSpeakers(prev, next, SPEAKING_THRESHOLD) ? prev : next,
          );
          break;
        }
        case TRTCCloudListener.onConnectionLost:
          reconnecting.current = true;
          setNetDown(true);
          playCue("lost");
          Haptics.notificationAsync(
            Haptics.NotificationFeedbackType.Warning,
          ).catch(() => {});
          // 正按着说话时掉线：当作松手。一直开麦的不动——连上后照常开着
          if (live.current.mode === "hold" && live.current.talking) {
            void cloud.muteLocalAudio(true);
            setTalking(false);
            pttScale.set(withSpring(1, { damping: 12, stiffness: 200 }));
          }
          break;
        case TRTCCloudListener.onTryToReconnect:
          reconnecting.current = true;
          setNetDown(true);
          break;
        case TRTCCloudListener.onConnectionRecovery:
          reconnecting.current = false;
          setNetDown(false);
          playCue("back");
          showToast(translate("intercom.reconnected"));
          break;
        case TRTCCloudListener.onError:
          if (
            (keys.channelId || resume.current) &&
            isRejoinError(params?.errCode, reconnecting.current)
          ) {
            // 已经在自动重进 / 正在结束通话：不用管
            if (resume.current || leaving.current || tryRejoin()) break;
            // 刚自动重进过又被拒：这个房间进不去了，退出来说清楚，不留在一个连不上的房间里
            abandonRoom(cloud);
            playCue("lost");
            Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Warning,
            ).catch(() => {});
            showToast(
              translate("intercom.exit.rejected", { code: params.errCode }),
            );
            break;
          }
          // 采集失败（麦克风被别的 App 占着）等不可恢复的错误：原来没有处理，界面还写着在说话 / 麦克风开着，
          // 实际发不出声音。说出来，并把麦克风状态收回到关着（界面和实际一致）
          showToast(
            translate("intercom.error", { code: params?.errCode ?? "?" }),
          );
          if (live.current.talking || live.current.micOn)
            void cloud.muteLocalAudio(true).catch(() => {});
          setTalking(false);
          setMicOn(false);
          pttScale.set(withSpring(1, { damping: 12, stiffness: 200 }));
          break;
      }
      // 锁屏后 Android 上的 JS 定时器停摆，SDK 的回调照常来：每个回调都顺带看一眼钥匙该不该续
      keys.tick();
    };
    cloud.registerListener(listener);
    return () => {
      // 进房还在半路时离开页面（含退出登录）：作废这一次，凭证回来也不再进房
      joinSeq.current += 1;
      awaitingEnter.current = 0;
      if (joinTimer.current) clearTimeout(joinTimer.current);
      joinTimer.current = null;
      setJoining(false);
      setResuming(false);
      resume.current = null;
      // 退出登录时标签页整个卸掉，也走这里：停掉续期，续到一半回来的钥匙不再交给 SDK
      keys.stop();
      cloud.unRegisterListener(listener);
      cloud.exitRoom();
    };
  }, [myId, queryClient, pttScale]);

  // 头盔的蓝牙在通话中断了：声音会改从手机出。一直开麦的话把麦克风关掉——
  // 用户以为还在用头盔说话，实际收声的是口袋里的手机
  useEffect(
    () =>
      useBleStore.subscribe((s, prev) => {
        const now = anyHelmetConnected(s.links);
        if (now === anyHelmetConnected(prev.links) || !live.current.inRoom)
          return;
        if (now) {
          setHelmetDown(false);
          return;
        }
        setHelmetDown(true);
        playCue("helmet");
        Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Warning,
        ).catch(() => {});
        if (live.current.mode === "open" && live.current.micOn) {
          setMicOn(false);
          void trtc.current.muteLocalAudio(true);
        }
      }),
    [],
  );

  // 给别的标签页上的「对讲中」小条看的摘要
  const micOpen = inRoom && mode === "open" && micOn;
  const sessionName = channel ? channelNameOf(channel.name) : undefined;
  useEffect(() => {
    useIntercomStore.getState().setSession(
      inRoom && activeId && sessionName
        ? {
            channelId: activeId,
            channelName: sessionName,
            micOpen,
            reconnecting: netDown,
          }
        : null,
    );
  }, [inRoom, activeId, sessionName, micOpen, netDown]);
  useEffect(() => () => useIntercomStore.getState().setSession(null), []);

  // Android 11+：退到后台 / 锁屏后，系统把没有「麦克风」类前台服务的 App 的麦克风静音，对端只听到静音。
  // 从点进入到离开房间，给头盔连接服务加上麦克风类型。Android 14 起只许在前台、已有录音权限时加：
  // 只在前台时加（进房前已经问过权限），回到前台再补一次（已经加着时是空操作）；
  // 退到后台、自动重进期间都不撤——锁着屏撤了就加不回来。iOS 靠后台音频模式，这里是空操作
  const holdMic = inRoom || joining || resuming;
  const appActive = useAppActive();
  useEffect(() => {
    if (holdMic && appActive)
      HelmetLinkService.setMicrophone(
        true,
        t("intercom.service.title"),
        t("intercom.service.text", { name: sessionName ?? "" }),
      );
  }, [holdMic, appActive, sessionName, t]);
  useEffect(() => {
    if (!holdMic) return;
    return () => {
      HelmetLinkService.setMicrophone(false);
    };
  }, [holdMic]);

  // 按住说话时要随时够得着按钮：停在这一页就不让屏幕熄。一直开麦不需要看屏幕，可以锁屏
  const keepAwake = inRoom && mode === "hold" && focused;
  useEffect(() => {
    if (!keepAwake) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [keepAwake]);

  /**
   * 进房结束（成功之外的各种收场）。failed：没进去（不是自己结束 / 退出频道）——
   * 自动重进没进去要响一声，锁着屏的人才知道通话断了
   */
  const stopJoining = (failed: boolean) => {
    if (failed && resume.current) {
      playCue("lost");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
        () => {},
      );
    }
    resume.current = null;
    setJoining(false);
    setResuming(false);
  };

  /** resumeFrom：断线重连被拒后的自动重进，带着掉线前的说话方式 */
  const join = async (target: VoiceChannel, resumeFrom?: Resume) => {
    if (joining) return;
    const seq = (joinSeq.current += 1);
    awaitingEnter.current = 0;
    resume.current = resumeFrom ?? null;
    // 一直开着麦的人自动重进后照样开着（多半锁着屏，不知道刚才断过）；其余照常先静音
    const openMic = resumeFrom?.mode === "open" && resumeFrom.micOn;
    // 每个 await 之后都要问一句：这次进房还算不算数（超时 / 换了频道 / 离开了页面）
    const stale = () => seq !== joinSeq.current;
    // 拒了不能静默退回列表（2026-10-15）：说清为什么没进去、去哪开。iOS 原来不问，拒过的人进房后一声不出
    const micGranted =
      Platform.OS === "android"
        ? (await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          )) === PermissionsAndroid.RESULTS.GRANTED
        : Platform.OS === "ios"
          ? // 拿不到结果（原生模块异常）时不拦：交给 TRTC 自己申请，出错走 onError
            await requestRecordingPermissionsAsync().then(
              (p) => p.granted,
              () => true,
            )
          : true;
    if (stale()) return;
    if (!micGranted) {
      stopJoining(true);
      setJoinError(translate("intercom.micDenied"));
      return;
    }
    setActive(target);
    setJoining(true);
    setJoinError(null);
    // 原生 TRTC 单例跨 JS 重载存活:先幂等退房清场,避免 -3340 already in room。
    // 从另一个频道切过来也靠这一步先离开原来的房间
    try {
      await trtc.current.exitRoom();
    } catch {}
    if (stale()) return;
    // 进房兜底超时：回调丢失时 8s 后解除「进入中」，并且主动退房——凭证可能已经用上、采集已经开了
    clearJoinTimer();
    joinTimer.current = setTimeout(() => {
      joinTimer.current = null;
      if (stale()) return;
      cancelJoin();
      abandonRoom(trtc.current);
      stopJoining(true);
      setJoinError(translate("intercom.joinTimeout"));
    }, 8000);
    try {
      // UserSig 服务端签发（决策 #27⑥）,App 端不再持有 TRTC SecretKey
      const tk = await channelsApi.token(target.channelId);
      if (stale()) return;
      const params = new TRTCParams({
        sdkAppId: tk.sdkAppId,
        userId: tk.userId,
        userSig: tk.userSig,
        roomId: tk.roomId,
        // 房间权限钥匙（决策 #56）：凭证只对这个房间有效，别人拿着自己频道的凭证进不来
        privateMapKey: tk.privateMapKey,
      });
      awaitingEnter.current = seq;
      await trtc.current.enterRoom(
        params,
        TRTCCloudDef.TRTC_APP_SCENE_AUDIOCALL,
      );
      if (stale()) return;
      await trtc.current.startLocalAudio(
        TRTCCloudDef.TRTC_AUDIO_QUALITY_SPEECH,
      );
      if (stale()) return;
      await trtc.current.muteLocalAudio(!openMic);
      if (stale()) return;
      // 发言指示环所需：每 300ms 回调一次成员音量
      await trtc.current.enableAudioVolumeEvaluation(300);
    } catch (e) {
      if (stale()) return;
      // 半路出错也不能留个开着采集、可能已进房的半截状态
      cancelJoin();
      abandonRoom(trtc.current);
      stopJoining(true);
      setJoinError(toUserMessage(e));
    }
  };

  // 断线重连被拒后自动重进同一个频道（监听器里调）
  useEffect(() => {
    rejoinRef.current = (from) => {
      if (active) void join(active, from);
      else setResuming(false);
    };
  });

  const leaveRoom = () => {
    if (leaving.current) return;
    leaving.current = true;
    // 换频道的进房还在半路时点了结束：那一次也作废，不然退完房它又进去了
    cancelJoin();
    stopJoining(false);
    trtc.current.muteLocalAudio(true).catch(() => {});
    playCue("leave");
    // 留一点时间让提示音响完：退房会把 TRTC 的音频引擎一起停掉
    setTimeout(() => {
      leaving.current = false;
      void trtc.current.exitRoom();
    }, 260);
  };

  /** 房间里换频道：先离开当前房间（join 里的退房），再进新的 */
  const switchTo = (next: VoiceChannel) => {
    setSheet(null);
    if (next.channelId === activeId) return;
    if (channel)
      showToast(t("intercom.leftRoom", { name: channelNameOf(channel.name) }));
    void join(next);
  };

  const leaveChannel = (c: VoiceChannel) => {
    Alert.alert(
      t("intercom.leaveChannel"),
      t("intercom.leaveChannelBody", { name: channelNameOf(c.name) }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("intercom.leaveConfirm"),
          style: "destructive",
          onPress: () => {
            setSheet(null);
            // 退的正是正在进 / 已经在里面的那个：先把这次通话停掉。原来进房途中退出频道，凭证回来照样进房，
            // 人在一个列表里已经没有的频道里，房间标题、邀请和小条全空
            const cur = live.current;
            if (cur.activeId === c.channelId && (cur.inRoom || cur.joining)) {
              cancelJoin();
              stopJoining(false);
              abandonRoom(trtc.current);
            }
            channelsApi
              .leave(c.channelId)
              .then(() =>
                queryClient.invalidateQueries({ queryKey: ["voice-channels"] }),
              )
              .catch((e) =>
                showNotice(t("intercom.leaveFailed"), toUserMessage(e)),
              );
          },
        },
      ],
    );
  };

  const shareInvite = (c: VoiceChannel) => {
    void Share.share({
      message: t("intercom.shareMessage", {
        name: channelNameOf(c.name),
        code: c.inviteCode,
      }),
    });
  };

  // 提交前和显示时同一套整理：只剩看不见的字符 / 空白就不提交（按钮本来也是灰的）
  const createName = cleanNickname(nameDraft);
  const submitCreate = () => {
    if (!createName) return;
    setSubmitting(true);
    channelsApi
      .create({ name: createName })
      .then(() => {
        setCreateOpen(false);
        setNameDraft("");
        return queryClient.invalidateQueries({ queryKey: ["voice-channels"] });
      })
      .catch((e) => showNotice(t("intercom.createFailed"), toUserMessage(e)))
      .finally(() => setSubmitting(false));
  };

  const submitJoin = () => {
    const inviteCode = inviteCodeFrom(codeDraft);
    if (!inviteCode) {
      showNotice(t("intercom.inviteCode"), t("intercom.inviteCodeFormat"));
      return;
    }
    setSubmitting(true);
    channelsApi
      .join({ inviteCode })
      .then(() => {
        setJoinOpen(false);
        setCodeDraft("");
        return queryClient.invalidateQueries({ queryKey: ["voice-channels"] });
      })
      .catch((e) =>
        showNotice(
          t("intercom.joinError"),
          // 邀请码对不上任何频道时后端回通用 404，原来写「内容不存在或已删除」，看不出是码错了
          e instanceof ApiRequestError && e.status === 404
            ? t("intercom.inviteNotFound")
            : toUserMessage(e),
        ),
      )
      .finally(() => setSubmitting(false));
  };

  // 按下/松开都给触觉确认:骑行戴手套看不清屏幕,靠震动知道开没开麦
  const pttDown = async () => {
    // 掉线时按了也发不出去：不给「正在说话」的假象
    if (netDown) return;
    pttScale.set(withSpring(0.92, { damping: 14, stiffness: 260 }));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    playCue("talkOn");
    await trtc.current.muteLocalAudio(false);
    setTalking(true);
  };
  const pttUp = async () => {
    if (!live.current.talking && netDown) return;
    pttScale.set(withSpring(1, { damping: 12, stiffness: 200 }));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    playCue("talkOff");
    await trtc.current.muteLocalAudio(true);
    setTalking(false);
  };
  // 读屏用户没法「按住」：读屏的双击（activate）当开关用，双击一次开始说话、再双击一次结束
  const pttA11yAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName !== "activate") return;
    void (talking ? pttUp() : pttDown());
  };

  /** 一直开麦：点大按钮开 / 关麦克风 */
  const toggleMic = async () => {
    if (netDown) return;
    const next = !micOn;
    Haptics.impactAsync(
      next
        ? Haptics.ImpactFeedbackStyle.Medium
        : Haptics.ImpactFeedbackStyle.Light,
    ).catch(() => {});
    playCue(next ? "micOn" : "micOff");
    await trtc.current.muteLocalAudio(!next);
    setMicOn(next);
  };

  const switchToHold = async () => {
    if (mode === "hold") return;
    setMode("hold");
    setMicOn(false);
    if (micOn) playCue("micOff");
    await trtc.current.muteLocalAudio(true);
  };
  const enableOpen = async () => {
    if (myId) useIntercomStore.getState().markOpenMicSeen(myId);
    setSheet(null);
    setTalking(false);
    setMode("open");
    // 头盔断着的时候不替用户把手机的麦克风打开，等他自己点
    const on = !helmetDown;
    setMicOn(on);
    if (on) playCue("micOn");
    await trtc.current.muteLocalAudio(!on);
  };
  const switchToOpen = () => {
    if (mode === "open") return;
    // 第一次：先说清楚麦克风会一直开着（还没读到看没看过时也先说一遍）
    if (openMicSeen === true) void enableOpen();
    else setSheet({ kind: "openMic" });
  };

  // 关掉扬声器走的是手机听筒（TRTC_AUDIO_ROUTE_EARPIECE），不是耳机：原来写「耳机」，让人以为切到了头盔 / 耳机
  const toggleRoute = async () => {
    const next = !speakerOn;
    await trtc.current
      .getDeviceManager()
      .setAudioRoute(
        next
          ? TRTCCloudDef.TRTC_AUDIO_ROUTE_SPEAKER
          : TRTCCloudDef.TRTC_AUDIO_ROUTE_EARPIECE,
      );
    setSpeakerOn(next);
    showToast(
      translate("intercom.routeToast", {
        route: translate(next ? "intercom.speaker" : "intercom.earpiece"),
      }),
    );
  };

  const toggleMuteMember = async (id: string) => {
    const next = !muted[id];
    await trtc.current.muteRemoteAudio(id, next);
    setMuted((prev) => ({ ...prev, [id]: next }));
  };

  const isSpeaking = (id: string) =>
    (volumes[id] ?? 0) >= SPEAKING_THRESHOLD && !muted[id];

  const onlineCount = (inRoom ? 1 : 0) + onlineIds.length;
  const gridIds = [myId, ...onlineIds.filter((id) => id !== myId)];
  const hold = mode === "hold";
  // 大按钮「亮着」= 此刻别人听得到我
  const liveMic = hold ? talking : micOn;

  const title = (
    <ThemedText type="title" style={styles.pageTitle}>
      {t("intercom.title")}
    </ThemedText>
  );

  const banner = netDown
    ? t("intercom.banner.net")
    : helmetDown
      ? t(hold ? "intercom.banner.helmet" : "intercom.banner.helmetMuted")
      : null;

  const sheetTitle =
    sheet?.kind === "switch"
      ? t("intercom.switch.title")
      : sheet?.kind === "add"
        ? t("intercom.add.title")
        : sheet?.kind === "openMic"
          ? t("intercom.mode.open")
          : moreChannel
            ? channelNameOf(moreChannel.name)
            : "";
  const sheetLead =
    sheet?.kind === "switch"
      ? t("intercom.switch.lead")
      : sheet?.kind === "add"
        ? ""
        : sheet?.kind === "openMic"
          ? t("intercom.openMic.lead")
          : moreChannel
            ? t("intercom.more.lead", { n: moreChannel.memberCount })
            : "";

  const roomHeadBody = (
    <>
      <View
        style={[styles.roomTile, { backgroundColor: theme.backgroundSelected }]}
      >
        <Ionicons name="radio-outline" size={20} color={theme.brand} />
      </View>
      <View style={styles.channelBody}>
        <View style={styles.roomNameRow}>
          <ThemedText numberOfLines={1} style={styles.channelName}>
            {channel ? channelNameOf(channel.name) : ""}
          </ThemedText>
          {list.length > 1 && (
            <Ionicons
              name="chevron-down"
              size={16}
              color={theme.textSecondary}
            />
          )}
        </View>
        <View style={styles.onlineRow}>
          <View
            style={[
              styles.onlineDot,
              {
                backgroundColor: netDown ? theme.warning : theme.success,
              },
            ]}
          />
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.caption}
          >
            {netDown
              ? t("intercom.reconnecting")
              : t("intercom.onlineCount", { n: onlineCount })}
          </ThemedText>
        </View>
      </View>
    </>
  );

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.flex}>
        {inRoom ? (
          /* C. 房间里：频道名（可切换）+ 邀请 → 提示条 → 在线成员 → 说话方式 + 大按钮 */
          <>
            <View style={styles.roomHead}>
              {list.length > 1 ? (
                <Tappable
                  feedback="opacity"
                  accessibilityRole="button"
                  accessibilityLabel={t("intercom.switch.a11y", {
                    name: channel ? channelNameOf(channel.name) : "",
                  })}
                  onPress={() => setSheet({ kind: "switch" })}
                  style={styles.roomHeadMain}
                >
                  {roomHeadBody}
                </Tappable>
              ) : (
                // 只有一个频道时没有可换的：不是按钮，也没有下拉箭头
                <View style={styles.roomHeadMain}>{roomHeadBody}</View>
              )}
              {channel && (
                <Tappable
                  accessibilityRole="button"
                  accessibilityLabel={t("intercom.shareInvite")}
                  onPress={() => shareInvite(channel)}
                  style={styles.shareBtn}
                >
                  <Ionicons
                    name="share-outline"
                    size={18}
                    color={theme.brand}
                  />
                  <ThemedText type="smallBold" themeColor="brand">
                    {t("intercom.invite")}
                  </ThemedText>
                </Tappable>
              )}
            </View>

            {banner && (
              <Animated.View
                entering={FadeInDown.duration(200)}
                accessibilityRole="alert"
                style={[
                  styles.banner,
                  {
                    backgroundColor: theme.warningBg,
                    borderColor: theme.warning,
                  },
                ]}
              >
                <Ionicons name="alert-circle" size={20} color={theme.warning} />
                <ThemedText style={styles.bannerText}>{banner}</ThemedText>
              </Animated.View>
            )}

            <ScrollView
              style={styles.flex}
              contentContainerStyle={styles.grid}
              showsVerticalScrollIndicator={false}
            >
              {gridIds.map((id) => {
                const self = id === myId;
                return (
                  <MemberCell
                    key={id}
                    name={nameOf(id)}
                    speaking={self ? isSpeaking(id) || talking : isSpeaking(id)}
                    self={self}
                    muted={!!muted[id]}
                    micOpen={self && micOpen}
                    avatarUrl={avatarOf(id)}
                    onPress={self ? undefined : () => void toggleMuteMember(id)}
                  />
                );
              })}
            </ScrollView>

            {/* 说话方式：按住说话 / 一直开麦 */}
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel={t("intercom.mode.a11y")}
              style={[
                styles.modeSwitch,
                { backgroundColor: theme.backgroundSelected },
              ]}
            >
              {(["hold", "open"] as const).map((m) => {
                const on = mode === m;
                return (
                  <Pressable
                    key={m}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() =>
                      m === "hold" ? void switchToHold() : switchToOpen()
                    }
                    style={[
                      styles.modeSeg,
                      on && {
                        backgroundColor: dark
                          ? theme.borderStrong
                          : theme.backgroundElement,
                      },
                    ]}
                  >
                    <ThemedText
                      style={[
                        styles.modeText,
                        { color: on ? theme.text : theme.textSecondary },
                      ]}
                    >
                      {t(
                        m === "hold"
                          ? "intercom.holdToTalk"
                          : "intercom.mode.open",
                      )}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.bottomRow}>
              {/* 左：离开房间 */}
              {/* 整列（圆钮 + 下面的字）都是点击区：原来只有圆钮能点，点字没反应（2026-10-15） */}
              <Tappable
                haptic
                accessibilityRole="button"
                accessibilityLabel={t("intercom.leaveRoom")}
                onPress={leaveRoom}
                style={styles.sideCol}
              >
                <View
                  style={[
                    styles.roundBtn,
                    { backgroundColor: theme.backgroundSelected },
                  ]}
                >
                  <Ionicons name="exit-outline" size={20} color={theme.text} />
                </View>
                <ThemedText themeColor="textSecondary" style={styles.sideLabel}>
                  {t("intercom.leave")}
                </ThemedText>
              </Tappable>

              {/* 中：大按钮。按住说话 = 按着才开麦；一直开麦 = 点一下开 / 关。掉线时变淡、按了没反应 */}
              <View style={[styles.pttCol, netDown && styles.dimmed]}>
                <View style={styles.pttClip}>
                  <PulseRing
                    active={liveMic}
                    size={112}
                    color={theme.danger}
                    count={3}
                    duration={1400}
                    maxScale={1.4}
                  />
                  <Animated.View
                    style={[
                      styles.pttGlow,
                      {
                        backgroundColor: liveMic ? theme.danger : theme.brand,
                      },
                      pttGlowStyle,
                    ]}
                  />
                  <Animated.View style={pttPressStyle}>
                    {hold ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t("intercom.holdToTalk")}
                        accessibilityHint={t("intercom.ptt.a11yHint")}
                        accessibilityValue={
                          talking ? { text: t("intercom.talking") } : undefined
                        }
                        accessibilityActions={[{ name: "activate" }]}
                        onAccessibilityAction={pttA11yAction}
                        onPressIn={() => void pttDown()}
                        onPressOut={() => void pttUp()}
                        style={[
                          styles.ptt,
                          {
                            backgroundColor: talking
                              ? theme.danger
                              : theme.brand,
                            shadowColor: talking ? theme.danger : theme.brand,
                          },
                        ]}
                      >
                        <Ionicons
                          name="mic"
                          size={44}
                          color={talking ? "#fff" : theme.onBrand}
                        />
                      </Pressable>
                    ) : (
                      <Pressable
                        accessibilityRole="switch"
                        accessibilityState={{ checked: micOn }}
                        accessibilityLabel={t(
                          micOn
                            ? "intercom.micOn.a11y"
                            : "intercom.micOff.a11y",
                        )}
                        onPressIn={() =>
                          pttScale.set(
                            withSpring(0.92, { damping: 14, stiffness: 260 }),
                          )
                        }
                        onPressOut={() =>
                          pttScale.set(
                            withSpring(1, { damping: 12, stiffness: 200 }),
                          )
                        }
                        onPress={() => void toggleMic()}
                        style={[
                          styles.ptt,
                          micOn
                            ? {
                                backgroundColor: theme.danger,
                                shadowColor: theme.danger,
                              }
                            : {
                                backgroundColor: theme.backgroundSelected,
                                shadowColor: "transparent",
                              },
                        ]}
                      >
                        <Ionicons
                          name={micOn ? "mic" : "mic-off"}
                          size={44}
                          color={micOn ? "#fff" : theme.textSecondary}
                        />
                      </Pressable>
                    )}
                  </Animated.View>
                </View>
                <ThemedText
                  style={[
                    styles.pttLabel,
                    { color: liveMic ? theme.danger : theme.text },
                  ]}
                >
                  {netDown
                    ? t("intercom.reconnecting")
                    : hold
                      ? talking
                        ? t("intercom.talking")
                        : t("intercom.holdToTalk")
                      : t(micOn ? "intercom.micOn" : "intercom.micOff")}
                </ThemedText>
              </View>

              {/* 右：音频路由 */}
              <Tappable
                haptic
                accessibilityRole="button"
                accessibilityLabel={
                  speakerOn ? t("intercom.speaker") : t("intercom.earpiece")
                }
                onPress={() => void toggleRoute()}
                style={styles.sideCol}
              >
                <View
                  style={[
                    styles.roundBtn,
                    { backgroundColor: theme.backgroundSelected },
                  ]}
                >
                  <Ionicons
                    name={speakerOn ? "volume-high-outline" : "ear-outline"}
                    size={20}
                    color={theme.text}
                  />
                </View>
                <ThemedText themeColor="textSecondary" style={styles.sideLabel}>
                  {speakerOn ? t("intercom.speaker") : t("intercom.earpiece")}
                </ThemedText>
              </Tappable>
            </View>
            <ThemedText
              themeColor="textSecondary"
              numberOfLines={1}
              style={styles.talkCaption}
            >
              {netDown
                ? t("intercom.caption.net")
                : hold
                  ? t("intercom.caption.hold")
                  : t(
                      micOn
                        ? "intercom.caption.micOn"
                        : "intercom.caption.micOff",
                    )}
            </ThemedText>
          </>
        ) : channels.data === undefined ? (
          channels.isError ? (
            /* 频道列表没拉到：不能显示成「还没有频道」 */
            <>
              {title}
              <View style={styles.emptyWrap}>
                <View
                  style={[
                    styles.emptyIcon,
                    {
                      backgroundColor: theme.backgroundElement,
                      borderColor: theme.border,
                    },
                  ]}
                >
                  <Ionicons
                    name="cloud-offline-outline"
                    size={40}
                    color={theme.textSecondary}
                  />
                </View>
                <ThemedText style={styles.emptyTitle}>
                  {t("intercom.loadFailed")}
                </ThemedText>
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={styles.emptyBody}
                >
                  {t("intercom.loadFailedBody")}
                </ThemedText>
              </View>
              <View style={styles.bottomActions}>
                <SecondaryButton
                  title={t("intercom.retry")}
                  onPress={() => void channels.refetch()}
                />
              </View>
            </>
          ) : (
            <>
              {title}
              <View style={styles.lobbyList}>
                {[0, 1].map((i) => (
                  <Skeleton key={i} height={76} radius={Radius.card} />
                ))}
              </View>
            </>
          )
        ) : list.length === 0 ? (
          /* A. 无频道:空态 + 底部创建/加入 */
          <>
            {title}
            <View style={styles.emptyWrap}>
              <View
                style={[
                  styles.emptyIcon,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
              >
                <Ionicons name="radio-outline" size={40} color={theme.brand} />
              </View>
              <ThemedText style={styles.emptyTitle}>
                {t("intercom.emptyTitle")}
              </ThemedText>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.emptyBody}
              >
                {t("intercom.emptyBody")}
              </ThemedText>
            </View>
            <View style={styles.bottomActions}>
              <PrimaryButton
                title={t("intercom.create")}
                icon="add"
                onPress={() => setCreateOpen(true)}
              />
              <SecondaryButton
                title={t("intercom.joinWithCode")}
                icon="key-outline"
                onPress={() => setJoinOpen(true)}
              />
            </View>
          </>
        ) : (
          /* B. 频道列表：我加入的所有频道，同一时间只进一个 */
          <>
            <View style={styles.lobbyHead}>
              {title}
              <Tappable
                feedback="opacity"
                accessibilityRole="button"
                accessibilityLabel={t("intercom.add.a11y")}
                onPress={() => setSheet({ kind: "add" })}
                style={[
                  styles.addButton,
                  {
                    borderColor: theme.borderStrong,
                    backgroundColor: theme.backgroundElement,
                  },
                ]}
              >
                <Ionicons name="add" size={24} color={theme.text} />
              </Tappable>
            </View>
            <ScrollView
              style={styles.flex}
              contentContainerStyle={styles.lobbyList}
              showsVerticalScrollIndicator={false}
            >
              {list.map((c, i) => {
                const busy = joining && activeId === c.channelId;
                return (
                  <View
                    key={c.channelId}
                    style={[
                      styles.chanCard,
                      {
                        backgroundColor: theme.backgroundElement,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.channelTile,
                        { backgroundColor: theme.backgroundSelected },
                      ]}
                    >
                      <Ionicons
                        name="radio-outline"
                        size={22}
                        color={theme.text}
                      />
                    </View>
                    <View style={styles.channelBody}>
                      <ThemedText numberOfLines={1} style={styles.chanName}>
                        {channelNameOf(c.name)}
                      </ThemedText>
                      <ThemedText
                        type="small"
                        themeColor="textSecondary"
                        numberOfLines={1}
                        style={styles.caption}
                      >
                        {t("intercom.memberTotal", { n: c.memberCount })}
                      </ThemedText>
                    </View>
                    <Tappable
                      feedback="opacity"
                      accessibilityRole="button"
                      accessibilityLabel={t("intercom.more.a11y", {
                        name: channelNameOf(c.name),
                      })}
                      onPress={() =>
                        setSheet({ kind: "more", channelId: c.channelId })
                      }
                      style={styles.moreBtn}
                    >
                      <Ionicons
                        name="ellipsis-horizontal"
                        size={20}
                        color={theme.textSecondary}
                      />
                    </Tappable>
                    <Tappable
                      feedback="scale"
                      haptic
                      accessibilityRole="button"
                      accessibilityLabel={t("intercom.enter.a11y", {
                        name: channelNameOf(c.name),
                      })}
                      disabled={joining && !busy}
                      onPress={() => void join(c)}
                      // 只有第一个是品牌色：一页一个主操作
                      style={[
                        styles.enterBtn,
                        i === 0
                          ? {
                              backgroundColor: theme.brand,
                              borderColor: theme.brand,
                            }
                          : { borderColor: theme.borderStrong },
                      ]}
                    >
                      {busy ? (
                        <DotsLoader
                          color={i === 0 ? theme.onBrand : theme.text}
                        />
                      ) : (
                        <ThemedText
                          style={[
                            styles.enterText,
                            { color: i === 0 ? theme.onBrand : theme.text },
                          ]}
                        >
                          {t("intercom.enter")}
                        </ThemedText>
                      )}
                    </Tappable>
                  </View>
                );
              })}
            </ScrollView>
            {joinError && (
              <ThemedText
                type="small"
                themeColor="danger"
                style={[styles.centerText, styles.joinError]}
              >
                {joinError}
              </ThemedText>
            )}
          </>
        )}

        {/* 底部面板：切换频道 / 新建或加入 / 某个频道的更多 / 一直开麦的说明 */}
        <Modal
          visible={sheet !== null}
          transparent
          statusBarTranslucent
          animationType="fade"
          onRequestClose={() => setSheet(null)}
        >
          <View style={styles.sheetMask}>
            <Pressable
              accessibilityLabel={t("intercom.sheet.close")}
              style={StyleSheet.absoluteFill}
              onPress={() => setSheet(null)}
            />
            <Animated.View
              entering={FadeInDown.duration(220)}
              accessibilityViewIsModal
              style={[
                styles.sheet,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                  paddingBottom: Math.max(insets.bottom, 12) + 8,
                },
              ]}
            >
              <View style={styles.sheetHead}>
                <ThemedText
                  numberOfLines={1}
                  accessibilityRole="header"
                  style={styles.sheetTitle}
                >
                  {sheetTitle}
                </ThemedText>
                <Tappable
                  feedback="opacity"
                  accessibilityRole="button"
                  accessibilityLabel={t("intercom.sheet.close")}
                  onPress={() => setSheet(null)}
                  style={[
                    styles.sheetClose,
                    { backgroundColor: theme.backgroundSelected },
                  ]}
                >
                  <Ionicons name="close" size={20} color={theme.text} />
                </Tappable>
              </View>
              {sheetLead ? (
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={styles.sheetLead}
                >
                  {sheetLead}
                </ThemedText>
              ) : (
                <View style={styles.sheetLeadGap} />
              )}

              {sheet?.kind === "switch" && (
                <>
                  {list.map((c) => {
                    const here = c.channelId === activeId;
                    return (
                      <Tappable
                        key={c.channelId}
                        feedback="fill"
                        accessibilityRole="button"
                        accessibilityState={{ selected: here }}
                        onPress={() => switchTo(c)}
                        style={[
                          styles.sheetRow,
                          {
                            borderColor: here
                              ? theme.borderStrong
                              : theme.border,
                          },
                          here && {
                            backgroundColor: theme.backgroundSelected,
                          },
                        ]}
                      >
                        <View style={styles.channelBody}>
                          <ThemedText
                            numberOfLines={1}
                            style={styles.sheetRowTitle}
                          >
                            {channelNameOf(c.name)}
                          </ThemedText>
                          <ThemedText
                            type="small"
                            themeColor="textSecondary"
                            style={styles.caption}
                          >
                            {here
                              ? t("intercom.switch.here")
                              : t("intercom.memberTotal", { n: c.memberCount })}
                          </ThemedText>
                        </View>
                        {here && (
                          <Ionicons
                            name="checkmark"
                            size={22}
                            color={theme.text}
                          />
                        )}
                      </Tappable>
                    );
                  })}
                  <SecondaryButton
                    title={t("intercom.add.a11y")}
                    onPress={() => setSheet({ kind: "add" })}
                  />
                </>
              )}

              {sheet?.kind === "add" && (
                <>
                  <Tappable
                    feedback="fill"
                    accessibilityRole="button"
                    onPress={() => {
                      setSheet(null);
                      setCreateOpen(true);
                    }}
                    style={[styles.sheetRow, { borderColor: theme.border }]}
                  >
                    <View
                      style={[
                        styles.sheetRowIcon,
                        { backgroundColor: theme.backgroundSelected },
                      ]}
                    >
                      <Ionicons name="add" size={20} color={theme.text} />
                    </View>
                    <View style={styles.channelBody}>
                      <ThemedText style={styles.sheetRowTitle}>
                        {t("intercom.add.create")}
                      </ThemedText>
                    </View>
                  </Tappable>
                  <Tappable
                    feedback="fill"
                    accessibilityRole="button"
                    onPress={() => {
                      setSheet(null);
                      setJoinOpen(true);
                    }}
                    style={[styles.sheetRow, { borderColor: theme.border }]}
                  >
                    <View
                      style={[
                        styles.sheetRowIcon,
                        { backgroundColor: theme.backgroundSelected },
                      ]}
                    >
                      <Ionicons
                        name="key-outline"
                        size={20}
                        color={theme.text}
                      />
                    </View>
                    <View style={styles.channelBody}>
                      <ThemedText style={styles.sheetRowTitle}>
                        {t("intercom.add.join")}
                      </ThemedText>
                    </View>
                  </Tappable>
                </>
              )}

              {sheet?.kind === "more" && moreChannel && (
                <>
                  {/* 这个频道里都有谁（含不在线的）：原先在进房前的页面上，现在收在这里 */}
                  <ScrollView
                    style={styles.sheetMembers}
                    showsVerticalScrollIndicator={false}
                  >
                    {(members.data ?? []).map((m) => {
                      const self = m.userId === myId;
                      const display = self
                        ? nameOf(myId)
                        : personNameOf(m, m.userId.slice(-4));
                      return (
                        <View key={m.userId} style={styles.memberRow}>
                          {m.avatarUrl ? (
                            <Image
                              source={{ uri: m.avatarUrl }}
                              style={styles.memberAvatar}
                            />
                          ) : (
                            <View
                              style={[
                                styles.memberAvatar,
                                { backgroundColor: theme.backgroundSelected },
                              ]}
                            >
                              <ThemedText type="smallBold">
                                {avatarInitial(display)}
                              </ThemedText>
                            </View>
                          )}
                          <ThemedText
                            numberOfLines={1}
                            style={styles.memberName}
                          >
                            {display}
                            {self && (
                              <ThemedText
                                themeColor="textSecondary"
                                style={styles.memberName}
                              >
                                {` (${t("intercom.me")})`}
                              </ThemedText>
                            )}
                          </ThemedText>
                        </View>
                      );
                    })}
                  </ScrollView>
                  <Tappable
                    feedback="fill"
                    accessibilityRole="button"
                    onPress={() => shareInvite(moreChannel)}
                    style={[styles.sheetRow, { borderColor: theme.border }]}
                  >
                    <ThemedText style={[styles.sheetRowTitle, styles.flex]}>
                      {t("intercom.shareInvite")}
                    </ThemedText>
                    <ThemedText
                      themeColor="textSecondary"
                      style={styles.inviteCode}
                    >
                      {moreChannel.inviteCode}
                    </ThemedText>
                  </Tappable>
                  <Tappable
                    feedback="fill"
                    accessibilityRole="button"
                    onPress={() => leaveChannel(moreChannel)}
                    style={[styles.sheetRow, { borderColor: theme.border }]}
                  >
                    <ThemedText
                      style={[styles.sheetRowTitle, { color: theme.warning }]}
                    >
                      {t("intercom.more.quit")}
                    </ThemedText>
                  </Tappable>
                </>
              )}

              {sheet?.kind === "openMic" && (
                <View style={styles.sheetActions}>
                  <PrimaryButton
                    title={t("intercom.openMic.confirm")}
                    onPress={() => void enableOpen()}
                  />
                  <SecondaryButton
                    title={t("intercom.openMic.later")}
                    onPress={() => setSheet(null)}
                  />
                </View>
              )}
            </Animated.View>
          </View>
        </Modal>

        {/* 创建频道弹层 */}
        <Modal
          visible={createOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setCreateOpen(false)}
        >
          <KeyboardAvoid>
            <Pressable
              // 遮罩只负责「点空白处关闭」，不能自成一个读屏焦点（会把整张卡片合成一块）
              accessible={false}
              style={styles.modalMask}
              onPress={() => setCreateOpen(false)}
            >
              <Animated.View entering={FadeInDown.duration(200)}>
                <Pressable
                  style={[
                    styles.modalCard,
                    {
                      backgroundColor: theme.backgroundElement,
                      borderColor: theme.border,
                    },
                  ]}
                  // 只用来挡住「点卡片关弹层」；不能自成一个读屏焦点，否则里面的选项 / 输入框被合成一块、读屏选不中
                  accessible={false}
                  onPress={() => undefined}
                >
                  <ThemedText style={styles.modalTitle}>
                    {t("intercom.create")}
                  </ThemedText>
                  <FormInput
                    label={t("intercom.channelName")}
                    value={nameDraft}
                    onChangeText={setNameDraft}
                    placeholder={t("intercom.channelNamePlaceholder")}
                    maxLength={30}
                    autoFocus
                  />
                  <PrimaryButton
                    title={t("intercom.createAction")}
                    onPress={submitCreate}
                    disabled={!createName}
                    loading={submitting}
                  />
                </Pressable>
              </Animated.View>
            </Pressable>
          </KeyboardAvoid>
        </Modal>

        {/* 邀请码加入弹层 */}
        <Modal
          visible={joinOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setJoinOpen(false)}
        >
          <KeyboardAvoid>
            <Pressable
              // 遮罩只负责「点空白处关闭」，不能自成一个读屏焦点（会把整张卡片合成一块）
              accessible={false}
              style={styles.modalMask}
              onPress={() => setJoinOpen(false)}
            >
              <Animated.View entering={FadeInDown.duration(200)}>
                <Pressable
                  style={[
                    styles.modalCard,
                    {
                      backgroundColor: theme.backgroundElement,
                      borderColor: theme.border,
                    },
                  ]}
                  // 只用来挡住「点卡片关弹层」；不能自成一个读屏焦点，否则里面的选项 / 输入框被合成一块、读屏选不中
                  accessible={false}
                  onPress={() => undefined}
                >
                  <ThemedText style={styles.modalTitle}>
                    {t("intercom.joinWithCode")}
                  </ThemedText>
                  <FormInput
                    label={t("intercom.inviteCode")}
                    value={codeDraft}
                    // 粘进来一整句分享文案时直接换成里面的邀请码（原来 maxLength=6 把它截成「加入我的骑行」）
                    onChangeText={(v) => setCodeDraft(inviteCodeFrom(v) ?? v)}
                    placeholder={t("intercom.inviteCodePlaceholder")}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    autoComplete="off"
                    maxLength={200}
                    autoFocus
                  />
                  <PrimaryButton
                    title={t("intercom.join")}
                    onPress={submitJoin}
                    loading={submitting}
                  />
                </Pressable>
              </Animated.View>
            </Pressable>
          </KeyboardAvoid>
        </Modal>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, paddingHorizontal: 20 },
  pageTitle: { fontSize: 32, lineHeight: 38, marginTop: 8 },
  centerText: { textAlign: "center" },
  caption: { fontSize: 13, lineHeight: 18 },

  // A. 空态
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  emptyIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  emptyTitle: { fontSize: 20, lineHeight: 26, fontWeight: 600 },
  emptyBody: { textAlign: "center" },
  bottomActions: { paddingTop: 8, paddingBottom: 22, gap: 10 },

  // B. 频道列表
  lobbyHead: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  lobbyList: { gap: 10, paddingTop: 14, paddingBottom: 8 },
  chanCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 76,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 12,
    borderRadius: Radius.card,
    borderWidth: 1,
  },
  channelTile: {
    width: 44,
    height: 44,
    borderRadius: Radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  channelBody: { flex: 1, gap: 2, minWidth: 0 },
  chanName: { fontSize: 16, lineHeight: 22, fontWeight: 700 },
  moreBtn: {
    width: 40,
    height: 44,
    marginHorizontal: -6,
    alignItems: "center",
    justifyContent: "center",
  },
  enterBtn: {
    width: 76,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  enterText: { fontSize: 15, lineHeight: 20, fontWeight: 700 },
  joinError: { paddingBottom: 12 },

  // C. 房间里：头部
  roomHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 48,
    marginTop: 8,
  },
  roomHeadMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
  },
  roomTile: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  roomNameRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  channelName: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: 700,
    flexShrink: 1,
  },
  onlineRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  onlineDot: { width: 7, height: 7, borderRadius: 4 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 52,
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: Radius.control,
    borderWidth: 1,
  },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: 500 },
  inviteCode: {
    fontFamily: Fonts.mono,
    fontSize: 16,
    lineHeight: 22,
    letterSpacing: 2,
    fontWeight: 600,
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingLeft: 8,
  },

  // 「更多」面板里的成员列表
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    height: 48,
  },
  memberAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  memberName: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: 500 },

  // C. 房间里：成员网格
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: 12,
    paddingTop: 18,
    paddingBottom: 8,
  },
  cell: { width: "25%", alignItems: "center", gap: 6 },
  cellRingBox: {
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  cellAvatarRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  cellAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  cellMuteBadge: {
    position: "absolute",
    right: -4,
    bottom: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  cellName: {
    fontSize: 13,
    lineHeight: 18,
    maxWidth: "100%",
    paddingHorizontal: 4,
  },
  cellSlot: {
    height: 22,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
  },
  // 一格只有屏宽的四分之一：「麦克风已开启」「Microphone on」在 360dp 宽的手机上放不下，
  // 原来折成两行、第二行被 20 高的药丸切掉（2026-10-15 华为）。限宽到格子、单行缩字
  speakPill: {
    height: 20,
    maxWidth: "100%",
    borderRadius: Radius.pill,
    paddingHorizontal: 6,
    justifyContent: "center",
  },
  speakPillText: { fontSize: 11, lineHeight: 14, fontWeight: 600 },

  // 说话方式切换
  modeSwitch: {
    flexDirection: "row",
    alignSelf: "center",
    width: 264,
    padding: 3,
    borderRadius: 25,
  },
  modeSeg: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  modeText: { fontSize: 14, lineHeight: 20, fontWeight: 700 },
  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 6,
  },
  dimmed: { opacity: 0.4 },
  talkCaption: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    paddingBottom: 12,
  },
  sideCol: { width: 72, alignItems: "center", gap: 6 },
  roundBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  sideLabel: { fontSize: 12, lineHeight: 16 },
  pttCol: { alignItems: "center", gap: 2 },
  pttClip: {
    width: 160,
    height: 160,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  pttGlow: {
    position: "absolute",
    width: 108,
    height: 108,
    borderRadius: 54,
    opacity: 0.35,
  },
  ptt: {
    width: 112,
    height: 112,
    borderRadius: 56,
    alignItems: "center",
    justifyContent: "center",
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  pttLabel: { fontSize: 13, lineHeight: 18, fontWeight: 600 },

  // 底部面板
  sheetMask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
    padding: 10,
  },
  sheet: {
    borderRadius: 24,
    borderWidth: 1,
    paddingTop: 18,
    paddingHorizontal: 20,
    maxHeight: "80%",
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sheetTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: 700,
  },
  sheetClose: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetLead: { fontSize: 13, lineHeight: 19, marginTop: 6, marginBottom: 14 },
  sheetLeadGap: { height: 14 },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  sheetRowIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetRowTitle: { fontSize: 15, lineHeight: 20, fontWeight: 700 },
  sheetMembers: { maxHeight: 200, flexGrow: 0, marginBottom: 12 },
  sheetActions: { gap: 10 },

  // 弹层
  modalMask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: 28,
  },
  modalCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  modalTitle: { fontSize: 20, lineHeight: 26, fontWeight: 600 },
});
