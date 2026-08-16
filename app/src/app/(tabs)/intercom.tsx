// 对讲（底部标签）：后端频道体系（API.md §13,#43）+ TRTC 语音（决策 #22/#27⑤⑥）。
// 频道创建/邀请码加入/成员档案(昵称头像)走后端;UserSig 由服务端签发,App 不持有 TRTC 密钥。
// UI 对齐定稿套图（成员发言环/PTT 大圆钮/音频路由卡/成员列表）。
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
import { SafeAreaView } from 'react-native-safe-area-context';
import TRTCCloud, {
  TRTCCloudDef,
  TRTCCloudListener,
  TRTCParams,
} from 'trtc-react-native';
import type { VoiceChannelMemberPublic } from '@helmet/shared';

import { channelsApi } from '@/api/channels';
import { toUserMessage } from '@/api/error-messages';
import { Badge } from '@/components/badge';
import { FormInput, PrimaryButton } from '@/components/form';
import { PulseRing } from '@/components/pulse-ring';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuthStore } from '@/stores/auth-store';

const SPEAKING_THRESHOLD = 10; // onUserVoiceVolume 0–100

function MemberAvatar({
  name,
  speaking,
  self = false,
  avatarUrl,
}: {
  name: string;
  speaking: boolean;
  self?: boolean;
  avatarUrl?: string | null;
}) {
  const theme = useTheme();
  return (
    <View style={styles.avatarWrap}>
      <View style={styles.avatarRingBox}>
        <PulseRing active={speaking} size={64} color={theme.brand} maxScale={1.3} />
      <View
        style={[
          styles.avatarRing,
          { borderColor: speaking ? theme.brand : 'transparent' },
        ]}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type="smallBold" style={{ fontSize: 18 }}>
              {name.slice(0, 1).toUpperCase()}
            </ThemedText>
          </View>
        )}
        {speaking && (
          <View style={[styles.speakBubble, { backgroundColor: theme.brand }]}>
            <Ionicons name="pulse" size={10} color={theme.onBrand} />
          </View>
        )}
      </View>
      </View>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.avatarName}>
        {self ? '我' : name}
      </ThemedText>
    </View>
  );
}

