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
// 照原样保留的（负责人 2026-10-07 点名）：按住说话的按压回弹与震动、成员说话时的波纹和亮圈、
// 邀请码走系统分享面板、点成员头像对我静音、退出频道前的确认、音频输出切换、新建频道 / 输入邀请码两个弹层。
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
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
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { translate, useT } from "@/i18n";
import { playCue, prepareCues } from "@/services/intercom-cues";
import { useAuthStore } from "@/stores/auth-store";
import { useBleStore } from "@/stores/ble-store";
import { useIntercomStore } from "@/stores/intercom-store";
import { showNotice } from "@/services/notice";

const SPEAKING_THRESHOLD = 10; // onUserVoiceVolume 0–100
/** 屏幕常亮的标记：只管对讲页自己开的这一份，不影响地图页开的 */
const KEEP_AWAKE_TAG = "intercom";

type TalkMode = "hold" | "open";
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
                {name.slice(0, 1).toUpperCase()}
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
    <Tappable onPress={onPress} style={styles.cell}>
      {body}
    </Tappable>
  ) : (
    <View style={styles.cell}>{body}</View>
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
  /** 正在进 / 已经在里面的那个频道 */
  const [activeId, setActiveId] = useState<string | null>(null);
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
  const live = useRef({ inRoom, mode, micOn, talking });
  useEffect(() => {
    live.current = { inRoom, mode, micOn, talking };
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
  const channel = list.find((c) => c.channelId === activeId) ?? null;
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
    if (id === myId) return user?.nickname ?? user?.phone ?? t("intercom.me");
    const m = memberMap.get(id);
    return m?.nickname ?? m?.phone ?? id.slice(-4);
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

  useEffect(() => {
    const cloud = trtc.current;
    // 监听器内用 translate 而非 t：避免语言切换时重注册监听并触发 cleanup 的 exitRoom
    const listener = (type: TRTCCloudListener, params: any) => {
      switch (type) {
        case TRTCCloudListener.onEnterRoom:
          if (joinTimer.current) clearTimeout(joinTimer.current);
          joinTimer.current = null;
          setInRoom(params.result >= 0);
          setJoining(false);
          setJoinError(
            params.result >= 0
              ? null
              : translate("intercom.joinFailed", { code: params.result }),
          );
          if (params.result >= 0) {
            prepareCues();
            playCue("enter");
            Haptics.notificationAsync(
              Haptics.NotificationFeedbackType.Success,
            ).catch(() => {});
          }
          break;
        case TRTCCloudListener.onExitRoom:
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
          break;
        case TRTCCloudListener.onRemoteUserEnterRoom:
          setOnlineIds((prev) =>
            prev.includes(params.userId) ? prev : [...prev, params.userId],
          );
          playCue("join");
          // 有人进房但档案可能还没拉到 → 立刻刷新成员列表
          void queryClient.invalidateQueries({ queryKey: ["voice-members"] });
          break;
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
          setNetDown(true);
          break;
        case TRTCCloudListener.onConnectionRecovery:
          setNetDown(false);
          playCue("back");
          showToast(translate("intercom.reconnected"));
          break;
      }
    };
    cloud.registerListener(listener);
    return () => {
      if (joinTimer.current) clearTimeout(joinTimer.current);
      joinTimer.current = null;
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
  const sessionName = channel?.name;
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

  // 按住说话时要随时够得着按钮：停在这一页就不让屏幕熄。一直开麦不需要看屏幕，可以锁屏
  const keepAwake = inRoom && mode === "hold" && focused;
  useEffect(() => {
    if (!keepAwake) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [keepAwake]);

  const join = async (channelId: string) => {
    if (joining) return;
    if (Platform.OS === "android") {
      const res = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (res !== PermissionsAndroid.RESULTS.GRANTED) {
        // 拒了不能静默退回列表（2026-10-15）：说清为什么没进去、去哪开
        setJoinError(translate("intercom.micDenied"));
        return;
      }
    }
    setActiveId(channelId);
    setJoining(true);
    setJoinError(null);
    // 原生 TRTC 单例跨 JS 重载存活:先幂等退房清场,避免 -3340 already in room。
    // 从另一个频道切过来也靠这一步先离开原来的房间
    try {
      await trtc.current.exitRoom();
    } catch {}
    // 进房兜底超时:回调丢失时 8s 后解除"进入中"
    clearJoinTimer();
    joinTimer.current = setTimeout(() => {
      joinTimer.current = null;
      setJoining((j) => {
        if (j) setJoinError(translate("intercom.joinTimeout"));
        return false;
      });
    }, 8000);
    try {
      // UserSig 服务端签发（决策 #27⑥）,App 端不再持有 TRTC SecretKey
      const tk = await channelsApi.token(channelId);
      const params = new TRTCParams({
        sdkAppId: tk.sdkAppId,
        userId: tk.userId,
        userSig: tk.userSig,
        roomId: tk.roomId,
        // 房间权限钥匙（决策 #56）：凭证只对这个房间有效，别人拿着自己频道的凭证进不来
        privateMapKey: tk.privateMapKey,
      });
      await trtc.current.enterRoom(
        params,
        TRTCCloudDef.TRTC_APP_SCENE_AUDIOCALL,
      );
      await trtc.current.startLocalAudio(
        TRTCCloudDef.TRTC_AUDIO_QUALITY_SPEECH,
      );
      await trtc.current.muteLocalAudio(true);
      // 发言指示环所需：每 300ms 回调一次成员音量
      await trtc.current.enableAudioVolumeEvaluation(300);
    } catch (e) {
      clearJoinTimer();
      setJoining(false);
      setJoinError(toUserMessage(e));
    }
  };

  const leaving = useRef(false);
  const leaveRoom = () => {
    if (leaving.current) return;
    leaving.current = true;
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
    if (channel) showToast(t("intercom.leftRoom", { name: channel.name }));
    void join(next.channelId);
  };

  const leaveChannel = (c: VoiceChannel) => {
    Alert.alert(
      t("intercom.leaveChannel"),
      t("intercom.leaveChannelBody", { name: c.name }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("intercom.leaveConfirm"),
          style: "destructive",
          onPress: () => {
            setSheet(null);
            if (inRoom && activeId === c.channelId)
              void trtc.current.exitRoom();
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
        name: c.name,
        code: c.inviteCode,
      }),
    });
  };

  const submitCreate = () => {
    if (!nameDraft.trim()) return;
    setSubmitting(true);
    channelsApi
      .create({ name: nameDraft.trim() })
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
        route: translate(next ? "intercom.speaker" : "intercom.headset"),
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
          : (moreChannel?.name ?? "");
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
            {channel?.name ?? ""}
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
                    name: channel?.name ?? "",
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
                  speakerOn ? t("intercom.speaker") : t("intercom.headset")
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
                    name={speakerOn ? "volume-high-outline" : "headset-outline"}
                    size={20}
                    color={theme.text}
                  />
                </View>
                <ThemedText themeColor="textSecondary" style={styles.sideLabel}>
                  {speakerOn ? t("intercom.speaker") : t("intercom.headset")}
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
                        {c.name}
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
                        name: c.name,
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
                        name: c.name,
                      })}
                      disabled={joining && !busy}
                      onPress={() => void join(c.channelId)}
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
                            {c.name}
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
                        : (m.nickname ?? m.phone);
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
                                {display.slice(0, 1).toUpperCase()}
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
