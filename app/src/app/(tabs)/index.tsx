// 设备（首页标签，2026-09-10 重设计）：
// 顶部「当前设备」大卡（头盔图 + 骑行状态 + 电量/速度/同步）→ 「全部设备」逐行列表 → 底部描边「绑定新设备」。
// 数据：GET /devices（30s 轮询兜底，WS 直写缓存）+ 当前设备最新位置（与地图页同一 query key，缓存共享）。
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import type {
  DevicePublic,
  LocationPoint,
  WsLocationData,
} from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { toUserMessage } from "@/api/error-messages";
import { PrimaryButton, SecondaryButton } from "@/components/form";
import { Card, SectionLabel } from "@/components/list";
import { Skeleton } from "@/components/skeleton";
import { ValueTransition, listEntering } from "@/components/motion";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT } from "@/i18n";
import { relativeTime } from "@/i18n/format";
import { BleBlockerBanner } from "@/components/ble-onboarding";
import { EmptyState } from "@/components/empty-state";
import { RideSummaryCard } from "@/components/ride-summary";

/** 头盔演示图池：设备暂无型号字段（待硬件定稿），按 deviceId 稳定散列分配 */
const HELMET_IMAGES = [
  require("@/assets/images/helmet-urban-v5.webp"),
  require("@/assets/images/helmet-ski-v5.webp"),
] as const;

function helmetImageFor(deviceId: string) {
  let x = 0;
  for (const c of deviceId) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return HELMET_IMAGES[x % HELMET_IMAGES.length];
}

/** 骑行判定阈值：> 1 m/s 视为骑行中（与头盔固件运动态口径一致，BLE 协议 v0.6 §4.0） */
const RIDING_MPS = 1;

function Pill({ label, tone }: { label: string; tone: "brand" | "neutral" }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.pill,
        {
          backgroundColor:
            tone === "brand" ? theme.brand : theme.backgroundSelected,
        },
      ]}
    >
      <ThemedText
        type="smallBold"
        style={{
          fontSize: 12,
          lineHeight: 16,
          color: tone === "brand" ? theme.onBrand : theme.textSecondary,
        }}
      >
        {label}
      </ThemedText>
    </View>
  );
}

function Dot({ online }: { online: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.dot,
        { backgroundColor: online ? theme.success : theme.textSecondary },
      ]}
    />
  );
}

function batteryColor(
  level: number | null,
  theme: ReturnType<typeof useTheme>,
) {
  if (level === null) return theme.textSecondary;
  return level <= 20 ? theme.danger : theme.brand;
}