export default function IntercomScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const trtc = useRef(TRTCCloud.sharedInstance());
  const [inRoom, setInRoom] = useState(false);
  const [talking, setTalking] = useState(false);
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
    if (id === myId) return user?.nickname ?? user?.phone ?? '我';
    const m = memberMap.get(id);
    return m?.nickname ?? m?.phone ?? id.slice(-4);
  };
  const avatarOf = (id: string) =>
    id === myId ? user?.avatarUrl : memberMap.get(id)?.avatarUrl;

  useEffect(() => {
    const cloud = trtc.current;
    const listener = (type: TRTCCloudListener, params: any) => {
      switch (type) {
        case TRTCCloudListener.onEnterRoom:
          setInRoom(params.result >= 0);
          setJoining(false);
          setJoinError(params.result >= 0 ? null : `进房失败（${params.result}），请重试`);
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
        if (j) setJoinError('进房超时，请重试');
        return false;
      });
    }, 8000);
    try {
      // UserSig 服务端签发（决策 #27⑥）,App 端不再持有 TRTC SecretKey
      const t = await channelsApi.token(channel.channelId);
      const params = new TRTCParams({
        sdkAppId: t.sdkAppId,
        userId: t.userId,
        userSig: t.userSig,
        roomId: t.roomId,
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
    Alert.alert('退出频道', `退出「${channel.name}」后需邀请码重新加入。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: () => {
          leaveRoom();
          channelsApi
            .leave(channel.channelId)
            .then(() => queryClient.invalidateQueries({ queryKey: ['voice-channels'] }))
            .catch((e) => Alert.alert('退出失败', toUserMessage(e)));
        },
      },
    ]);
  };

  const shareInvite = () => {
    if (!channel) return;
    void Share.share({
      message: `加入我的骑行对讲频道「${channel.name}」,在 AI 智能头盔 App 输入邀请码:${channel.inviteCode}`,
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
      .catch((e) => Alert.alert('创建失败', toUserMessage(e)))
      .finally(() => setSubmitting(false));
  };

  const submitJoin = () => {
    if (!/^\d{6}$/.test(codeDraft.trim())) {
      Alert.alert('邀请码格式', '邀请码是 6 位数字');
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
      .catch((e) => Alert.alert('加入失败', toUserMessage(e)))
      .finally(() => setSubmitting(false));
  };

  const pttDown = async () => {
    await trtc.current.muteLocalAudio(false);
    setTalking(true);
  };
  const pttUp = async () => {
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
  };

  const toggleMuteMember = async (id: string) => {
    const next = !muted[id];
    await trtc.current.muteRemoteAudio(id, next);
    setMuted((prev) => ({ ...prev, [id]: next }));
  };

  const isSpeaking = (id: string) => (volumes[id] ?? 0) >= SPEAKING_THRESHOLD && !muted[id];

  // 成员列表 = 频道全体(含离线);头像行 = 房间在线(自己在首位)
  const allMembers = members.data ?? [];
  const onlineCount = (inRoom ? 1 : 0) + onlineIds.length;
  const memberTotal = Math.max(allMembers.length, channel?.memberCount ?? 0);

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        {!channel ? (
          /* 无频道:创建 / 邀请码加入 */
          <>
            <ThemedText type="title" style={styles.pageTitle}>
              对讲
            </ThemedText>
            <View style={styles.joinWrap}>
              <Ionicons name="mic-outline" size={56} color={theme.textSecondary} />
              <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
                创建频道或用邀请码加入队友的频道{'\n'}进入后按住按钮说话,蓝牙头盔自动走耳机
              </ThemedText>
              <PrimaryButton title="创建频道" onPress={() => setCreateOpen(true)} />
              <Pressable onPress={() => setJoinOpen(true)}>
                <ThemedText type="smallBold" themeColor="brand" style={styles.centerText}>
                  有邀请码?加入频道
                </ThemedText>
              </Pressable>
            </View>
          </>
        ) : !inRoom ? (
          /* 有频道未进房:频道卡 + 进入按钮 */
          <>
            <ThemedText type="title" style={styles.pageTitle}>
              对讲
            </ThemedText>
            <View style={styles.joinWrap}>
              <View
                style={[styles.channelCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                <ThemedText type="subtitle" style={{ fontSize: 20 }}>
                  {channel.name}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  成员 {memberTotal} 人 · 上限 20
                </ThemedText>
                <Pressable onPress={shareInvite}>
                  <View style={[styles.codeChip, { backgroundColor: theme.backgroundSelected }]}>
                    <Ionicons name="key-outline" size={14} color={theme.brand} />
                    <ThemedText type="smallBold" themeColor="brand">
                      邀请码 {channel.inviteCode}
                    </ThemedText>
                    <Ionicons name="share-outline" size={14} color={theme.textSecondary} />
                  </View>
                </Pressable>
              </View>
              <PrimaryButton
                title={joining ? '进入中…' : '进入语音频道'}
                onPress={() => void join()}
                loading={joining}
              />
              {joinError && (
                <ThemedText type="small" themeColor="danger" style={styles.centerText}>
                  {joinError}
                </ThemedText>
              )}
              <Pressable onPress={leaveChannel}>
                <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
                  退出频道
                </ThemedText>
              </Pressable>
            </View>
          </>
        ) : (
          <ScrollView contentContainerStyle={styles.roomContent} showsVerticalScrollIndicator={false}>
            {/* 顶部：频道名（点击展开菜单）+ 在线数 */}
            <View style={styles.header}>
              <Pressable onPress={() => setMenuOpen((v) => !v)} hitSlop={8}>
                <View style={styles.titleRow}>
                  <ThemedText type="title" style={styles.channelTitle}>
                    {channel.name}
                  </ThemedText>
                  <Ionicons
                    name={menuOpen ? 'chevron-up' : 'chevron-down'}
                    size={22}
                    color={theme.textSecondary}
                  />
                </View>
                <ThemedText type="small" themeColor="textSecondary">
                  {onlineCount} 人在线 · 共 {memberTotal} 名成员
                </ThemedText>
              </Pressable>
              <Badge variant={talking ? 'danger' : 'success'} label={talking ? '发言中' : '空闲中'} />
            </View>

            {/* 在线成员头像横排（发言荧光环） */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.avatarRow}>
              <MemberAvatar
                name={nameOf(myId)}
                speaking={isSpeaking(myId) || talking}
                self
                avatarUrl={user?.avatarUrl}
              />
              {onlineIds.map((id) => (
                <MemberAvatar key={id} name={nameOf(id)} speaking={isSpeaking(id)} avatarUrl={avatarOf(id)} />
              ))}
            </ScrollView>

            {/* PTT 大圆钮 */}
            <View style={styles.pttWrap}>
              <View style={styles.pttClip}>
                <PulseRing active={talking} size={220} color={theme.danger} count={3} duration={1400} />
              <View style={[styles.pttOuter, { borderColor: talking ? theme.dangerBg : 'rgba(217,242,74,0.15)' }]}>
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
                  <ThemedText
                    type="smallBold"
                    style={{ color: talking ? '#fff' : theme.onBrand, fontSize: 16 }}>
                    {talking ? '正在说话…' : '按住说话'}
                  </ThemedText>
                </Pressable>
              </View>
              </View>
            </View>

            {/* 音频路由卡（连蓝牙耳机时系统优先走耳机） */}
            <Pressable onPress={() => void toggleRoute()}>
              <View style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                <View style={[styles.hashIcon, { backgroundColor: theme.backgroundSelected }]}>
                  <Ionicons
                    name={speakerOn ? 'volume-high-outline' : 'headset-outline'}
                    size={18}
                    color={theme.brand}
                  />
                </View>
                <View style={styles.cardBody}>
                  <ThemedText type="smallBold" style={{ fontSize: 15 }}>
                    音频输出:{speakerOn ? '扬声器' : '听筒 / 耳机'}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    连接蓝牙头盔时自动优先走头盔 · 点击切换
                  </ThemedText>
                </View>
                <Ionicons name="swap-horizontal" size={18} color={theme.textSecondary} />
              </View>
            </Pressable>

            {/* 成员列表:频道全体,标注在线/离线 */}
            <View style={styles.membersHeader}>
              <ThemedText type="label" themeColor="textSecondary">
                成员（{memberTotal}）
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                按住说话优先
              </ThemedText>
            </View>

            {(allMembers.length
              ? allMembers
              : [
                  {
                    userId: myId,
                    nickname: user?.nickname ?? null,
                    avatarUrl: user?.avatarUrl ?? null,
                    phone: user?.phone ?? '',
                    joinedAt: '',
                  },
                ]
            ).map((m) => {
              const self = m.userId === myId;
              const online = self || onlineIds.includes(m.userId);
              const display = self ? nameOf(myId) : (m.nickname ?? m.phone);
              return (
                <View
                  key={m.userId}
                  style={[styles.memberRow, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                  {m.avatarUrl ? (
                    <Image source={{ uri: m.avatarUrl }} style={styles.memberAvatar} />
                  ) : (
                    <View style={[styles.memberAvatar, { backgroundColor: theme.backgroundSelected }]}>
                      <ThemedText type="smallBold">{display.slice(0, 1).toUpperCase()}</ThemedText>
                    </View>
                  )}
                  <View style={styles.memberBody}>
                    <ThemedText type="smallBold">{display}</ThemedText>
                    {muted[m.userId] && (
                      <ThemedText type="small" themeColor="textSecondary">
                        已对我静音
                      </ThemedText>
                    )}
                  </View>
                  {self ? (
                    <Badge variant={talking ? 'danger' : 'neutral'} label={talking ? '发言中' : '我'} />
                  ) : (
                    <Badge variant={online ? 'success' : 'neutral'} label={online ? '在线' : '离线'} />
                  )}
                  {isSpeaking(m.userId) && <Ionicons name="pulse" size={18} color={theme.brand} />}
                  {!self && online && (
                    <Pressable hitSlop={8} onPress={() => void toggleMuteMember(m.userId)}>
                      <Ionicons
                        name={muted[m.userId] ? 'volume-mute' : 'volume-high-outline'}
                        size={20}
                        color={muted[m.userId] ? theme.danger : theme.textSecondary}
                      />
                    </Pressable>
                  )}
                </View>
              );
            })}

          </ScrollView>
        )}

        {/* 频道 Dropdown（浮于页面之上）：点外部关闭 */}
        {inRoom && menuOpen && channel && (
          <>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuOpen(false)} />
            <View
              style={[
                styles.dropdown,
                { backgroundColor: theme.backgroundSelected, borderColor: theme.border },
              ]}>
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  shareInvite();
                }}>
                <Ionicons name="share-outline" size={20} color={theme.brand} />
                <ThemedText type="smallBold">分享邀请码 {channel.inviteCode}</ThemedText>
              </Pressable>
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  leaveRoom();
                }}>
                <Ionicons name="exit-outline" size={20} color={theme.textSecondary} />
                <ThemedText type="smallBold">离开房间</ThemedText>
              </Pressable>
              <Pressable
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  leaveChannel();
                }}>
                <Ionicons name="trash-outline" size={20} color={theme.danger} />
                <ThemedText type="smallBold" style={{ color: theme.danger }}>
                  退出频道
                </ThemedText>
              </Pressable>
            </View>
          </>
        )}

        {/* 创建频道弹层 */}
        <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => setCreateOpen(false)}>
          <Pressable style={styles.modalMask} onPress={() => setCreateOpen(false)}>
            <Pressable
              style={[styles.modalCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}
              onPress={() => undefined}>
              <ThemedText type="subtitle">创建频道</ThemedText>
              <FormInput
                label="频道名"
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder="如:周末骑行队"
                maxLength={30}
                autoFocus
              />
              <PrimaryButton title="创建" onPress={submitCreate} loading={submitting} />
            </Pressable>
          </Pressable>
        </Modal>

        {/* 邀请码加入弹层 */}
        <Modal visible={joinOpen} transparent animationType="fade" onRequestClose={() => setJoinOpen(false)}>
          <Pressable style={styles.modalMask} onPress={() => setJoinOpen(false)}>
            <Pressable
              style={[styles.modalCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}
              onPress={() => undefined}>
              <ThemedText type="subtitle">加入频道</ThemedText>
              <FormInput
                label="邀请码"
                value={codeDraft}
                onChangeText={setCodeDraft}
                placeholder="6 位数字"
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
              />
              <PrimaryButton title="加入" onPress={submitJoin} loading={submitting} />
            </Pressable>
          </Pressable>
        </Modal>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, paddingHorizontal: 20 },
  pageTitle: { fontSize: 32, lineHeight: 38, marginTop: 8 },
  joinWrap: { flex: 1, justifyContent: 'center', gap: 16 },
  centerText: { textAlign: 'center' },
  channelCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 18,
    gap: 8,
    alignItems: 'center',
  },
  codeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: Radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 4,
  },
  roomContent: { gap: 14, paddingTop: 8, paddingBottom: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
  dropdown: {
    position: 'absolute',
    top: 96,
    left: 20,
    minWidth: 220,
    borderRadius: Radius.control,
    borderWidth: 1,
    zIndex: 20,
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  channelTitle: { fontSize: 28, lineHeight: 34 },
  avatarRow: { gap: 16, paddingVertical: 4 },
  avatarWrap: { alignItems: 'center', gap: 6, width: 72 },
  avatarRingBox: { width: 72, height: 68, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speakBubble: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarName: { maxWidth: 72 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 14,
  },
  hashIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: { flex: 1, gap: 2 },
  pttWrap: { alignItems: 'center', paddingVertical: 4 },
  pttClip: { alignSelf: 'stretch', height: 252, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  pttOuter: {
    width: 236,
    height: 236,
    borderRadius: 118,
    borderWidth: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ptt: {
    width: 200,
    height: 200,
    borderRadius: 100,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  membersHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: Radius.control,
    borderWidth: 1,
    padding: 12,
  },
  memberAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberBody: { flex: 1, gap: 2 },
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
});
