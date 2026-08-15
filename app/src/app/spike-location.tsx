// Week 2 定位 Spike（临时页面，定案后删除）：验证「请求权限 → 弹窗 → 拿到真实坐标」全流程
// 验证点：权限拒绝表现、系统定位开关检测、无 GMS 设备（华为）定位行为、坐标/精度/时间戳
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function SpikeLocationScreen() {
  const [lines, setLines] = useState<string[]>([]);
  const [position, setPosition] = useState<Location.LocationObject | null>(null);
  const watcher = useRef<Location.LocationSubscription | null>(null);

  const log = (msg: string) => {
    console.log(`[spike] ${msg}`);
    setLines((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
  };

  useEffect(() => () => watcher.current?.remove(), []);

  const run = async () => {
    setLines([]);
    setPosition(null);
    watcher.current?.remove();

    // 1. 系统定位总开关（用户可能全局关了 GPS，权限再多也没用）
    const servicesOn = await Location.hasServicesEnabledAsync();
    log(`系统定位开关：${servicesOn ? '开' : '关 ←—— 请在系统设置/下拉快捷开关里打开位置信息'}`);
    if (!servicesOn) return;

    // 2. 权限
    const { status } = await Location.requestForegroundPermissionsAsync();
    log(`前台定位权限：${status}`);
    if (status !== 'granted') return;

    // 3. 上次已知位置（瞬时返回，可能为 null）
    const last = await Location.getLastKnownPositionAsync();
    log(last ? `上次已知位置：有（${last.coords.latitude.toFixed(4)}, ${last.coords.longitude.toFixed(4)}）` : '上次已知位置：无');
    if (last) setPosition(last);

    // 4. 持续监听实时位置（比一次性 getCurrentPositionAsync 更能暴露定位行为）
    log('开始持续监听（最高精度）…室内请靠近窗边');
    watcher.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Highest, timeInterval: 2000, distanceInterval: 0 },
      (pos) => {
        setPosition(pos);
        log(`更新：精度 ${pos.coords.accuracy?.toFixed(0)}m 来源 ${pos.mocked ? 'mock' : '真实'}`);
      },
    );

    // 5. 超时提示（不中断监听）
    setTimeout(() => {
      setPosition((current) => {
        if (!current || current.timestamp < Date.now() - 25_000) {
          log('30 秒仍无新坐标：大概率在等 GPS 首次锁星，请到窗边/室外再等 1–2 分钟');
        }
        return current;
      });
    }, 30_000);
  };

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <ThemedText type="title">定位 Spike</ThemedText>
        <Pressable style={styles.button} onPress={run}>
          <ThemedText type="smallBold" style={styles.buttonText}>
            开始定位诊断
          </ThemedText>
        </Pressable>

        {position && (
          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="code">纬度 {position.coords.latitude.toFixed(6)}</ThemedText>
            <ThemedText type="code">经度 {position.coords.longitude.toFixed(6)}</ThemedText>
            <ThemedText type="code">精度 {position.coords.accuracy?.toFixed(0) ?? '?'} 米</ThemedText>
            <ThemedText type="code">速度 {position.coords.speed?.toFixed(2) ?? '?'} 米/秒</ThemedText>
            <ThemedText type="code">时间 {new Date(position.timestamp).toLocaleTimeString()}</ThemedText>
          </ThemedView>
        )}

        <ScrollView style={styles.flex}>
          {lines.map((l, i) => (
            <ThemedText key={i} type="small">
              {l}
            </ThemedText>
          ))}
        </ScrollView>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 24, gap: 12 },
  card: { borderRadius: 12, padding: 12, gap: 4 },
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: { color: '#fff' },
});
