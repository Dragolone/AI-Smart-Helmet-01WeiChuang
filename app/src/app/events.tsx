// 安全事件页（Week 9–10 A 线,API.md §6）:危险事件历史,UI 对齐 design/events.png
// (筛选 chips + 图标卡片 + 类型配色;地图缩略图留待后续迭代)。点击卡片查看原始 payload 详情。
import { Ionicons } from "@expo/vector-icons";
import { useQueries, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";

import { devicesApi } from "@/api/devices";
import { eventsApi } from "@/api/events";
import { toUserMessage } from "@/api/error-messages";
import { PrimaryButton } from "@/components/form";
import { Skeleton } from "@/components/skeleton";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

/** 事件类型元数据(标题/图标/配色);riskLevel 具体值在详情 payload 中 */
const EVENT_META: Record<
  string,
  {
    title: string;
    icon: keyof typeof Ionicons.glyphMap;
    tone: "danger" | "warning" | "success" | "neutral";
  }
> = {
  collision_risk: {
    title: "碰撞风险",
    icon: "car-sport-outline",
    tone: "danger",
  },
  obstacle_risk: { title: "障碍物", icon: "cube-outline", tone: "warning" },
  possible_fall: { title: "疑似摔倒", icon: "body-outline", tone: "danger" },
  risk_cleared: {
    title: "风险解除",
    icon: "checkmark-circle-outline",
    tone: "success",
  },
  manual_sos: { title: "手动求救", icon: "hand-left-outline", tone: "danger" },
  bluetooth_lost: {
    title: "蓝牙断连",
    icon: "bluetooth-outline",
    tone: "neutral",
  },
  video_ready: { title: "视频就绪", icon: "videocam-outline", tone: "neutral" },
};

const FILTERS = [
  { key: "", label: "全部" },
  { key: "collision_risk", label: "碰撞风险" },
  { key: "obstacle_risk", label: "障碍物" },
  { key: "possible_fall,manual_sos", label: "摔倒/求救" },
] as const;

/** 默认视图聚合的危险相关类型(全部 ≠ 原始事件流,device_status/location 噪音不进本页) */
const DEFAULT_TYPES =
  "collision_risk,obstacle_risk,possible_fall,manual_sos,risk_cleared";

const DIRECTION_LABEL: Record<string, string> = {
  front: "前方",
  rear: "后方",
  left: "左侧",
  right: "右侧",
};
const OBJECT_LABEL: Record<string, string> = {
  vehicle: "车辆",
  pedestrian: "行人",
  obstacle: "障碍物",
  unknown: "未知目标",
};

/** 把 payload 里用户看得懂的字段挑出来（原始 JSON 不给用户看） */
function readableFields(
  payload: Record<string, unknown>,
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (typeof payload.direction === "string")
    out.push({
      label: "方向",
      value: DIRECTION_LABEL[payload.direction] ?? payload.direction,
    });
  if (typeof payload.objectType === "string")
    out.push({
      label: "目标",
      value: OBJECT_LABEL[payload.objectType] ?? payload.objectType,
    });
  if (typeof payload.distance === "number")
    out.push({ label: "距离", value: `${payload.distance.toFixed(1)} m` });
  if (typeof payload.confidence === "number")
    out.push({
      label: "置信度",
      value: `${Math.round(payload.confidence * 100)}%`,
    });
  return out;
}

const RISK_LABEL: Record<
  string,
  { label: string; tone: "danger" | "warning" | "neutral" }
> = {
  high: { label: "高风险", tone: "danger" },
  medium: { label: "中风险", tone: "warning" },
  low: { label: "低风险", tone: "neutral" },
};

export default function EventsScreen() {
  const theme = useTheme();
  const [filter, setFilter] = useState<string>("");
  const [detailId, setDetailId] = useState<string | null>(null);

  const devices = useQuery({ queryKey: ["devices"], queryFn: devicesApi.list });
  const deviceIds = (devices.data ?? []).map((d) => d.deviceId);

  const typeParam = filter || DEFAULT_TYPES;
  const perDevice = useQueries({
    queries: deviceIds.map((id) => ({
      queryKey: ["events", id, typeParam],
      queryFn: () => eventsApi.list(id, { type: typeParam, pageSize: 50 }),
      refetchInterval: 30_000,
    })),
  });
  const loading = perDevice.some((q) => q.isLoading);
  const firstError = perDevice.find((q) => q.isError)?.error;
  const items = perDevice
    .flatMap((q) => q.data?.items ?? [])
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 100);

  const detail = useQuery({
    queryKey: ["event-detail", detailId],
    queryFn: () => eventsApi.detail(detailId!),
    enabled: !!detailId,
  });

  const toneColor = (tone: "danger" | "warning" | "success" | "neutral") =>
    tone === "danger"
      ? { fg: theme.danger, bg: theme.dangerBg }
      : tone === "warning"
        ? { fg: theme.warning, bg: theme.warningBg }
        : tone === "success"
          ? { fg: theme.success, bg: theme.successBg }
          : { fg: theme.textSecondary, bg: theme.backgroundSelected };

  const d = detail.data;
  const dRisk =
    d && typeof d.payload.riskLevel === "string"
      ? RISK_LABEL[d.payload.riskLevel]
      : null;

  return (
    <ThemedView style={styles.flex}>
      {/* 筛选 chips */}
      <View style={styles.chipRow}>
        {FILTERS.map((f) => (
          <Tappable key={f.key} onPress={() => setFilter(f.key)}>
            <View
              style={[
                styles.chip,
                {
                  backgroundColor:
                    filter === f.key ? theme.brand : theme.backgroundElement,
                  borderColor: filter === f.key ? theme.brand : theme.border,
                },
              ]}
            >
              <ThemedText
                type="smallBold"
                style={{
                  color: filter === f.key ? theme.onBrand : theme.textSecondary,
                  fontSize: 13,
                }}
              >
                {f.label}
              </ThemedText>
            </View>
          </Tappable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={perDevice.some((q) => q.isRefetching)}
            onRefresh={() => perDevice.forEach((q) => void q.refetch())}
          />
        }
      >
        {firstError != null && (
          <ThemedText type="small">{toUserMessage(firstError)}</ThemedText>
        )}
        {items.map((e, i) => {
          const meta = EVENT_META[e.eventType] ?? {
            title: e.eventType,
            icon: "alert-circle-outline" as const,
            tone: "neutral" as const,
          };
          const c = toneColor(meta.tone);
          return (
            <Animated.View
              key={e.eventId}
              entering={FadeInDown.duration(300).delay(Math.min(i * 45, 400))}
            >
              <Tappable feedback="fill" onPress={() => setDetailId(e.eventId)}>
                {
                  <View
                    style={[
                      styles.card,
                      {
                        backgroundColor: theme.backgroundElement,
                        borderColor: theme.border,
                      },
                    ]}
                  >
                    <View style={[styles.iconTile, { backgroundColor: c.bg }]}>
                      <Ionicons name={meta.icon} size={22} color={c.fg} />
                    </View>
                    <View style={styles.cardBody}>
                      <ThemedText type="smallBold" style={{ fontSize: 15 }}>
                        {meta.title}
                      </ThemedText>

                      <ThemedText type="label" themeColor="textSecondary">
                        {e.deviceId} · {new Date(e.timestamp).toLocaleString()}
                      </ThemedText>
                    </View>
                    <Ionicons
                      name="chevron-forward"
                      size={16}
                      color={theme.textSecondary}
                    />
                  </View>
                }
              </Tappable>
            </Animated.View>
          );
        })}
        {loading && items.length === 0 && (
          <View style={styles.skeletonWrap}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={styles.skeletonRow}>
                <Skeleton width={40} height={40} radius={20} />
                <View style={styles.skeletonLines}>
                  <Skeleton width="45%" height={15} />
                  <Skeleton width="65%" height={12} />
                </View>
              </View>
            ))}
          </View>
        )}
        {!loading && items.length === 0 && (
          <View style={styles.empty}>
            <Ionicons
              name="shield-checkmark-outline"
              size={44}
              color={theme.textSecondary}
            />
            <ThemedText type="small" themeColor="textSecondary">
              暂无危险事件——安全骑行中
            </ThemedText>
          </View>
        )}
      </ScrollView>

      {/* 事件详情弹层(原始 payload 关键字段) */}
      <Modal
        visible={!!detailId}
        transparent
        animationType="fade"
        onRequestClose={() => setDetailId(null)}
      >
        <Pressable style={styles.modalMask} onPress={() => setDetailId(null)}>
          <Pressable
            style={[
              styles.modalCard,
              {
                backgroundColor: theme.backgroundElement,
                borderColor: theme.border,
              },
            ]}
            onPress={() => undefined}
          >
            {d ? (
              <>
                <View style={styles.detailHeader}>
                  <ThemedText type="subtitle">
                    {EVENT_META[d.eventType]?.title ?? d.eventType}
                  </ThemedText>
                  {dRisk && (
                    <View
                      style={[
                        styles.riskPill,
                        { backgroundColor: toneColor(dRisk.tone).bg },
                      ]}
                    >
                      <ThemedText
                        type="smallBold"
                        style={{
                          color: toneColor(dRisk.tone).fg,
                          fontSize: 12,
                        }}
                      >
                        {dRisk.label}
                      </ThemedText>
                    </View>
                  )}
                </View>
                <ThemedText type="small" themeColor="textSecondary">
                  {d.deviceId} · {new Date(d.timestamp).toLocaleString()}
                </ThemedText>
                {readableFields(d.payload).length > 0 && (
                  <View
                    style={[
                      styles.fieldBox,
                      { backgroundColor: theme.backgroundSelected },
                    ]}
                  >
                    {readableFields(d.payload).map((f) => (
                      <View key={f.label} style={styles.fieldRow}>
                        <ThemedText type="small" themeColor="textSecondary">
                          {f.label}
                        </ThemedText>
                        <ThemedText type="smallBold">{f.value}</ThemedText>
                      </View>
                    ))}
                  </View>
                )}
                {/* 视频片段：头盔侧留档后在此列出（守护模式类体验，MVP 后第一迭代） */}
                <ThemedText type="small" themeColor="textSecondary">
                  {d.media.length > 0
                    ? `关联视频 ${d.media.length} 段（播放功能开发中）`
                    : "该时刻暂无视频片段"}
                </ThemedText>
                <PrimaryButton
                  compact
                  title="在地图上查看该时刻"
                  icon="map-outline"
                  onPress={() => {
                    const at = d.timestamp;
                    const dev = d.deviceId;
                    setDetailId(null);
                    router.push({
                      pathname: "/map",
                      params: { deviceId: dev, at },
                    });
                  }}
                />
              </>
            ) : (
              <ThemedText type="small" themeColor="textSecondary">
                加载中…
              </ThemedText>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  skeletonWrap: { gap: 12, paddingTop: 8 },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 6,
  },
  skeletonLines: { flex: 1, gap: 8 },
  flex: { flex: 1 },
  chipRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 6,
    flexWrap: "wrap",
  },
  chip: {
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  list: { padding: 20, paddingTop: 10, gap: 10 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 14,
  },
  iconTile: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
  cardBody: { flex: 1, gap: 3 },
  empty: { alignItems: "center", gap: 10, paddingVertical: 60 },
  modalMask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: 28,
  },
  modalCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 18,
    gap: 10,
  },
  detailHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  riskPill: {
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  fieldBox: { borderRadius: Radius.control, padding: 12, gap: 8 },
  fieldRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
});
