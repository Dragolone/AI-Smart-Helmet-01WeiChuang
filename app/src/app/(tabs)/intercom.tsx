// 对讲（底部标签）：后端频道体系（API.md §13,#43）+ TRTC 语音（决策 #22/#27⑤⑥）。
// 频道创建/邀请码加入/成员档案(昵称头像)走后端;UserSig 由服务端签发,App 不持有 TRTC 密钥。
// 2026-09-10 重设计：三态（无频道 / 有频道未进房 / 房内），房内为 4 列成员网格 + 底部固定 PTT 行。
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useEffect, useMemo, useRef, useState } from 'react';
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
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { FadeInDown,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import TRTCCloud, {
  TRTCCloudDef,
  TRTCCloudListener,
  TRTCParams,
} from 'trtc-react-native';
import type { VoiceChannelMemberPublic } from '@helmet/shared';

import { channelsApi } from '@/api/channels';
import { toUserMessage } from '@/api/error-messages';
import { FormInput, PrimaryButton, SecondaryButton } from '@/components/form';
import { Card, GroupTitle } from '@/components/list';
import { PulseRing } from '@/components/pulse-ring';
import { Tappable } from '@/components/tappable';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { showToast } from '@/components/toast';
import { Fonts, Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { translate, useT } from '@/i18n';
import { useAuthStore } from '@/stores/auth-store';

const SPEAKING_THRESHOLD = 10; // onUserVoiceVolume 0–100

/** 房内成员网格单元：56 头像 + 发言环/波纹 + 名字 + 22px 状态槽 */
function MemberCell({
  name,
  speaking,
  self = false,
  muted = false,
  avatarUrl,
  onPress,
}: {
  name: string;
  speaking: boolean;
  self?: boolean;
  muted?: boolean;
  avatarUrl?: string | null;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const t = useT();
  const body = (
    <>
      <View style={styles.cellRingBox}>
        <PulseRing active={speaking} size={64} color={theme.brand} maxScale={1.3} />
        <View
          style={[
            styles.cellAvatarRing,
            { borderColor: speaking ? theme.brand : 'transparent' },
          ]}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.cellAvatar} />
          ) : (
            <View style={[styles.cellAvatar, { backgroundColor: theme.backgroundSelected }]}>
              <ThemedText type="smallBold" style={{ fontSize: 18 }}>
                {name.slice(0, 1).toUpperCase()}
              </ThemedText>
            </View>
          )}
          {muted && (
            <View style={[styles.cellMuteBadge, { backgroundColor: theme.danger }]}>
              <Ionicons name="volume-mute" size={11} color="#fff" />
            </View>
          )}
        </View>
      </View>
      <ThemedText numberOfLines={1} style={styles.cellName}>
        {name}
        {self && (
          <ThemedText themeColor="textSecondary" style={styles.cellName}>
            {` (${t('intercom.me')})`}
          </ThemedText>
        )}
      </ThemedText>
      <View style={styles.cellSlot}>
        {speaking && (
          <View style={[styles.speakPill, { backgroundColor: theme.brand }]}>
            <ThemedText style={[styles.speakPillText, { color: theme.onBrand }]}>
              {t('intercom.speaking')}
            </ThemedText>
          </View>
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
  const t = useT();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const trtc = useRef(TRTCCloud.sharedInstance());
  const [inRoom, setInRoom] = useState(false);
  const [talking, setTalking] = useState(false);
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
  const [nameDraft, setNameDraft] = useState('');
  const [codeDraft, setCodeDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // TRTC userId = 后端用户 id（token 接口签发口径）
  const myId = user?.id ?? '';

  const channels = useQuery({
    queryKey: ['voice-channels'],
    queryFn: channelsApi.list,
  });
  const channel = channels.data?.[0] ?? null;

  const members = useQuery({
    queryKey: ['voice-members', channel?.channelId],
    queryFn: () => channelsApi.members(channel!.channelId),
    enabled: !!channel,
    // 新成员的档案(昵称/头像)15s 内出现;实时"在房"由 TRTC 事件驱动
    refetchInterval: 15_000,
  });

  const memberMap = useMemo(() => {
    const map = new Map<string, VoiceChannelMemberPublic>();
    for (const m of members.data ?? []) map.set(m.userId, m);
    return map;
  }, [members.data]);

  const nameOf = (id: string) => {
    if (id === myId) return user?.nickname ?? user?.phone ?? t('intercom.me');
    const m = memberMap.get(id);
    return m?.nickname ?? m?.phone ?? id.slice(-4);
  };
  const avatarOf = (id: string) =>
    id === myId ? user?.avatarUrl : memberMap.get(id)?.avatarUrl;

  useEffect(() => {
    const cloud = trtc.current;
    // 监听器内用 translate 而非 t：避免语言切换时重注册监听并触发 cleanup 的 exitRoom
    const listener = (type: TRTCCloudListener, params: any) => {
      switch (type) {
        case TRTCCloudListener.onEnterRoom:
          setInRoom(params.result >= 0);
          setJoining(false);
          setJoinError(
            params.result >= 0
              ? null
              : translate('intercom.joinFailed', { code: params.result }),
          );
          break;
        case TRTCCloudListener.onExitRoom:
          setInRoom(false);
          setOnlineIds([]);
          setVolumes({});
          setMuted({});
          break;
        case TRTCCloudListener.onRemoteUserEnterRoom:
          setOnlineIds((prev) =>
            prev.includes(params.userId) ? prev : [...prev, params.userId],
          );
          // 有人进房但档案可能还没拉到 → 立刻刷新成员列表
          void queryClient.invalidateQueries({ queryKey: ['voice-members'] });
          break;
        case TRTCCloudListener.onRemoteUserLeaveRoom:
          setOnlineIds((prev) => prev.filter((m) => m !== params.userId));
          break;
        case TRTCCloudListener.onUserVoiceVolume: {
          // userId 为空串 = 本端；音量 0–100
          const next: Record<string, number> = {};
          for (const v of params.userVolumes ?? []) {
            next[v.userId === '' ? myId : v.userId] = v.volume;
          }
          setVolumes(next);
          break;
        }
      }
    };
    cloud.registerListener(listener);
    return () => {
      cloud.unRegisterListener(listener);
      cloud.exitRoom();
    };
  }, [myId, queryClient]);

  const join = async () => {
    if (!channel) return;
    if (Platform.OS === 'android') {
      const res = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (res !== PermissionsAndroid.RESULTS.GRANTED) return;
    }
    setJoining(true);
    setJoinError(null);
    // 原生 TRTC 单例跨 JS 重载存活:先幂等退房清场,避免 -3340 already in room
    try {
      await trtc.current.exitRoom();
    } catch {}
    // 进房兜底超时:回调丢失时 8s 后解除"进入中"
    setTimeout(() => {
      setJoining((j) => {
        if (j) setJoinError(translate('intercom.joinTimeout'));
        return false;
      });
    }, 8000);
    try {
      // UserSig 服务端签发（决策 #27⑥）,App 端不再持有 TRTC SecretKey
      const tk = await channelsApi.token(channel.channelId);
      const params = new TRTCParams({
        sdkAppId: tk.sdkAppId,
        userId: tk.userId,
        userSig: tk.userSig,
        roomId: tk.roomId,
      });
      await trtc.current.enterRoom(params, TRTCCloudDef.TRTC_APP_SCENE_AUDIOCALL);
      await trtc.current.startLocalAudio(TRTCCloudDef.TRTC_AUDIO_QUALITY_SPEECH);
      await trtc.current.muteLocalAudio(true);
      // 发言指示环所需：每 300ms 回调一次成员音量
      await trtc.current.enableAudioVolumeEvaluation(300);
    } catch (e) {
      setJoining(false);
      setJoinError(toUserMessage(e));
    }
  };

  const leaveRoom = () => void trtc.current.exitRoom();

  const leaveChannel = () => {
    if (!channel) return;
    Alert.alert(
      t('intercom.leaveChannel'),
      t('intercom.leaveChannelBody', { name: channel.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('intercom.leaveConfirm'),
          style: 'destructive',
          onPress: () => {
            leaveRoom();
            channelsApi
              .leave(channel.channelId)
              .then(() => queryClient.invalidateQueries({ queryKey: ['voice-channels'] }))
              .catch((e) => Alert.alert(t('intercom.leaveFailed'), toUserMessage(e)));
          },
        },
      ],
    );
  };

  const shareInvite = () => {
    if (!channel) return;
    void Share.share({
      message: t('intercom.shareMessage', { name: channel.name, code: channel.inviteCode }),
    });
  };

  const submitCreate = () => {
    if (!nameDraft.trim()) return;
    setSubmitting(true);
    channelsApi
      .create({ name: nameDraft.trim() })
      .then(() => {
        setCreateOpen(false);
        setNameDraft('');
        return queryClient.invalidateQueries({ queryKey: ['voice-channels'] });
      })
      .catch((e) => Alert.alert(t('intercom.createFailed'), toUserMessage(e)))
      .finally(() => setSubmitting(false));
  };

  const submitJoin = () => {
    if (!/^\d{6}$/.test(codeDraft.trim())) {
      Alert.alert(t('intercom.inviteCode'), t('intercom.inviteCodeFormat'));
      return;
    }
    setSubmitting(true);
    channelsApi
      .join({ inviteCode: codeDraft.trim() })
      .then(() => {
        setJoinOpen(false);
        setCodeDraft('');
        return queryClient.invalidateQueries({ queryKey: ['voice-channels'] });
      })
      .catch((e) => Alert.alert(t('intercom.joinError'), toUserMessage(e)))
      .finally(() => setSubmitting(false));
  };

  // 按下/松开都给触觉确认:骑行戴手套看不清屏幕,靠震动知道开没开麦
  const pttDown = async () => {
    pttScale.set(withSpring(0.92, { damping: 14, stiffness: 260 }));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    await trtc.current.muteLocalAudio(false);
    setTalking(true);
  };
  const pttUp = async () => {
    pttScale.set(withSpring(1, { damping: 12, stiffness: 200 }));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await trtc.current.muteLocalAudio(true);
    setTalking(false);
  };

  const toggleRoute = async () => {
    const next = !speakerOn;
    await trtc.current
      .getDeviceManager()
      .setAudioRoute(
        next ? TRTCCloudDef.TRTC_AUDIO_ROUTE_SPEAKER : TRTCCloudDef.TRTC_AUDIO_ROUTE_EARPIECE,
      );
    setSpeakerOn(next);
    showToast(
      translate('intercom.routeToast', {
        route: translate(next ? 'intercom.speaker' : 'intercom.headset'),
      }),
    );
  };

  const toggleMuteMember = async (id: string) => {
    const next = !muted[id];
    await trtc.current.muteRemoteAudio(id, next);
    setMuted((prev) => ({ ...prev, [id]: next }));
  };

  const isSpeaking = (id: string) => (volumes[id] ?? 0) >= SPEAKING_THRESHOLD && !muted[id];

  // 成员列表 = 频道全体(含离线);网格 = 房间在线(自己在首位)
  const allMembers = members.data ?? [];
  const memberRows: VoiceChannelMemberPublic[] = allMembers.length
    ? allMembers
    : [
        {
          userId: myId,
          nickname: user?.nickname ?? null,
          avatarUrl: user?.avatarUrl ?? null,
          phone: user?.phone ?? '',
          joinedAt: '',
        },
      ];
  const onlineCount = (inRoom ? 1 : 0) + onlineIds.length;
  const memberTotal = Math.max(allMembers.length, channel?.memberCount ?? 0);
  const gridIds = [myId, ...onlineIds.filter((id) => id !== myId)];

  const channelCard = channel && (
    <Card>
      <View style={styles.channelHead}>
        <View style={[styles.channelTile, { backgroundColor: theme.backgroundSelected }]}>
          <Ionicons name="radio-outline" size={22} color={theme.brand} />
        </View>
        <View style={styles.channelBody}>
          <ThemedText numberOfLines={1} style={styles.channelName}>
            {channel.name}
          </ThemedText>
          {inRoom ? (
            <View style={styles.onlineRow}>
              <View style={[styles.onlineDot, { backgroundColor: theme.success }]} />
              <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
                {t('intercom.onlineCount', { n: onlineCount })}
              </ThemedText>
            </View>
          ) : (
            <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
              {t('intercom.membersCount', { n: memberTotal })} · {t('intercom.memberLimit')}
            </ThemedText>
          )}
        </View>
        {!inRoom && (
          <Tappable onPress={leaveChannel} hitSlop={8} style={styles.headLink}>
            <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
              {t('intercom.leaveChannel')}
            </ThemedText>
          </Tappable>
        )}
      </View>
      <View style={[styles.divider, { backgroundColor: theme.border }]} />
      <View style={styles.inviteRow}>
        <View style={styles.inviteLeft}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.caption}>
            {t('intercom.inviteCode')}
          </ThemedText>
          <ThemedText style={styles.inviteCode}>{channel.inviteCode}</ThemedText>
        </View>
        <Tappable onPress={shareInvite} style={styles.shareBtn}>
          <Ionicons name="share-outline" size={18} color={theme.brand} />
          <ThemedText type="smallBold" themeColor="brand">
            {t('intercom.shareInvite')}
          </ThemedText>
        </Tappable>
      </View>
    </Card>
  );

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.flex}>
        <ThemedText type="title" style={styles.pageTitle}>
          {t('intercom.title')}
        </ThemedText>

        {!channel ? (
          /* A. 无频道:空态 + 底部创建/加入 */
          <>
            <View style={styles.emptyWrap}>
              <View
                style={[
                  styles.emptyIcon,
                  { backgroundColor: theme.backgroundElement, borderColor: theme.border },
                ]}>
                <Ionicons name="radio-outline" size={40} color={theme.brand} />
              </View>
              <ThemedText style={styles.emptyTitle}>{t('intercom.emptyTitle')}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.emptyBody}>
                {t('intercom.emptyBody')}
              </ThemedText>
            </View>
            <View style={styles.bottomActions}>
              <PrimaryButton title={t('intercom.create')} icon="add" onPress={() => setCreateOpen(true)} />
              <SecondaryButton
                title={t('intercom.joinWithCode')}
                icon="key-outline"
                onPress={() => setJoinOpen(true)}
              />
            </View>
          </>
        ) : !inRoom ? (
          /* B. 有频道未进房:频道卡 + 全体成员列表 + 底部进入 */
          <>
            <ScrollView
              style={styles.flex}
              contentContainerStyle={styles.lobbyContent}
              showsVerticalScrollIndicator={false}>
              {channelCard}
              <GroupTitle title={t('intercom.membersCount', { n: memberTotal })} />
              <Card>
                {memberRows.map((m, i) => {
                  const self = m.userId === myId;
                  const online = self || onlineIds.includes(m.userId);
                  const display = self ? nameOf(myId) : (m.nickname ?? m.phone);
                  return (
                    <View
                      key={m.userId}
                      style={[
                        styles.memberRow,
                        !online && styles.memberOffline,
                        i < memberRows.length - 1 && {
                          borderBottomWidth: StyleSheet.hairlineWidth,
                          borderBottomColor: theme.border,
                        },
                      ]}>
                      {m.avatarUrl ? (
                        <Image source={{ uri: m.avatarUrl }} style={styles.memberAvatar} />
                      ) : (
                        <View
                          style={[styles.memberAvatar, { backgroundColor: theme.backgroundSelected }]}>
                          <ThemedText type="smallBold">{display.slice(0, 1).toUpperCase()}</ThemedText>
                        </View>
                      )}
                      <ThemedText numberOfLines={1} style={styles.memberName}>
                        {display}
                        {self && (
                          <ThemedText themeColor="textSecondary" style={styles.memberName}>
                            {` (${t('intercom.me')})`}
                          </ThemedText>
                        )}
                      </ThemedText>
                    </View>
                  );
                })}
              </Card>
            </ScrollView>
            <View style={styles.bottomActions}>
              {joinError && (
                <ThemedText type="small" themeColor="danger" style={styles.centerText}>
                  {joinError}
                </ThemedText>
              )}
              <PrimaryButton
                title={joining ? t('intercom.entering') : t('intercom.enterRoom')}
                onPress={() => void join()}
                loading={joining}
              />
            </View>
          </>
        ) : (
          /* C. 房内:频道卡 + 在线成员网格 + 底部固定 PTT 行 */
          <>
            <View style={styles.roomTop}>
              {channelCard}
              <GroupTitle title={t('intercom.membersCount', { n: memberTotal })} />
            </View>
            <ScrollView
              style={styles.flex}
              contentContainerStyle={styles.grid}
              showsVerticalScrollIndicator={false}>
              {gridIds.map((id) => {
                const self = id === myId;
                return (
                  <MemberCell
                    key={id}
                    name={nameOf(id)}
                    speaking={self ? isSpeaking(id) || talking : isSpeaking(id)}
                    self={self}
                    muted={!!muted[id]}
                    avatarUrl={avatarOf(id)}
                    onPress={self ? undefined : () => void toggleMuteMember(id)}
                  />
                );
              })}
            </ScrollView>

            <View style={styles.bottomRow}>
              {/* 左：离开房间 */}
              <View style={styles.sideCol}>
                <Tappable
                  haptic
                  onPress={leaveRoom}
                  style={[styles.roundBtn, { backgroundColor: theme.backgroundSelected }]}>
                  <Ionicons name="exit-outline" size={20} color={theme.text} />
                </Tappable>
                <ThemedText themeColor="textSecondary" style={styles.sideLabel}>
                  {t('intercom.leave')}
                </ThemedText>
              </View>

              {/* 中：PTT */}
              <View style={styles.pttCol}>
                <View style={styles.pttClip}>
                  <PulseRing active={talking} size={112} color={theme.danger} count={3} duration={1400} maxScale={1.4} />
                  <Animated.View
                    style={[
                      styles.pttGlow,
                      { backgroundColor: talking ? theme.danger : theme.brand },
                      pttGlowStyle,
                    ]}
                  />
                  <Animated.View style={pttPressStyle}>
                    <Pressable
                      onPressIn={() => void pttDown()}
                      onPressOut={() => void pttUp()}
                      style={[
                        styles.ptt,
                        {
                          backgroundColor: talking ? theme.danger : theme.brand,
                          shadowColor: talking ? theme.danger : theme.brand,
                        },
                      ]}>
                      <Ionicons name="mic" size={44} color={talking ? '#fff' : theme.onBrand} />
                    </Pressable>
                  </Animated.View>
                </View>
                <ThemedText
                  style={[styles.pttLabel, { color: talking ? theme.danger : theme.text }]}>
                  {talking ? t('intercom.talking') : t('intercom.holdToTalk')}
                </ThemedText>
              </View>

              {/* 右：音频路由 */}
              <View style={styles.sideCol}>
                <Tappable
                  haptic
                  onPress={() => void toggleRoute()}
                  style={[styles.roundBtn, { backgroundColor: theme.backgroundSelected }]}>
                  <Ionicons
                    name={speakerOn ? 'volume-high-outline' : 'headset-outline'}
                    size={20}
                    color={theme.text}
                  />
                </Tappable>
                <ThemedText themeColor="textSecondary" style={styles.sideLabel}>
                  {speakerOn ? t('intercom.speaker') : t('intercom.headset')}
                </ThemedText>
              </View>
            </View>
          </>
        )}

        {/* 创建频道弹层 */}
        <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => setCreateOpen(false)}>
          <Pressable style={styles.modalMask} onPress={() => setCreateOpen(false)}>
            <Animated.View entering={FadeInDown.duration(200)}>
            <Pressable
              style={[styles.modalCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}
              onPress={() => undefined}>
              <ThemedText style={styles.modalTitle}>{t('intercom.create')}</ThemedText>
              <FormInput
                label={t('intercom.channelName')}
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder={t('intercom.channelNamePlaceholder')}
                maxLength={30}
                autoFocus
              />
              <PrimaryButton title={t('intercom.createAction')} onPress={submitCreate} loading={submitting} />
            </Pressable>
          </Animated.View>
          </Pressable>
        </Modal>

        {/* 邀请码加入弹层 */}
        <Modal visible={joinOpen} transparent animationType="fade" onRequestClose={() => setJoinOpen(false)}>
          <Pressable style={styles.modalMask} onPress={() => setJoinOpen(false)}>
            <Animated.View entering={FadeInDown.duration(200)}>
            <Pressable
              style={[styles.modalCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}
              onPress={() => undefined}>
              <ThemedText style={styles.modalTitle}>{t('intercom.joinWithCode')}</ThemedText>
              <FormInput
                label={t('intercom.inviteCode')}
                value={codeDraft}
                onChangeText={setCodeDraft}
                placeholder={t('intercom.inviteCodePlaceholder')}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
              />
              <PrimaryButton title={t('intercom.join')} onPress={submitJoin} loading={submitting} />
            </Pressable>
          </Animated.View>
          </Pressable>
        </Modal>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, paddingHorizontal: 20 },
  pageTitle: { fontSize: 32, lineHeight: 38, marginTop: 8 },
  centerText: { textAlign: 'center' },
  caption: { fontSize: 13, lineHeight: 18 },

  // A. 空态
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  emptyTitle: { fontSize: 20, lineHeight: 26, fontWeight: 600 },
  emptyBody: { textAlign: 'center' },
  bottomActions: { paddingTop: 8, paddingBottom: 22, gap: 10 },

  // 频道卡
  channelHead: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  channelTile: {
    width: 40,
    height: 40,
    borderRadius: Radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelBody: { flex: 1, gap: 2, minWidth: 0 },
  channelName: { fontSize: 17, lineHeight: 22, fontWeight: 600 },
  onlineRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  onlineDot: { width: 7, height: 7, borderRadius: 4 },
  headLink: { minHeight: 44, justifyContent: 'center', paddingLeft: 8 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 14 },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  inviteLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inviteCode: { fontFamily: Fonts.mono, fontSize: 16, lineHeight: 22, letterSpacing: 2, fontWeight: 600 },
  shareBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingLeft: 8 },

  // B. 未进房
  lobbyContent: { gap: 12, paddingTop: 12, paddingBottom: 8 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, height: 52 },
  memberOffline: { opacity: 0.45 },
  memberAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  memberName: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: 500 },

  // C. 房内
  roomTop: { gap: 12, paddingTop: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12, paddingTop: 12, paddingBottom: 8 },
  cell: { width: '25%', alignItems: 'center', gap: 6 },
  cellRingBox: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  cellAvatarRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellAvatar: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  cellMuteBadge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellName: { fontSize: 13, lineHeight: 18, maxWidth: '100%', paddingHorizontal: 4 },
  cellSlot: { height: 22, alignItems: 'center', justifyContent: 'center' },
  speakPill: { height: 20, borderRadius: Radius.pill, paddingHorizontal: 8, justifyContent: 'center' },
  speakPillText: { fontSize: 11, lineHeight: 14, fontWeight: 600 },

  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    paddingBottom: 14,
  },
  sideCol: { width: 72, alignItems: 'center', gap: 6 },
  roundBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sideLabel: { fontSize: 12, lineHeight: 16 },
  pttCol: { alignItems: 'center', gap: 2 },
  pttClip: { width: 160, height: 160, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  pttGlow: { position: 'absolute', width: 108, height: 108, borderRadius: 54, opacity: 0.35 },
  ptt: {
    width: 112,
    height: 112,
    borderRadius: 56,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  pttLabel: { fontSize: 13, lineHeight: 18, fontWeight: 600 },

  // 弹层
  modalMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
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