function HeroCard({ device }: { device: DevicePublic }) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  // 与地图页共用缓存 key：WS 位置推送直写，这里免费拿到实时速度
  const live = useQuery<WsLocationData | LocationPoint | null>({
    queryKey: ["device-location", device.deviceId],
    queryFn: async () =>
      (await devicesApi.latestLocation(device.deviceId)).location,
    refetchInterval: 30_000,
  });
  const speedKmh = live.data ? live.data.speed * 3.6 : null;
  const riding =
    device.online && speedKmh !== null && live.data!.speed > RIDING_MPS;

  return (
    <Tappable
      feedback="scale"
      onPress={() => router.push(`/device/${device.deviceId}`)}
    >
      <Card>
        <View style={styles.heroTop}>
          <Image
            source={helmetImageFor(device.deviceId)}
            style={styles.heroImage}
            contentFit="contain"
          />
          <View style={styles.heroInfo}>
            <View style={styles.heroStatusRow}>
              <Pill
                label={
                  device.online
                    ? riding
                      ? t("devices.riding")
                      : t("devices.parked")
                    : t("common.offline")
                }
                tone={device.online ? "brand" : "neutral"}
              />
              <Dot online={device.online} />
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={{ fontSize: 13 }}
              >
                {device.online ? t("common.online") : t("common.offline")}
              </ThemedText>
            </View>
            <ThemedText
              type="smallBold"
              numberOfLines={1}
              style={styles.heroName}
            >
              {device.name ?? device.deviceId}
            </ThemedText>
            <ThemedText
              type="code"
              themeColor="textSecondary"
              numberOfLines={1}
            >
              {device.deviceId} · v{device.firmwareVersion ?? "—"}
            </ThemedText>
          </View>
        </View>
        <View style={[styles.heroStats, { borderTopColor: theme.border }]}>
          <View style={styles.stat}>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.statLabel}
            >
              {t("devices.battery")}
            </ThemedText>
            <View style={styles.statValueRow}>
              <ValueTransition value={device.battery ?? "—"}>
                <ThemedText
                  type="display"
                  style={[
                    styles.statValue,
                    { color: batteryColor(device.battery, theme) },
                  ]}
                >
                  {device.battery ?? "—"}
                </ThemedText>
              </ValueTransition>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.statUnit}
              >
                %{device.charging ? ` · ${t("devices.charging")}` : ""}
              </ThemedText>
            </View>
          </View>
          <View
            style={[styles.statDivider, { backgroundColor: theme.border }]}
          />
          <View style={styles.stat}>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.statLabel}
            >
              {t("devices.speed")}
            </ThemedText>
            <View style={styles.statValueRow}>
              <ThemedText type="display" style={styles.statValue}>
                {speedKmh !== null && device.online ? speedKmh.toFixed(0) : "—"}
              </ThemedText>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.statUnit}
              >
                km/h
              </ThemedText>
            </View>
          </View>
          <View
            style={[styles.statDivider, { backgroundColor: theme.border }]}
          />
          <View style={styles.stat}>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.statLabel}
            >
              {t("devices.lastSync")}
            </ThemedText>
            <ThemedText
              type="display"
              style={styles.statValue}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              {relativeTime(device.lastSeenAt, locale)}
            </ThemedText>
          </View>
        </View>
      </Card>
    </Tappable>
  );
}

function DeviceRow({
  device,
  current,
  last,
}: {
  device: DevicePublic;
  current: boolean;
  last: boolean;
}) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const battery = device.battery;
  const bColor = batteryColor(battery, theme);
  return (
    <Tappable
      feedback="fill"
      onPress={() => router.push(`/device/${device.deviceId}`)}
      style={[
        styles.row,
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.border,
        },
      ]}
    >
      <View
        style={[styles.rowIcon, { backgroundColor: theme.backgroundSelected }]}
      >
        <Ionicons name="shield-half-outline" size={22} color={theme.text} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <ThemedText type="smallBold" numberOfLines={1} style={styles.rowName}>
            {device.name ?? device.deviceId}
          </ThemedText>
          {current && <Pill label={t("devices.current")} tone="brand" />}
        </View>
        <View style={styles.rowMetaLine}>
          <Dot online={device.online} />
          <ThemedText
            type="small"
            themeColor="textSecondary"
            numberOfLines={1}
            style={styles.rowMeta}
          >
            {device.online
              ? t("common.online")
              : `${t("common.offline")} · ${relativeTime(device.lastSeenAt, locale)}`}
            {"  "}
            <ThemedText type="code" themeColor="textSecondary">
              {device.deviceId}
            </ThemedText>
          </ThemedText>
        </View>
      </View>
      <View style={styles.rowBattery}>
        <ThemedText type="smallBold" style={{ color: bColor }}>
          {battery !== null ? `${battery}%` : "—"}
        </ThemedText>
        <View
          style={[
            styles.batteryTrack,
            { backgroundColor: theme.backgroundSelected },
          ]}
        >
          <View
            style={[
              styles.batteryFill,
              {
                width: `${Math.max(2, Math.min(100, battery ?? 0))}%`,
                backgroundColor: bColor,
              },
            ]}
          />
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
    </Tappable>
  );
}

