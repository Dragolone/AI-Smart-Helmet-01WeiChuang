// Week 2 Push Spike（临时页面，定案后删除）：验证本地通知——权限、通道、定时触发、前台/后台展示
// 注意：这只验证「通知能力」本身；远程推送（厂商通道）等第三方账号就绪后另测
import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function SpikePushScreen() {
  const [lines, setLines] = useState<string[]>([]);
  const log = (msg: string) => {
    console.log(`[spike-push] ${msg}`);
    setLines((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
  };

  const run = async () => {
    setLines([]);
    const { status } = await Notifications.requestPermissionsAsync();
    log(`通知权限：${status}`);
    if (status !== 'granted') return;

    // Android 8+ 必须先建通道；将来 SOS 会用独立高优通道 + 铃声
    await Notifications.setNotificationChannelAsync('spike', {
      name: 'Spike 测试通道',
      importance: Notifications.AndroidImportance.MAX,
    });
    log('通知通道已创建（importance=MAX）');

    await Notifications.scheduleNotificationAsync({
      content: {
        title: '⛑️ AI 头盔测试通知',
        body: '看到这条说明本地通知链路通了（5 秒定时触发）',
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 5,
        channelId: 'spike',
      },
    });
    log('已排定 5 秒后的通知 → 现在按 Home 键把 App 切到后台等它弹出');
  };

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <ThemedText type="title">Push Spike</ThemedText>
        <Pressable style={styles.button} onPress={run}>
          <ThemedText type="smallBold" style={styles.buttonText}>
            请求权限并发送 5 秒后的本地通知
          </ThemedText>
        </Pressable>
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
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: { color: '#fff' },
});
