// Week 2 RTC 语音 Spike（临时页面，定案后删除）：TRTC 进房、双端互通、按住说话、音频路由
// 验证点：语音延迟、蓝牙耳机路由、切后台是否还能通话（iOS 后台音频是另一半重点）
import { useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import TRTCCloud, {
  TRTCCloudDef,
  TRTCCloudListener,
  TRTCParams,
} from 'trtc-react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { generateTestUserSig } from '@/spike/generate-test-usersig';

const SDKAPPID = Number(process.env.EXPO_PUBLIC_TRTC_SDKAPPID ?? 0);
const SECRETKEY = process.env.EXPO_PUBLIC_TRTC_SECRETKEY ?? '';
const ROOM_ID = 42; // 双端进同一房间号即可互通
const USER_ID = `spike_${Platform.OS}`; // 两台设备用不同平台自然区分

export default function SpikeRtcScreen() {
  const trtc = useRef(TRTCCloud.sharedInstance());
  const [lines, setLines] = useState<string[]>([]);
  const [inRoom, setInRoom] = useState(false);
  const [muted, setMuted] = useState(true);
  const [speakerOn, setSpeakerOn] = useState(true);

  const log = (msg: string) => {
    console.log(`[spike-rtc] ${msg}`);
    setLines((prev) => [...prev.slice(-8), `${new Date().toLocaleTimeString()} ${msg}`]);
  };

  useEffect(() => {
    const cloud = trtc.current;
    const listener = (type: TRTCCloudListener, params: any) => {
      switch (type) {
        case TRTCCloudListener.onEnterRoom:
          log(params.result >= 0 ? `✅ 进房成功（耗时 ${params.result}ms）` : `进房失败 code=${params.result}`);
          setInRoom(params.result >= 0);
          break;
        case TRTCCloudListener.onExitRoom:
          log('已退出房间');
          setInRoom(false);
          break;
        case TRTCCloudListener.onRemoteUserEnterRoom:
          log(`👥 队友进房：${params.userId} —— 开始说话试试！`);
          break;
        case TRTCCloudListener.onRemoteUserLeaveRoom:
          log(`队友离开：${params.userId}`);
          break;
        case TRTCCloudListener.onError:
          log(`❌ 错误 ${params.errCode}: ${params.errMsg}`);
          break;
      }
    };
    cloud.registerListener(listener);
    return () => {
      cloud.unRegisterListener(listener);
      cloud.exitRoom();
    };
  }, []);

  const enter = async () => {
    setLines([]);
    if (!SDKAPPID || !SECRETKEY) {
      log('缺少 TRTC 配置：检查 app/.env');
      return;
    }
    if (Platform.OS === 'android') {
      const res = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      log(`麦克风权限：${res}`);
      if (res !== PermissionsAndroid.RESULTS.GRANTED) return;
    }
    log(`以 ${USER_ID} 进入房间 ${ROOM_ID}…`);
    const userSig = generateTestUserSig(SDKAPPID, SECRETKEY, USER_ID);
    const params = new TRTCParams({
      sdkAppId: SDKAPPID,
      userId: USER_ID,
      userSig,
      roomId: ROOM_ID,
    });
    await trtc.current.enterRoom(params, TRTCCloudDef.TRTC_APP_SCENE_AUDIOCALL);
    // 语音质量档：SPEECH = 针对人声优化 + 最强弱网对抗（对讲场景官方推荐）
    await trtc.current.startLocalAudio(TRTCCloudDef.TRTC_AUDIO_QUALITY_SPEECH);
    await trtc.current.muteLocalAudio(true); // 默认闭麦，按住说话再开
    setMuted(true);
  };

  const exit = async () => {
    await trtc.current.exitRoom();
  };

  // 按住说话（PTT）：按下开麦，松开闭麦
  const pttDown = async () => {
    await trtc.current.muteLocalAudio(false);
    setMuted(false);
    log('🎙️ 开麦（说话中…）');
  };
  const pttUp = async () => {
    await trtc.current.muteLocalAudio(true);
    setMuted(true);
    log('🔇 闭麦');
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
    log(`音频路由 → ${next ? '扬声器' : '听筒'}（连蓝牙耳机时系统会优先走耳机）`);
  };

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <ThemedText type="title">RTC 对讲 Spike</ThemedText>
        <ThemedText type="small">
          房间 {ROOM_ID} · 我是 {USER_ID} · 两台设备进同一房间即可互通
        </ThemedText>

        {!inRoom ? (
          <Pressable style={styles.button} onPress={enter}>
            <ThemedText type="smallBold" style={styles.buttonText}>
              进入语音房间
            </ThemedText>
          </Pressable>
        ) : (
          <>
            <Pressable
              style={[styles.ptt, !muted && styles.pttActive]}
              onPressIn={pttDown}
              onPressOut={pttUp}>
              <ThemedText type="smallBold" style={styles.buttonText}>
                {muted ? '按住说话' : '正在说话…'}
              </ThemedText>
            </Pressable>
            <ThemedView style={styles.row}>
              <Pressable style={styles.buttonSecondary} onPress={toggleRoute}>
                <ThemedText type="smallBold" style={styles.buttonText}>
                  {speakerOn ? '🔊 扬声器' : '📞 听筒'}
                </ThemedText>
              </Pressable>
              <Pressable style={[styles.buttonSecondary, styles.buttonDanger]} onPress={exit}>
                <ThemedText type="smallBold" style={styles.buttonText}>
                  退出房间
                </ThemedText>
              </Pressable>
            </ThemedView>
          </>
        )}

        {lines.map((l, i) => (
          <ThemedText key={i} type="small">
            {l}
          </ThemedText>
        ))}
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 24, gap: 12 },
  row: { flexDirection: 'row', gap: 12 },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonSecondary: {
    backgroundColor: '#208AEF',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  buttonDanger: { backgroundColor: '#D9534F' },
  ptt: {
    backgroundColor: '#5CB85C',
    borderRadius: 60,
    paddingVertical: 40,
    alignItems: 'center',
  },
  pttActive: { backgroundColor: '#D9534F' },
  buttonText: { color: '#fff' },
});
