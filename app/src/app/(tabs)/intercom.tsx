// 对讲（底部标签）：TRTC 语音对讲（决策 #22）。UI 对齐定稿套图（成员发言环/PTT 大圆钮/音频路由卡/成员列表）。
// 适配说明（以项目为准）：无头像用首字母圈；SENA 耳机卡换成音频路由卡；队长/邀请码等
// 频道管理能力属 Week 9-10 后端方案（UserSig 后端签发 + channels 表），当前为固定演示频道。
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import {
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import TRTCCloud, {
  TRTCCloudDef,
  TRTCCloudListener,
  TRTCParams,
} from 'trtc-react-native';

import { Badge } from '@/components/badge';
import { PrimaryButton } from '@/components/form';
import { PulseRing } from '@/components/pulse-ring';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { generateTestUserSig } from '@/spike/generate-test-usersig';
import { useAuthStore } from '@/stores/auth-store';

const SDKAPPID = Number(process.env.EXPO_PUBLIC_TRTC_SDKAPPID ?? 0);
const SECRETKEY = process.env.EXPO_PUBLIC_TRTC_SECRETKEY ?? '';
// 固定演示频道：正式频道管理（创建/邀请码/成员）待 Week 9–10 后端契约定稿
const ROOM_ID = 42;
const SPEAKING_THRESHOLD = 10; // onUserVoiceVolume 0–100

function MemberAvatar({
  name,
  speaking,
  self = false,
}: {
  name: string;
  speaking: boolean;
  self?: boolean;
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
        <View style={[styles.avatar, { backgroundColor: theme.backgroundSelected }]}>
          <ThemedText type="smallBold" style={{ fontSize: 18 }}>
            {name.slice(0, 1).toUpperCase()}
          </ThemedText>
        </View>
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
  const user = useAuthStore((s) => s.user);
  const trtc = useRef(TRTCCloud.sharedInstance());
  const [inRoom, setInRoom] = useState(false);
  const [talking, setTalking] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [joining, setJoining] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [muted, setMuted] = useState<Record<string, boolean>>({});

  const myId = user?.phone ?? `rider_${Platform.OS}`;

  useEffect(() => {
    const cloud = trtc.current;
    const listener = (type: TRTCCloudListener, params: any) => {
      switch (type) {
        case TRTCCloudListener.onEnterRoom:
          setInRoom(params.result >= 0);
          setJoining(false);
          break;
        case TRTCCloudListener.onExitRoom:
          setInRoom(false);
          setMembers([]);
          setVolumes({});
          setMuted({});
          break;
        case TRTCCloudListener.onRemoteUserEnterRoom:
          setMembers((prev) =>
            prev.includes(params.userId) ? prev : [...prev, params.userId],
          );
          break;
        case TRTCCloudListener.onRemoteUserLeaveRoom:
          setMembers((prev) => prev.filter((m) => m !== params.userId));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myId]);

  const join = async () => {
    if (!SDKAPPID || !SECRETKEY) return;
    if (Platform.OS === 'android') {
      const res = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (res !== PermissionsAndroid.RESULTS.GRANTED) return;
    }
    setJoining(true);
    const userSig = generateTestUserSig(SDKAPPID, SECRETKEY, myId);
    const params = new TRTCParams({ sdkAppId: SDKAPPID, userId: myId, userSig, roomId: ROOM_ID });
    await trtc.current.enterRoom(params, TRTCCloudDef.TRTC_APP_SCENE_AUDIOCALL);
    await trtc.current.startLocalAudio(TRTCCloudDef.TRTC_AUDIO_QUALITY_SPEECH);
    await trtc.current.muteLocalAudio(true);
    // 发言指示环所需：每 300ms 回调一次成员音量
    await trtc.current.enableAudioVolumeEvaluation(300);
  };

  const leave = () => void trtc.current.exitRoom();

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

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        {!inRoom ? (
          <>
            <ThemedText type="title" style={styles.pageTitle}>
              对讲
            </ThemedText>
            <View style={styles.joinWrap}>
              <Ionicons name="mic-outline" size={56} color={theme.textSecondary} />
              <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
                进入频道后按住下方按钮说话{'\n'}连接蓝牙耳机（头盔）时声音自动走耳机
              </ThemedText>
              <PrimaryButton
                title={joining ? '进入中…' : '进入语音频道'}
                onPress={() => void join()}
                loading={joining}
              />
              <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
                频道创建 / 邀请码加入功能开发中（Week 9–10）
              </ThemedText>
            </View>
          </>
        ) : (
          <ScrollView contentContainerStyle={styles.roomContent} showsVerticalScrollIndicator={false}>
            {/* 顶部：频道名（点击展开菜单）+ 在线数 */}
            <View style={styles.header}>
              <Pressable onPress={() => setMenuOpen((v) => !v)} hitSlop={8}>
                <View style={styles.titleRow}>
                  <ThemedText type="title" style={styles.channelTitle}>
                    骑行频道
                  </ThemedText>
                  <Ionicons
                    name={menuOpen ? 'chevron-up' : 'chevron-down'}
                    size={22}
                    color={theme.textSecondary}
                  />
                </View>
                <ThemedText type="small" themeColor="textSecondary">
                  {members.length + 1} 人在线
                </ThemedText>
              </Pressable>
              <Badge variant={talking ? 'danger' : 'success'} label={talking ? '发言中' : '空闲中'} />
            </View>

            {/* 成员头像横排（发言荧光环） */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.avatarRow}>
              <MemberAvatar name={user?.nickname ?? myId} speaking={isSpeaking(myId) || talking} self />
              {members.map((m) => (
                <MemberAvatar key={m} name={m} speaking={isSpeaking(m)} />
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

            {/* 音频路由卡（对应套图耳机卡；连蓝牙耳机时系统优先走耳机） */}
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
                    音频输出：{speakerOn ? '扬声器' : '听筒 / 耳机'}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    连接蓝牙头盔时自动优先走头盔 · 点击切换
                  </ThemedText>
                </View>
                <Ionicons name="swap-horizontal" size={18} color={theme.textSecondary} />
              </View>
            </Pressable>

            {/* 成员列表 */}
            <View style={styles.membersHeader}>
              <ThemedText type="label" themeColor="textSecondary">
                成员（{members.length + 1}）
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                按住说话优先
              </ThemedText>
            </View>

            <View style={[styles.memberRow, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
              <View style={[styles.memberAvatar, { backgroundColor: theme.backgroundSelected }]}>
                <ThemedText type="smallBold">{(user?.nickname ?? myId).slice(0, 1).toUpperCase()}</ThemedText>
              </View>
              <View style={styles.memberBody}>
                <ThemedText type="smallBold">{user?.nickname ?? myId}</ThemedText>
              </View>
              <Badge variant={talking ? 'danger' : 'neutral'} label={talking ? '发言中' : '我'} />
              {isSpeaking(myId) && <Ionicons name="pulse" size={18} color={theme.brand} />}
            </View>

            {members.map((m) => (
              <View
                key={m}
                style={[styles.memberRow, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                <View style={[styles.memberAvatar, { backgroundColor: theme.backgroundSelected }]}>
                  <ThemedText type="smallBold">{m.slice(-2)}</ThemedText>
                </View>
                <View style={styles.memberBody}>
                  <ThemedText type="smallBold">{m}</ThemedText>
                  {muted[m] && (
                    <ThemedText type="small" themeColor="textSecondary">
                      已对我静音
                    </ThemedText>
                  )}
                </View>
                {isSpeaking(m) && <Ionicons name="pulse" size={18} color={theme.brand} />}
                <Pressable hitSlop={8} onPress={() => void toggleMuteMember(m)}>
                  <Ionicons
                    name={muted[m] ? 'volume-mute' : 'volume-high-outline'}
                    size={20}
                    color={muted[m] ? theme.danger : theme.textSecondary}
                  />
                </Pressable>
              </View>
            ))}

          </ScrollView>
        )}

        {/* 频道 Dropdown（浮于页面之上）：点外部关闭；将来放邀请码/频道设置 */}
        {inRoom && menuOpen && (
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
                  leave();
                }}>
                <Ionicons name="exit-outline" size={20} color={theme.danger} />
                <ThemedText type="smallBold" style={{ color: theme.danger }}>
                  退出频道
                </ThemedText>
              </Pressable>
            </View>
          </>
        )}
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
  roomContent: { gap: 14, paddingTop: 8, paddingBottom: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
  dropdown: {
    position: 'absolute',
    top: 96,
    left: 20,
    minWidth: 200,
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
});