export default function DevicesScreen() {
  const theme = useTheme();
  const t = useT();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: devicesApi.list,
    refetchInterval: 30_000,
  });
  // 只由手势驱动：若绑到 isRefetching，后台轮询/回到页面的自动刷新也会拉出转圈，且偶发停在下拉位置不复位
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await devices.refetch();
    } finally {
      setRefreshing(false);
    }
  };
  const list = devices.data ?? [];
  const onlineCount = list.filter((d) => d.online).length;
  // 当前设备 = 第一台在线的，都离线则第一台
  const hero = list.find((d) => d.online) ?? list[0];

  return (
    <ThemedView style={styles.flex}>
      <SafeAreaView style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.container}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              tintColor={theme.brand}
              colors={[theme.brand]}
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
            />
          }
        >
          <ThemedText type="title" style={styles.pageTitle}>
            {t("devices.title")}
          </ThemedText>

          {devices.isError && (
            <ThemedText type="small" themeColor="danger">
              {toUserMessage(devices.error)}
            </ThemedText>
          )}

          {devices.isLoading ? (
            <Card style={styles.skeletonCard}>
              <Skeleton width={104} height={104} radius={16} />
              <View style={styles.skeletonLines}>
                <Skeleton width="40%" height={14} />
                <Skeleton width="65%" height={22} />
                <Skeleton width="55%" height={12} />
              </View>
            </Card>
          ) : hero ? (
            <>
              <HeroCard device={hero} />
              <BleBlockerBanner
                onPress={() => router.push(`/device/${hero.deviceId}`)}
              />
              <RideSummaryCard deviceId={hero.deviceId} />
              <SectionLabel
                title={t("devices.allDevices")}
                caption={t("devices.countCaption", {
                  total: list.length,
                  online: onlineCount,
                })}
              />
              <Card>
                {list.map((d, i) => (
                  <Animated.View key={d.deviceId} entering={listEntering(i)}>
                    <DeviceRow
                      device={d}
                      current={d.deviceId === hero.deviceId}
                      last={i === list.length - 1}
                    />
                  </Animated.View>
                ))}
              </Card>
            </>
          ) : (
            <EmptyState
              icon="bicycle-outline"
              title={t("empty.devicesTitle")}
              body={t("devices.emptyBody")}
            />
          )}
        </ScrollView>

        {/* 底部固定：有设备时绑定是次操作（描边），空态时是主操作（品牌黄） */}
        <View style={styles.bottomCta}>
          {list.length > 0 ? (
            <SecondaryButton
              title={t("devices.bindNew")}
              icon="add"
              onPress={() => router.push("/bind-device")}
            />
          ) : (
            <PrimaryButton
              title={t("devices.bindNew")}
              icon="add"
              onPress={() => router.push("/bind-device")}
            />
          )}
        </View>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { paddingHorizontal: 20, paddingBottom: 12, gap: 16 },
  pageTitle: { fontSize: 32, lineHeight: 40, marginBottom: -4 },
  pill: {
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    padding: 18,
    paddingBottom: 14,
  },
  heroImage: { width: 104, height: 104 },
  heroInfo: { flex: 1, minWidth: 0, gap: 8 },
  heroStatusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  heroName: { fontSize: 22, lineHeight: 28 },
  heroStats: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  stat: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 4,
    minWidth: 0,
  },
  statDivider: { width: StyleSheet.hairlineWidth },
  statLabel: { fontSize: 12, lineHeight: 16 },
  statValueRow: { flexDirection: "row", alignItems: "baseline", gap: 3 },
  statValue: { fontSize: 22, lineHeight: 26, fontWeight: 600 },
  statUnit: { fontSize: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: Radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { fontSize: 16, flexShrink: 1 },
  rowMetaLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowMeta: { fontSize: 13, flexShrink: 1 },
  rowBattery: { alignItems: "flex-end", gap: 5 },
  batteryTrack: { width: 44, height: 5, borderRadius: 3, overflow: "hidden" },
  batteryFill: { height: 5, borderRadius: 3 },
  skeletonCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    padding: 18,
  },
  skeletonLines: { flex: 1, gap: 10 },
  empty: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 64,
    paddingHorizontal: 24,
  },
  emptyBody: { textAlign: "center", lineHeight: 20 },
  bottomCta: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 },
});
