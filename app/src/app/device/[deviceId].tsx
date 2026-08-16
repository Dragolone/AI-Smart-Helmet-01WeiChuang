// 设备状态页（API.md §4 /devices/{id} + /devices/{id}/status；online 以服务端计算为准）
// 2026-08-16 风格迭代：大标识标题 + 状态药丸 + 电量仪表卡 + 数据行卡片
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { devicesApi } from '@/api/devices';
import { toUserMessage } from '@/api/error-messages';
import { Badge } from '@/components/badge';
import { PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

function InfoRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}>
      <ThemedText type="label" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="smallBold">{value}</ThemedText>
    </View>
  );
}

export default function DeviceDetailScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [unbinding, setUnbinding] = useState(false);

  const status = useQuery({
    queryKey: ['device-status', deviceId],
    queryFn: () => devicesApi.status(deviceId),
    // 心跳 60s + 在线窗口 90s：15s 轮询兜底（WS 推送为主）
    refetchInterval: 15_000,
  });

  const unbind = () => {
    Alert.alert('解除绑定', `确定解绑 ${deviceId} 吗？历史数据会保留。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '解绑',
        style: 'destructive',
        onPress: () => {
          setUnbinding(true);
          devicesApi
            .unbind(deviceId)
            .then(async () => {
              await queryClient.invalidateQueries({ queryKey: ['devices'] });
              router.back();
            })
            .catch((e) => Alert.alert('解绑失败', toUserMessage(e)))
            .finally(() => setUnbinding(false));
        },
      },
    ]);
  };

  const s = status.data;
  const batteryColor =
    s?.battery == null
      ? theme.textSecondary
      : s.battery <= 20
        ? theme.danger
        : s.battery <= 40
          ? theme.warning
          : theme.success;

  return (
    <ThemedView style={styles.container}>
      <View style={styles.titleRow}>
        <ThemedText type="title" style={styles.title}>
          {deviceId}
        </ThemedText>
        {s && (
          <Badge
            variant={s.online ? 'success' : 'neutral'}
            label={s.online ? '在线' : '离线'}
          />
        )}
      </View>

      {status.isError && (
        <ThemedText type="small">{toUserMessage(status.error)}</ThemedText>
      )}

      {s && (
        <>
          <View
            style={[
              styles.batteryCard,
              { backgroundColor: theme.backgroundElement, borderColor: theme.border },
            ]}>
            <ThemedText type="label" themeColor="textSecondary">
              电量
            </ThemedText>
            <View style={styles.batteryValueRow}>
              <ThemedText type="display" style={{ color: batteryColor }}>
                {s.battery !== null ? `${s.battery}%` : '—'}
              </ThemedText>
              {s.charging ? (
                <Badge variant="warning" label="充电中" />
              ) : null}
            </View>
            <View style={[styles.batteryTrack, { backgroundColor: theme.backgroundSelected }]}>
              <View
                style={[
                  styles.batteryFill,
                  {
                    width: `${Math.max(2, Math.min(100, s.battery ?? 0))}%`,
                    backgroundColor: batteryColor,
                  },
                ]}
              />
            </View>
          </View>

          <InfoRow
            label="信号"
            value={s.signalLevel !== null ? String(s.signalLevel) : '未上报'}
          />
          <InfoRow label="工作状态" value={s.sleeping ? '休眠中' : '活动中'} />
          <InfoRow label="固件版本" value={s.firmwareVersion ?? '未知'} />
          <InfoRow
            label="最后心跳"
            value={s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '从未上报'}
          />
        </>
      )}

      <View style={styles.footer}>
        <PrimaryButton title="解除绑定" onPress={unbind} loading={unbinding} danger />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: { fontSize: 30, lineHeight: 36 },
  batteryCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  batteryValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  batteryTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  batteryFill: { height: 6, borderRadius: 3 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  footer: { marginTop: 'auto' },
});
