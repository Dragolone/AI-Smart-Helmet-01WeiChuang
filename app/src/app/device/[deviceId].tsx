// 设备状态页（API.md §4 /devices/{id} + /devices/{id}/status；online 以服务端计算为准）
// 2026-08-16 风格迭代：大标识标题 + 状态药丸 + 电量仪表卡 + 数据行卡片
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { devicesApi } from '@/api/devices';
import { showToast } from '@/components/toast';
import { toUserMessage } from '@/api/error-messages';
import { Badge } from '@/components/badge';
import { BatteryChart } from '@/components/battery-chart';
import { FormInput, PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}>
      <View style={styles.rowLeft}>
        <Ionicons name={icon} size={16} color={theme.textSecondary} />
        <ThemedText type="label" themeColor="textSecondary">
          {label}
        </ThemedText>
      </View>
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

  // 24h 电量历史（10 分钟桶；60s 心跳 → 每分钟刷新即可）
  const battery = useQuery({
    queryKey: ['device-battery-history', deviceId],
    queryFn: () => devicesApi.batteryHistory(deviceId, 24),
    refetchInterval: 60_000,
  });

  // 详情（name/bindCode 等静态信息，与状态分开缓存）
  const detail = useQuery({
    queryKey: ['device-detail', deviceId],
    queryFn: () => devicesApi.detail(deviceId),
  });

  // 设备设置（§8 命令+回执状态机）:有未终态命令时 2s 快轮询直到回执/超时
  const settings = useQuery({
    queryKey: ['device-settings', deviceId],
    queryFn: () => devicesApi.settings(deviceId),
    refetchInterval: (q) => {
      const st = q.state.data?.lastCommand?.status;
      return st === 'pending' || st === 'delivered' ? 2_000 : 30_000;
    },
  });
  const [sending, setSending] = useState(false);

  const sendSetting = (key: string, value: string | number | boolean) => {
    setSending(true);
    devicesApi
      .putSettings(deviceId, { settings: { [key]: value } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['device-settings', deviceId] }))
      .catch((e) => Alert.alert('下发失败', toUserMessage(e)))
      .finally(() => setSending(false));
  };

  const lastCmd = settings.data?.lastCommand ?? null;
  const cmdStatusText =
    lastCmd == null
      ? null
      : lastCmd.status === 'pending'
        ? { text: '下发中…', color: theme.warning }
        : lastCmd.status === 'delivered'
          ? { text: '已送达设备,等待执行回执', color: theme.warning }
          : lastCmd.status === 'success'
            ? { text: `执行成功 · ${lastCmd.executedAt ? new Date(lastCmd.executedAt).toLocaleTimeString() : ''}`, color: theme.success }
            : lastCmd.status === 'failed'
              ? { text: `执行失败${lastCmd.errorCode ? `（${lastCmd.errorCode}）` : ''}`, color: theme.danger }
              : { text: '设备离线未送达(绝不显示为已生效)', color: theme.textSecondary };

  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);

  const openRename = () => {
    setNameDraft(detail.data?.name ?? '');
    setRenameOpen(true);
  };

  const submitRename = () => {
    setRenaming(true);
    devicesApi
      .rename(deviceId, { name: nameDraft })
      .then(async () => {
        setRenameOpen(false);
        showToast('已重命名');
        // 列表/详情/地图药丸同步刷新
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['device-detail', deviceId] }),
          queryClient.invalidateQueries({ queryKey: ['devices'] }),
        ]);
      })
      .catch((e) => Alert.alert('重命名失败', toUserMessage(e)))
      .finally(() => setRenaming(false));
  };

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
    <ThemedView style={styles.flex}>
      {/* 内容随设置区增长会超出一屏,必须可滚动(Android 实证:小屏下半截不可见且无法下滑) */}
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}>
      <View style={styles.titleRow}>
        <Pressable style={styles.titlePress} onPress={openRename} hitSlop={6}>
          <ThemedText type="title" style={styles.title} numberOfLines={1}>
            {detail.data?.name ?? deviceId}
          </ThemedText>
          <Ionicons name="pencil-outline" size={18} color={theme.textSecondary} />
        </Pressable>
        {s && (
          <Badge
            variant={s.online ? 'success' : 'neutral'}
            label={s.online ? '在线' : '离线'}
          />
        )}
      </View>
      {detail.data?.name && (
        <ThemedText type="small" themeColor="textSecondary" style={styles.subId}>
          {deviceId}
        </ThemedText>
      )}

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
            <BatteryChart
              points={battery.data?.points ?? []}
              to={battery.data?.to}
              current={s.battery}
              charging={s.charging}
              labels={{ title: '电量', window: '过去 24 小时', charging: '充电中', empty: '暂无电量记录' }}
            />
          </View>

          <InfoRow
            icon="cellular-outline"
            label="信号"
            value={s.signalLevel !== null ? String(s.signalLevel) : '未上报'}
          />
          <InfoRow
            icon={s.sleeping ? 'moon-outline' : 'flash-outline'}
            label="工作状态"
            value={s.sleeping ? '休眠中' : '活动中'}
          />
          <InfoRow
            icon="hardware-chip-outline"
            label="固件版本"
            value={s.firmwareVersion ?? '未知'}
          />
          <InfoRow
            icon="time-outline"
            label="最后心跳"
            value={s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '从未上报'}
          />
          <InfoRow
            icon="key-outline"
            label="绑定码"
            value={detail.data?.bindCode ?? '—'}
          />

          {/* 设备设置下发（§8;参数为演示项,清单与值域待硬件定稿 ⚠️） */}
          <View
            style={[styles.settingsCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
            <View style={styles.settingsHeader}>
              <ThemedText type="smallBold" style={{ fontSize: 15 }}>
                设备设置
              </ThemedText>
              <ThemedText type="label" themeColor="textSecondary">
                演示参数 · 待硬件定稿
              </ThemedText>
            </View>

            <View style={styles.settingRow}>
              <ThemedText type="small" themeColor="textSecondary">
                蜂鸣音量
              </ThemedText>
              <View style={styles.chipGroup}>
                {[50, 75, 100].map((v) => {
                  const active = settings.data?.settings.volume === v;
                  return (
                    <Pressable key={v} disabled={sending} onPress={() => sendSetting('volume', v)}>
                      <View
                        style={[
                          styles.settingChip,
                          {
                            backgroundColor: active ? theme.brand : theme.backgroundSelected,
                          },
                        ]}>
                        <ThemedText
                          type="smallBold"
                          style={{ fontSize: 13, color: active ? theme.onBrand : theme.textSecondary }}>
                          {v}
                        </ThemedText>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.settingRow}>
              <ThemedText type="small" themeColor="textSecondary">
                示廓灯
              </ThemedText>
              <View style={styles.chipGroup}>
                {[
                  { v: true, label: '开' },
                  { v: false, label: '关' },
                ].map(({ v, label }) => {
                  const active = settings.data?.settings.light === v;
                  return (
                    <Pressable key={label} disabled={sending} onPress={() => sendSetting('light', v)}>
                      <View
                        style={[
                          styles.settingChip,
                          {
                            backgroundColor: active ? theme.brand : theme.backgroundSelected,
                          },
                        ]}>
                        <ThemedText
                          type="smallBold"
                          style={{ fontSize: 13, color: active ? theme.onBrand : theme.textSecondary }}>
                          {label}
                        </ThemedText>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {cmdStatusText && (
              <ThemedText type="small" style={{ color: cmdStatusText.color }}>
                最近下发:{cmdStatusText.text}
              </ThemedText>
            )}
          </View>
        </>
      )}


        <View style={styles.footer}>
          <PrimaryButton title="解除绑定" onPress={unbind} loading={unbinding} danger />
        </View>
      </ScrollView>

      {/* 重命名弹层（跨平台；Alert.prompt 仅 iOS 可用故自建） */}
      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <Pressable style={styles.modalMask} onPress={() => setRenameOpen(false)}>
          <Pressable
            style={[styles.modalCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}
            onPress={() => undefined}>
            <ThemedText type="subtitle">重命名设备</ThemedText>
            <FormInput
              label="设备名"
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder="1-20 字符；留空恢复默认(设备号)"
              maxLength={20}
              autoFocus
            />
            <PrimaryButton title="保存" onPress={submitRename} loading={renaming} />
          </Pressable>
        </Pressable>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 12, paddingBottom: 28 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: { fontSize: 30, lineHeight: 36, flexShrink: 1 },
  titlePress: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, marginRight: 10 },
  subId: { marginTop: -8 },
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
  batteryCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  settingsCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  settingsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chipGroup: { flexDirection: 'row', gap: 8 },
  settingChip: {
    borderRadius: Radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  footer: { marginTop: 8 },
});
