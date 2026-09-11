// 事故详情（API.md §7 GET /accidents/{id}）：状态流转 + 位置快照 + 通知发送记录（手机号已脱敏）
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { toUserMessage } from "@/api/error-messages";
import { sosApi } from "@/api/sos";
import { Badge } from "@/components/badge";
import { AmapView, type AmapViewHandle } from "@/components/map/amap-view";
import { toGcj02 } from "@/components/map/coords";
import { openAmapNavigation } from "@/components/map/nav-links";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT } from "@/i18n";
import { shortDate, shortTime } from "@/i18n/format";

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}
    >
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
  const t = useT();
  const locale = useLocale();
  const dateTime = (iso: string) =>
    `${shortDate(iso, locale)} ${shortTime(iso, locale)}`;
  const detail = useQuery({
    queryKey: ["accident", accidentId],
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
                {d.triggerType === "manual_sos"
                  ? t("safety.manualSos")
                  : t("safety.fallDetected")}
              </ThemedText>
              <Badge
                variant={
                  d.status === "pending"
                    ? "danger"
                    : d.status === "notified"
                      ? "warning"
                      : "neutral"
                }
                label={
                  d.status === "pending"
                    ? t("safety.status.pending")
                    : d.status === "notified"
                      ? t("safety.status.notified")
                      : t("safety.status.cancelled")
                }
              />
            </View>

            <Row label={t("accident.device")} value={d.deviceId} />
            <Row
              label={t("accident.triggeredAt")}
              value={dateTime(d.createdAt)}
            />
            <Row label={t("accident.deadline")} value={dateTime(d.deadline)} />
            <Row
              label={t("accident.location")}
              value={
                d.location
                  ? `${d.location.latitude.toFixed(5)}, ${d.location.longitude.toFixed(5)} (${
                      d.location.source === "event"
                        ? t("accident.locationSource.event")
                        : t("accident.locationSource.track")
                    })`
                  : t("accident.noLocation")
              }
            />

            {/* 事故地点小地图 + 一键导航(监护场景核心:赶到现场) */}
            {d.location && gcjPos && (
              <View style={[styles.mapCard, { borderColor: theme.border }]}>
                <AmapView
                  style={styles.map}
                  controllerRef={mapRef}
                  onReady={() =>
                    mapRef.current?.setHelmet(gcjPos, { follow: true })
                  }
                />
                <Pressable
                  style={[styles.navBtn, { backgroundColor: theme.danger }]}
                  onPress={() =>
                    void openAmapNavigation(gcjPos, t("accident.site"))
                  }
                >
                  <Ionicons name="navigate" size={16} color="#fff" />
                  <ThemedText type="smallBold" style={styles.navBtnText}>
                    {t("accident.navigate")}
                  </ThemedText>
                </Pressable>
              </View>
            )}

            <ThemedText type="subtitle" style={styles.sectionTitle}>
              {t("accident.notifications")}
            </ThemedText>
            {d.notifications.length === 0 && (
              <ThemedText type="small" themeColor="textSecondary">
                {t("accident.notNotified")}
              </ThemedText>
            )}
            {d.notifications.map((n) => (
              <View
                key={n.id}
                style={[
                  styles.notifRow,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.border,
                  },
                ]}
              >
                <Ionicons
                  name={
                    n.channel === "sms"
                      ? "chatbubble-outline"
                      : "notifications-outline"
                  }
                  size={18}
                  color={theme.textSecondary}
                />
                <View style={styles.notifBody}>
                  <ThemedText type="smallBold">
                    {n.contactName ?? t("accident.contact")} · {n.target}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {n.channel.toUpperCase()} ·{" "}
                    {t("accident.attempts", { n: n.attempts })}
                    {n.sentAt ? ` · ${shortTime(n.sentAt, locale)}` : ""}
                  </ThemedText>
                </View>
                <Badge
                  variant={
                    n.status === "sent"
                      ? "success"
                      : n.status === "failed"
                        ? "danger"
                        : "warning"
                  }
                  label={
                    n.status === "sent"
                      ? t("accident.notif.sent")
                      : n.status === "failed"
                        ? t("accident.notif.failed")
                        : t("accident.notif.sending")
                  }
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
    overflow: "hidden",
  },
  map: { flex: 1 },
  navBtn: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: Radius.pill,
    paddingVertical: 12,
  },
  navBtnText: { color: "#fff", fontSize: 14 },
  flex: { flex: 1 },
  container: { padding: 20, gap: 10 },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  title: { fontSize: 26, lineHeight: 32 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowValue: { flexShrink: 1, textAlign: "right" },
  sectionTitle: { fontSize: 20, lineHeight: 26, marginTop: 12 },
  notifRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: Radius.control,
    borderWidth: 1,
    padding: 14,
  },
  notifBody: { flex: 1, gap: 2 },
});
