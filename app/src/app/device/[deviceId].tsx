// 设备状态页（API.md §4 /devices/{id} + /devices/{id}/status；online 以服务端计算为准）
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet } from 'react-native';

import { devicesApi } from '@/api/devices';
import { toUserMessage } from '@/api/error-messages';
import { PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <ThemedView type="backgroundElement" style={styles.row}>
      <ThemedText type="small">{label}</ThemedText>
      <ThemedText type="smallBold">{value}</ThemedText>
    </ThemedView>
  );
}

export default function DeviceDetailScreen() {
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const queryClient = useQueryClient();
  const [unbinding, setUnbinding] = useState(false);

  const status = useQuery({
    queryKey: ['device-status', deviceId],
    queryFn: () => devicesApi.status(deviceId),
    // 心跳 60s + 在线窗口 90s：15s 轮询足够贴近实时（Week 5–6 换 WebSocket）
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
  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">{deviceId}</ThemedText>

      {status.isError && (
        <ThemedText type="small">{toUserMessage(status.error)}</ThemedText>
      )}

      {s && (
        <>
          <Row label="状态" value={s.online ? '在线' : '离线'} />
          <Row
            label="电量"
            value={s.battery !== null ? `${s.battery}%${s.charging ? '（充电中）' : ''}` : '未上报'}
          />
          <Row
            label="信号"
            value={s.signalLevel !== null ? `${s.signalLevel}` : '未上报'}
          />
          <Row label="休眠" value={s.sleeping ? '休眠中' : '活动中'} />
          <Row label="固件版本" value={s.firmwareVersion ?? '未知'} />
          <Row
            label="最后心跳"
            value={s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '从未上报'}
          />
        </>
      )}

      <ThemedView style={styles.footer}>
        <PrimaryButton title="解除绑定" onPress={unbind} loading={unbinding} danger />
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 10 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  footer: { marginTop: 'auto' },
});
