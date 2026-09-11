// 事故记录列表（2026-09-10 从安全页拆出）：全部设备的求救单，最新在前；点行进详情
import { Ionicons } from '@expo/vector-icons';
import { useQueries, useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { AccidentListItem } from '@helmet/shared';

import { devicesApi } from '@/api/devices';
import { sosApi } from '@/api/sos';
import { Badge } from '@/components/badge';
import { Card, IconCircle } from '@/components/list';
import { Tappable } from '@/components/tappable';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { useLocale, useT } from '@/i18n';
import { shortDate, shortTime } from '@/i18n/format';

function AccidentRow({ item, last }: { item: AccidentListItem; last: boolean }) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const status =
    item.status === 'pending'
      ? { variant: 'danger' as const, label: t('safety.status.pending') }
      : item.status === 'notified'
        ? { variant: 'warning' as const, label: t('safety.status.notified') }
        : { variant: 'neutral' as const, label: t('safety.status.cancelled') };
  return (
    <Tappable
      feedback="fill"
      onPress={() => router.push(`/accident/${item.sosId}`)}
      style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }]}>
      <IconCircle
        icon={item.triggerType === 'manual_sos' ? 'hand-left-outline' : 'body-outline'}
        color={theme.danger}
        bg={theme.dangerBg}
      />
      <View style={styles.body}>
        <ThemedText type="small" style={{ fontSize: 15 }}>
          {item.triggerType === 'manual_sos' ? t('safety.manualSos') : t('safety.fallDetected')}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={{ fontSize: 13 }} numberOfLines={1}>
          {item.deviceId} · {shortDate(item.createdAt, locale)} {shortTime(item.createdAt, locale)}
        </ThemedText>
      </View>
      <Badge variant={status.variant} label={status.label} />
      <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />
    </Tappable>
  );
}

export default function AccidentsScreen() {
  const t = useT();
  const devices = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list });
  const deviceIds = (devices.data ?? []).map((d) => d.deviceId);
  const accidents = useQueries({
    queries: deviceIds.map((id) => ({ queryKey: ['accidents', id], queryFn: () => sosApi.accidents(id) })),
  });
  const items = accidents
    .flatMap((q) => q.data?.items ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <ThemedView style={styles.flex}>
      <ScrollView contentContainerStyle={styles.container}>
        {items.length > 0 ? (
          <Card>
            {items.map((a, i) => (
              <AccidentRow key={a.sosId} item={a} last={i === items.length - 1} />
            ))}
          </Card>
        ) : (
          <View style={styles.empty}>
            <ThemedText type="small" themeColor="textSecondary">
              {t('safety.accidentsNone')}
            </ThemedText>
          </View>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  empty: { alignItems: 'center', paddingVertical: 40 },
});
