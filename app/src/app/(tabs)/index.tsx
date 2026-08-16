// 我的设备（Home 标签）：设备列表 + 绑定入口 + 退出登录（API.md §4 GET /devices）
// 2026-08-16 风格迭代：监控台风格——KPI 指标行 + 描边卡片 + 状态药丸 + 电量条
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { DevicePublic } from '@helmet/shared';

import { devicesApi } from '@/api/devices';
import { toUserMessage } from '@/api/error-messages';
import { Badge } from '@/components/badge';
import { PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuthStore } from '@/stores/auth-store';

function BatteryBar({ level }: { level: number | null }) {
  const theme = useTheme();
  if (level === null) return null;
  const color =
    level <= 20 ? theme.danger : level <= 40 ? theme.warning : theme.success;
  return (
    <View style={[styles.batteryTrack, { backgroundColor: theme.backgroundSelected }]}>
      <View
        style={[
          styles.batteryFill,
          { width: `${Math.max(2, Math.min(100, level))}%`, backgroundColor: color },
        ]}
      />
    </View>
  );
}

function DeviceRow({ device }: { device: DevicePublic }) {
  const theme = useTheme();
  return (
    <Pressable onPress={() => router.push(`/device/${device.deviceId}`)}>
      {({ pressed }) => (
        <View
          style={[
            styles.card,
            {
              backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
              borderColor: theme.border,
            },
          ]}>
          <View style={styles.cardHeader}>
            <ThemedText type="subtitle" style={styles.deviceId}>
              {device.deviceId}
            </ThemedText>
            <Badge
              variant={device.online ? 'success' : 'neutral'}
              label={device.online ? '在线' : '离线'}
            />
          </View>
          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <ThemedText type="label" themeColor="textSecondary">
                电量
              </ThemedText>
              <ThemedText type="smallBold">
                {device.battery !== null ? `${device.battery}%` : '—'}
                {device.charging ? ' ⚡' : ''}
              </ThemedText>
            </View>
            <View style={styles.metaItem}>
              <ThemedText type="label" themeColor="textSecondary">
                固件
              </ThemedText>
              <ThemedText type="smallBold">{device.firmwareVersion ?? '未知'}</ThemedText>
            </View>
            <View style={styles.metaItem}>
              <ThemedText type="label" themeColor="textSecondary">
                状态
              </ThemedText>
              <ThemedText type="smallBold">{device.sleeping ? '休眠' : '活动'}</ThemedText>
            </View>
          </View>
          <BatteryBar level={device.battery} />
        </View>
      )}
    </Pressable>
  );
}

function KpiChip({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.kpi,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}>
      <ThemedText type="label" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="display" style={styles.kpiValue}>
        {value}
      </ThemedText>
    </View>
  );
}

export default function MyDevicesScreen() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: devicesApi.list,
    // 轮询作可靠性兜底（实时通道合入后 WS 推送为主）
    refetchInterval: 30_000,
  });

  const list = devices.data ?? [];
  const onlineCount = list.filter((d) => d.online).length;

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <View style={styles.header}>
          <View>
            <ThemedText type="title" style={styles.pageTitle}>
              我的设备
            </ThemedText>
            {user && (
              <ThemedText type="small" themeColor="textSecondary">
                {user.nickname ?? user.phone}
              </ThemedText>
            )}
          </View>
          <Pressable onPress={() => void signOut()} hitSlop={8}>
            <ThemedText type="small" themeColor="textSecondary">
              退出登录
            </ThemedText>
          </Pressable>
        </View>

        <View style={styles.kpiRow}>
          <KpiChip label="设备总数" value={String(list.length)} />
          <KpiChip label="在线" value={String(onlineCount)} />
        </View>

        {devices.isError && (
          <ThemedText type="small">{toUserMessage(devices.error)}</ThemedText>
        )}

        <FlatList
          style={styles.flex}
          contentContainerStyle={{ paddingBottom: 16, gap: 12 }}
          data={list}
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
              <View style={styles.empty}>
                <ThemedText type="subtitle">还没有绑定头盔</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  绑定后可以查看在线状态、电量和骑行安全信息
                </ThemedText>
              </View>
            )
          }
        />

        <View style={{ paddingBottom: BottomTabInset }}>
          <PrimaryButton
            title="＋ 绑定新设备"
            onPress={() => router.push('/bind-device')}
          />
        </View>
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 20, gap: 16 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  pageTitle: { fontSize: 32, lineHeight: 38 },
  kpiRow: { flexDirection: 'row', gap: 12 },
  kpi: {
    flex: 1,
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 14,
    gap: 4,
  },
  kpiValue: { fontSize: 28, lineHeight: 32 },
  card: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  deviceId: { fontSize: 20, lineHeight: 26 },
  metaRow: { flexDirection: 'row', gap: 20 },
  metaItem: { gap: 2 },
  batteryTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  batteryFill: { height: 4, borderRadius: 2 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 48 },
});
