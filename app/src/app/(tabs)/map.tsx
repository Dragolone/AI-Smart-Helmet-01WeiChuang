// 地图（底部标签）：占位版——高德 SDK 待企业 Key 定案后接入（DECISIONS 待定项）。
// 实时数据链路已就绪：WS location_update 直写缓存，本页先以数据卡形式呈现（对齐套图指标卡）。
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { WsLocationData } from '@helmet/shared';

import { devicesApi } from '@/api/devices';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

function Stat({
  icon,
  label,
  value,
  unit,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  value: string;
  unit: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.stat}>
      <MaterialCommunityIcons name={icon} size={20} color={theme.brand} />
      <ThemedText type="label" themeColor="textSecondary">
        {label}
      </ThemedText>
      <View style={styles.statValueRow}>
        <ThemedText type="display" style={styles.statValue}>
          {value}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {unit}
        </ThemedText>
      </View>
    </View>
  );
}

export default function MapScreen() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: ['devices'], queryFn: devicesApi.list });
  const firstDevice = devices.data?.[0]?.deviceId;

  // WS 推送直写此缓存（use-realtime）；这里订阅它以驱动渲染（react-query 不允许 undefined，用 null 表示"暂无"）
  const location = useQuery<WsLocationData | null>({
    queryKey: ['device-location', firstDevice],
    queryFn: () =>
      queryClient.getQueryData<WsLocationData>(['device-location', firstDevice]) ?? null,
    enabled: !!firstDevice,
    refetchInterval: 3000,
  });

  const loc = location.data;

  return (
    <SafeAreaView style={styles.flex}>
      <ThemedView style={styles.container}>
        <ThemedText type="title" style={styles.pageTitle}>
          地图
        </ThemedText>

        <View
          style={[styles.mapPlaceholder, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
          <Ionicons name="map-outline" size={44} color={theme.textSecondary} />
          <ThemedText type="smallBold">高德地图接入中</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            等待企业认证 Key 下发后接入地图 SDK{'\n'}实时位置数据链路已就绪（见下方实时数据）
          </ThemedText>
        </View>

        {loc ? (
          <View
            style={[styles.statsCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
            <View style={styles.statsHeader}>
              <ThemedText type="smallBold">{loc.deviceId}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {new Date(loc.timestamp).toLocaleTimeString()}
              </ThemedText>
            </View>
            <View style={styles.statsRow}>
              <Stat
                icon="speedometer"
                label="速度"
                value={(loc.speed * 3.6).toFixed(0)}
                unit="km/h"
              />
              <Stat
                icon="image-filter-hdr"
                label="海拔"
                value={loc.altitude !== null ? loc.altitude.toFixed(0) : '—'}
                unit="m"
              />
              <Stat
                icon="crosshairs-gps"
                label="精度"
                value={loc.accuracy.toFixed(0)}
                unit="m"
              />
            </View>
            <ThemedText type="small" themeColor="textSecondary">
              {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}（{loc.coordinateSystem}）
            </ThemedText>
          </View>
        ) : (
          <ThemedText type="small" themeColor="textSecondary">
            {firstDevice ? '等待设备位置上报…' : '绑定设备后这里会显示实时位置数据'}
          </ThemedText>
        )}
      </ThemedView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, padding: 20, gap: 14 },
  pageTitle: { fontSize: 32, lineHeight: 38 },
  mapPlaceholder: {
    borderRadius: Radius.card,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 56,
  },
  centerText: { textAlign: 'center' },
  statsCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 16,
    gap: 14,
  },
  statsHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { gap: 4, alignItems: 'flex-start' },
  statValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  statValue: { fontSize: 26, lineHeight: 30 },
});
