// 事故详情（API.md §7 GET /accidents/{id}）：状态流转 + 位置快照 + 通知发送记录（手机号已脱敏）
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { toUserMessage } from '@/api/error-messages';
import { sosApi } from '@/api/sos';
import { Badge } from '@/components/badge';
import { AmapView, type AmapViewHandle } from '@/components/map/amap-view';
import { toGcj02 } from '@/components/map/coords';
import { openAmapNavigation } from '@/components/map/nav-links';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={[styles.row, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
      <ThemedText type="label" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="smallBold" style={styles.rowValue}>
        {value}
      </ThemedText>
    </View>
  );
}

export default function AccidentDetailScreen() {
  const { accidentId } = useLocalSearchParams<{ accidentId: string }>();
  const theme = useTheme();
  const detail = useQuery({
    queryKey: ['accident', accidentId],
    queryFn: () => sosApi.accidentDetail(accidentId),
  });

  const d = detail.data;
  const mapRef = useRef<AmapViewHandle>(null);
  const gcjPos = d?.location ? toGcj02(d.location) : null;

  // 位置就绪后落点(小地图 ready 前命令会排队,双保险:数据到达时也推一次)
  useEffect(() => {
    if (gcjPos) mapRef.current?.setHelmet(gcjPos, { follow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gcjPos?.longitude, gcjPos?.latitude]);

  return (
    <ThemedView style={styles.flex}>
      <ScrollView contentContainerStyle={styles.container}>
        {detail.isError && (
          <ThemedText type="small">{toUserMessage(detail.error)}</ThemedText>
        )}
        {d && (
          <>
            <View style={styles.titleRow}>
              <ThemedText type="title" style={styles.title}>
                {d.triggerType === 'manual_sos' ? '手动求救' : '跌倒检测'}
              </ThemedText>
              <Badge
                variant={
                  d.status === 'pending' ? 'danger' : d.status === 'notified' ? 'warning' : 'neutral'
                }
                label={
                  d.status === 'pending' ? '进行中' : d.status === 'notified' ? '已通知' : '已取消'
                }
              />
            </View>

            <Row label="设备" value={d.deviceId} />
            <Row label="触发时间" value={new Date(d.createdAt).toLocaleString()} />
            <Row label="倒计时截止" value={new Date(d.deadline).toLocaleString()} />
            <Row
              label="事故位置"
              value={
                d.location
                  ? `${d.location.latitude.toFixed(5)}, ${d.location.longitude.toFixed(5)}（${
                      d.location.source === 'event' ? '事件内嵌' : '最近轨迹点'
                    }）`
                  : '无位置信息'
              }
            />

            {/* 事故地点小地图 + 一键导航(监护场景核心:赶到现场) */}
            {d.location && gcjPos && (
              <View
                style={[styles.mapCard, { borderColor: theme.border }]}>
                <AmapView
                  style={styles.map}
                  controllerRef={mapRef}
                  onReady={() => mapRef.current?.setHelmet(gcjPos, { follow: true })}
                />
                <Pressable
                  style={[styles.navBtn, { backgroundColor: theme.danger }]}
                  onPress={() => void openAmapNavigation(gcjPos, '事故地点')}>
                  <Ionicons name="navigate" size={16} color="#fff" />
                  <ThemedText type="smallBold" style={styles.navBtnText}>
                    导航到事故地点
                  </ThemedText>
                </Pressable>
              </View>
            )}

            <ThemedText type="subtitle" style={styles.sectionTitle}>
              通知记录
            </ThemedText>
            {d.notifications.length === 0 && (
              <ThemedText type="small" themeColor="textSecondary">
                未发送通知（倒计时内取消）
              </ThemedText>
            )}
            {d.notifications.map((n) => (
              <View
                key={n.id}
                style={[
                  styles.notifRow,
                  { backgroundColor: theme.backgroundElement, borderColor: theme.border },
                ]}>
                <Ionicons
                  name={n.channel === 'sms' ? 'chatbubble-outline' : 'notifications-outline'}
                  size={18}
                  color={theme.textSecondary}
                />
                <View style={styles.notifBody}>
                  <ThemedText type="smallBold">
                    {n.contactName ?? '联系人'} · {n.target}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {n.channel.toUpperCase()} · 尝试 {n.attempts} 次
                    {n.sentAt ? ` · ${new Date(n.sentAt).toLocaleTimeString()}` : ''}
                  </ThemedText>
                </View>
                <Badge
                  variant={n.status === 'sent' ? 'success' : n.status === 'failed' ? 'danger' : 'warning'}
                  label={n.status === 'sent' ? '已送达' : n.status === 'failed' ? '失败' : '发送中'}
                />
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  mapCard: {
    height: 240,
    borderRadius: Radius.card,
    borderWidth: 1,
    overflow: 'hidden',
  },
  map: { flex: 1 },
  navBtn: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: Radius.pill,
    paddingVertical: 12,
  },
  navBtnText: { color: '#fff', fontSize: 14 },
  flex: { flex: 1 },
  container: { padding: 20, gap: 10 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: { fontSize: 26, lineHeight: 32 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowValue: { flexShrink: 1, textAlign: 'right' },
  sectionTitle: { fontSize: 20, lineHeight: 26, marginTop: 12 },
  notifRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: Radius.control,
    borderWidth: 1,
    padding: 14,
  },
  notifBody: { flex: 1, gap: 2 },
});
