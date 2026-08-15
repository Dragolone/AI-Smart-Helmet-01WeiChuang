// 我的设备（Home 标签）：设备列表 + 绑定入口 + 退出登录（API.md §4 GET /devices）
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { DevicePublic } from '@helmet/shared';

import { devicesApi } from '@/api/devices';
import { toUserMessage } from '@/api/error-messages';
import { PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset } from '@/constants/theme';
import { useAuthStore } from '@/stores/auth-store';

function DeviceRow({ device }: { device: DevicePublic }) {
  return (
    <Pressable onPress={() => router.push(`/device/${device.deviceId}`)}>
      <ThemedView type="backgroundElement" style={styles.card}>
        <ThemedView type="backgroundElement" style={styles.cardHeader}>
          <ThemedText type="subtitle">{device.deviceId}</ThemedText>
          <ThemedText type="smallBold" style={device.online ? styles.online : styles.offline}>
            {device.online ? '● 在线' : '○ 离线'}
          </ThemedText>
        </ThemedView>
        <ThemedText type="small">
          电量 {device.battery ?? '—'}%{device.charging ? '（充电中）' : ''} · 固件{' '}
          {device.firmwareVersion ?? '未知'}
          {device.sleeping ? ' · 休眠中' : ''}
        </ThemedText>
      </ThemedView>
    </Pressable>
  );
}

export default function MyDevicesScreen() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: devicesApi.list,
    // 列表页轻量轮询，让"在线/电量"贴近实时（正式版由 WebSocket 替代，Week 5–6）
    refetchInterval: 30_000,
  });

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <ThemedView style={styles.header}>
          <ThemedText type="title">我的设备</ThemedText>
          <Pressable onPress={() => void signOut()}>
            <ThemedText type="link">退出登录</ThemedText>
          </Pressable>
        </ThemedView>
        {user && (
          <ThemedText type="small">
            {user.nickname ?? user.phone}，欢迎回来
          </ThemedText>
        )}

        {devices.isError && (
          <ThemedText type="small">{toUserMessage(devices.error)}</ThemedText>
        )}

        <FlatList
          style={styles.flex}
          contentContainerStyle={{ paddingBottom: BottomTabInset + 16, gap: 12 }}
          data={devices.data ?? []}
          keyExtractor={(d) => d.deviceId}
          renderItem={({ item }) => <DeviceRow device={item} />}
          refreshControl={
            <RefreshControl
              refreshing={devices.isRefetching}
              onRefresh={() => void devices.refetch()}
            />
          }
          ListEmptyComponent={
            devices.isLoading ? null : (
              <ThemedView style={styles.empty}>
                <ThemedText type="subtitle">还没有绑定头盔</ThemedText>
                <ThemedText type="small">
                  绑定后可以查看在线状态、电量和骑行安全信息
                </ThemedText>
              </ThemedView>
            )
          }
        />

        <ThemedView style={{ paddingBottom: BottomTabInset }}>
          <PrimaryButton
            title="＋ 绑定新设备"
            onPress={() => router.push('/bind-device')}
          />
        </ThemedView>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 20, gap: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  card: { borderRadius: 14, padding: 16, gap: 6 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  online: { color: '#2E9E5B' },
  offline: { color: '#999' },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 48 },
});
