// 我的设备（Home 标签）：设备列表 + 绑定入口 + 退出登录（API.md §4 GET /devices）
// 2026-08-16 风格迭代：监控台风格——KPI 指标行 + 描边卡片 + 状态药丸 + 电量条
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
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
import { Skeleton } from '@/components/skeleton';
import { PrimaryButton } from '@/components/form';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius } from '@/constants/theme';
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

/** 头盔演示图池：设备暂无型号字段（待硬件定稿），按 deviceId 稳定散列分配——
 *  同一设备永远同一张图，不同设备尽量错开。正式型号图到位后改为按型号映射。 */
const HELMET_IMAGES = [
  require('@/assets/images/helmet-urban-v5.webp'),
  require('@/assets/images/helmet-ski-v5.webp'),
] as const;

function helmetImageFor(deviceId: string) {
  let x = 0;
  for (const c of deviceId) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return HELMET_IMAGES[x % HELMET_IMAGES.length];
}

/** 信号强度文案（DeviceStatus.signalLevel：数值越大越强；口径待硬件定稿前按相对档显示） */
function signalLabel(level: number | null): string {
  if (level === null) return '—';
  if (level >= 3) return '强';
  if (level >= 2) return '中';
  return '弱';
}

function StatCell({
  icon,
  label,
  value,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  value: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.statCell}>
      <MaterialCommunityIcons name={icon} size={16} color={theme.textSecondary} />
      <View>
        <ThemedText type="label" themeColor="textSecondary">
          {label}
        </ThemedText>
        <ThemedText type="smallBold">{value}</ThemedText>
      </View>
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
          <View style={styles.cardTop}>
            {/* 头盔产品图（演示素材，按设备稳定分配；正式型号图待硬件出型号字段后按型号映射）。
                wrapper 撑满本节高度,头盔在空白区域纵向精确居中 */}
            <View style={styles.helmetBox}>
              <Image
                source={helmetImageFor(device.deviceId)}
                style={styles.helmetImage}
                contentFit="cover"
              />
            </View>
            <View style={styles.cardInfo}>
              <View style={styles.cardTitleRow}>
                <ThemedText type="subtitle" style={styles.deviceId} numberOfLines={1}>
                  {device.name ?? device.deviceId}
                </ThemedText>
                <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
              </View>
              <View style={styles.badgeRow}>
                <Badge
                  variant={device.online ? 'success' : 'neutral'}
                  label={device.online ? '在线' : '离线'}
                />
              </View>
              <ThemedText type="small" themeColor="textSecondary">
                固件 {device.firmwareVersion ?? '未知'}
              </ThemedText>
              <View style={styles.batteryBlock}>
                <View style={styles.batteryValueRow}>
                  <ThemedText type="display" style={styles.batteryValue}>
                    {device.battery !== null ? device.battery : '—'}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    %{device.charging ? ' · 充电中 ⚡' : ''}
                  </ThemedText>
                </View>
                <BatteryBar level={device.battery} />
              </View>
            </View>
          </View>

          <View style={[styles.cardDivider, { backgroundColor: theme.border }]} />

          <View style={styles.statsRow}>
            <StatCell icon="signal" label="信号" value={signalLabel(device.signalLevel)} />
            <StatCell
              icon={device.sleeping ? 'sleep' : 'motion-sensor'}
              label="状态"
              value={device.sleeping ? '休眠' : '活动'}
            />
            <StatCell icon="sync" label="上次同步" value={relativeTime(device.lastSeenAt)} />
          </View>
        </View>
      )}
    </Pressable>
  );
}

function KpiChip({
  label,
  value,
  caption,
  captionHighlight = false,
  icon,
}: {
  label: string;
  value: string;
  caption: string;
  captionHighlight?: boolean;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.kpi,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}>
      <View style={styles.kpiHeader}>
        <View style={[styles.kpiIcon, { backgroundColor: theme.backgroundSelected }]}>
          <MaterialCommunityIcons name={icon} size={18} color={theme.textSecondary} />
        </View>
        <ThemedText type="label" themeColor="textSecondary">
          {label}
        </ThemedText>
      </View>
      <ThemedText type="display" style={styles.kpiValue}>
        {value}
      </ThemedText>
      <ThemedText
        type="small"
        style={{ color: captionHighlight ? theme.brand : theme.textSecondary, fontSize: 12 }}>
        {caption}
      </ThemedText>
    </View>
  );
}

/** 相对时间（参考稿的 "1m ago" 语感，中文口径） */
function relativeTime(iso: string | null): string {
  if (!iso) return '从未';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec} 秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
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
          <KpiChip
            label="设备总数"
            value={String(list.length)}
            caption="全部头盔"
            icon="racing-helmet"
          />
          <KpiChip
            label="在线"
            value={String(onlineCount)}
            icon="access-point"
            caption={
              list.length > 0
                ? `在线率 ${Math.round((onlineCount / list.length) * 100)}%`
                : '暂无设备'
            }
            captionHighlight={list.length > 0 && onlineCount === list.length}
          />
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
            devices.isLoading ? (
              <View style={styles.skeletonWrap}>
                {[0, 1].map((i) => (
                  <View key={i} style={styles.skeletonCard}>
                    <Skeleton width={96} height={96} radius={16} />
                    <View style={styles.skeletonLines}>
                      <Skeleton width="55%" height={18} />
                      <Skeleton width="35%" height={13} />
                      <Skeleton width="75%" height={13} />
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.empty}>
                <ThemedText type="subtitle">还没有绑定头盔</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  绑定后可以查看在线状态、电量和骑行安全信息
                </ThemedText>
              </View>
            )
          }
        />

        {/* 主 CTA 固定在底部标签栏正上方（对齐定稿套图） */}
        <View style={styles.bottomCta}>
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
  skeletonWrap: { gap: 14, paddingTop: 4 },
  skeletonCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 22,
    padding: 18,
  },
  skeletonLines: { flex: 1, gap: 10 },
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
  kpiHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kpiIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kpiValue: { fontSize: 28, lineHeight: 32 },
  card: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  cardTop: { flexDirection: 'row', gap: 14 },
  helmetBox: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    alignItems: 'center',
    width: 136,
    marginLeft: -4,
  },
  helmetImage: { width: 136, height: 136 },
  cardInfo: { flex: 1, gap: 5 },
  cardTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badgeRow: { flexDirection: 'row' },
  deviceId: { fontSize: 19, lineHeight: 25, flex: 1 },
  batteryBlock: { gap: 5, marginTop: 2 },
  batteryValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  batteryValue: { fontSize: 26, lineHeight: 30 },
  cardDivider: { height: StyleSheet.hairlineWidth },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statCell: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 },
  batteryTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  batteryFill: { height: 4, borderRadius: 2 },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 48 },
  bottomCta: { paddingTop: 4, paddingBottom: 10 },
});
