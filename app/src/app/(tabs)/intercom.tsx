// 对讲（底部标签）：TRTC 语音对讲（决策 #22 选型已定案）。
// 频道/队伍管理属 Week 9–10 后端任务，当前为固定演示频道；PTT 交互与最终版一致。
// 设计对齐定稿套图：大圆 PTT（空闲品牌色/发言红色）+ 成员列表 + 状态药丸
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import TRTCCloud, {
  TRTCCloudDef,
  TRTCCloudListener,
  TRTCParams,
} from 'trtc-react-native';

import { Badge } from '@/components/badge';
import { PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { generateTestUserSig } from '@/spike/generate-test-usersig';
import { useAuthStore } from '@/stores/auth-store';

const SDKAPPID = Number(process.env.EXPO_PUBLIC_TRTC_SDKAPPID ?? 0);
const SECRETKEY = process.env.EXPO_PUBLIC_TRTC_SECRETKEY ?? '';
// 固定演示频道：正式频道管理（建队/邀请）等 Week 9–10 后端（决策 #21 排期）
const ROOM_ID = 42;

export default function IntercomScreen() {
  const theme = useTheme();
  const user = useAuthStore((s) => s.user);
  const trtc = useRef(TRTCCloud.sharedInstance());
  const [inRoom, setInRoom] = useState(false);
  const [talking, setTalking] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [joining, setJoining] = useState(false);

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
          break;
        case TRTCCloudListener.onRemoteUserEnterRoom:
          setMembers((prev) =>
            prev.includes(params.userId) ? prev : [...prev, params.userId],
          );
          break;
        case TRTCCloudListener.onRemoteUserLeaveRoom:
          setMembers((prev) => prev.filter((m) => m !== params.userId));
          break;
      }
    };
    cloud.registerListener(listener);
    return () => {
      cloud.unRegisterListener(listener);
      cloud.exitRoom();
    };
  }, []);

  const join = async () => {
    if (!SDKAPPID || !SECRETKEY) return;
    if (Platform.OS === 'android') {
      const res = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (res !== PermissionsAndroid.RESULTS.GRANTED) return;
    }
    setJoining(true);
    const userId = user?.phone ?? `rider_${Platform.OS}`;
    const userSig = generateTestUserSig(SDKAPPID, SECRETKEY, userId);
    const params = new TRTCParams({ sdkAppId: SDKAPPID, userId, userSig, roomId: ROOM_ID });
    await trtc.current.enterRoom(params, TRTCCloudDef.TRTC_APP_SCENE_AUDIOCALL);
    await trtc.current.startLocalAudio(TRTCCloudDef.TRTC_AUDIO_QUALITY_SPEECH);
    await trtc.current.muteLocalAudio(true);
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

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <View style={styles.header}>
          <View>
            <ThemedText type="title" style={styles.pageTitle}>
              对讲
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              骑行频道 · {inRoom ? `${members.length + 1} 人在线` : '未进入'}
            </ThemedText>
          </View>
          {inRoom && <Badge variant={talking ? 'danger' : 'success'} label={talking ? '发言中' : '空闲中'} />}
        </View>

        {!inRoom ? (
          <View style={styles.joinWrap}>
            <Ionicons name="mic-outline" size={56} color={theme.textSecondary} />
            <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
              进入频道后按住下方按钮说话{'\n'}声音经蓝牙耳机（头盔）播放
            </ThemedText>
            <PrimaryButton
              title={joining ? '进入中…' : '进入语音频道'}
              onPress={() => void join()}
              loading={joining}
            />
          </View>
        ) : (
          <>
            <View style={styles.pttWrap}>
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

            <ThemedText type="label" themeColor="textSecondary">
              成员（{members.length + 1}）
            </ThemedText>
            <View
              style={[styles.memberRow, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
              <View style={[styles.memberAvatar, { backgroundColor: theme.backgroundSelected }]}>
                <ThemedText type="smallBold">我</ThemedText>
              </View>
              <ThemedText type="smallBold" style={styles.memberName}>
                {user?.nickname ?? user?.phone ?? '我'}
              </ThemedText>
              <Badge variant={talking ? 'danger' : 'neutral'} label={talking ? '发言中' : '静音'} />
            </View>
            {members.map((m) => (
              <View
                key={m}
                style={[styles.memberRow, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                <View style={[styles.memberAvatar, { backgroundColor: theme.backgroundSelected }]}>
                  <ThemedText type="smallBold">{m.slice(-2)}</ThemedText>
                </View>
                <ThemedText type="smallBold" style={styles.memberName}>
                  {m}
                </ThemedText>
                <Ionicons name="volume-high-outline" size={18} color={theme.success} />
              </View>
            ))}

            <View style={styles.footer}>
              <PrimaryButton title="退出频道" onPress={leave} danger />
            </View>
          </>
        )}
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 20, gap: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pageTitle: { fontSize: 32, lineHeight: 38 },
  joinWrap: { flex: 1, justifyContent: 'center', gap: 16 },
  centerText: { textAlign: 'center' },
  pttWrap: { alignItems: 'center', paddingVertical: 24 },
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
  memberName: { flex: 1 },
  footer: { marginTop: 'auto', paddingBottom: BottomTabInset },
});
