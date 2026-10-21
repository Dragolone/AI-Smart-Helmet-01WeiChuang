// SOS 记录详情（API.md §7 GET /accidents/{id}，一条记录 = 一张求救单）：处理状态 + 来源头盔 + 准确时间
// + 位置快照 + 通知发送记录（手机号已脱敏）。界面上不叫「事故」：疑似摔倒、已取消的求救都在这里，不代表出了事故。
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { sosActiveHref } from "@/services/sos-routes";
import { ApiRequestError } from "@/api/client";
import { devicesApi } from "@/api/devices";
import { toUserMessage } from "@/api/error-messages";
import { sosApi } from "@/api/sos";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { AmapView, type AmapViewHandle } from "@/components/map/amap-view";
import { isPlausibleFix, toGcj02 } from "@/components/map/coords";
import { openAmapNavigation } from "@/components/map/nav-links";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { readableEventFields } from "@/services/event-fields";
import { cleanHelmetName } from "@/services/safety-status";
import { useLocale, useT } from "@/i18n";
import { fullDateTime, shortTime } from "@/i18n/format";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

const isNotFound = (e: unknown) =>
  e instanceof ApiRequestError &&
  (e.status === 404 || e.status === 400 || e.status === 403); // 400：记录号是乱码（深链），同样当找不到

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
  const dateTime = (iso: string) => fullDateTime(iso, locale);
  const detail = useQuery({
    queryKey: ["accident", accidentId],
    queryFn: () => sosApi.accidentDetail(accidentId),
    // 记录不存在（链接里的编号有误 / 不是自己头盔的）重试也一样，直接给空态
    retry: (n, e) => !isNotFound(e) && n < 1,
  });
  // 来源头盔显示用户起的名字（与安全页同一份设备列表缓存）；已解绑的头盔查不到名字，退回设备号
  const devices = useQuery({ queryKey: ["devices"], queryFn: devicesApi.list });

  const d = detail.data;
  const helmetName = cleanHelmetName(
    devices.data?.find((x) => x.deviceId === d?.deviceId)?.name,
  );
  const mapRef = useRef<AmapViewHandle>(null);
  // (0,0) 这类没定位时的占位值不当成事故地点：不画小地图、不给导航，写「没有位置」
  const loc = d?.location && isPlausibleFix(d.location) ? d.location : null;
  const gcjPos = loc ? toGcj02(loc) : null;

  // 位置就绪后落点(小地图 ready 前命令会排队,双保险:数据到达时也推一次)
  useEffect(() => {
    if (gcjPos) mapRef.current?.setHelmet(gcjPos, { follow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gcjPos?.longitude, gcjPos?.latitude]);

  // 以前这里只写一行「操作失败（NOT_FOUND）」，用户不知道发生了什么、也没有回去的按钮（2026-10-15 边界测试）
  if (isNotFound(detail.error)) {
    return (
      <ThemedView style={[styles.flex, styles.goneWrap]}>
        <EmptyState
          icon="document-text-outline"
          title={t("records.gone.title")}
          body={t("records.gone.body")}
          actionLabel={t("nav.back")}
          onAction={() =>
            router.canGoBack() ? router.back() : router.navigate("/")
          }
        />
      </ThemedView>
    );
  }

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
                {t(
                  d.triggerType === "manual_sos"
                    ? "records.sos.manual"
                    : "records.sos.fall",
                )}
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

            {/* 还在倒计时的单：这一页只是记录，取消 / 立即求救在倒计时页。从推送、事故列表点进来时
                给一条回去的路，否则用户看着「进行中」却找不到取消键（2026-10-05 评审） */}
            {d.status === "pending" && (
              <Pressable
                accessibilityRole="button"
                style={[styles.countdownBtn, { backgroundColor: theme.danger }]}
                onPress={() =>
                  router.navigate(sosActiveHref(d.sosId, d.deviceId) as never)
                }
              >
                <Ionicons name="warning-outline" size={16} color="#fff" />
                <ThemedText type="smallBold" style={styles.navBtnText}>
                  {t("accident.openCountdown")}
                </ThemedText>
              </Pressable>
            )}

            <Row
              label={t("accident.device")}
              value={helmetName ? `${helmetName} · ${d.deviceId}` : d.deviceId}
            />
            <Row
              label={t("accident.triggeredAt")}
              value={dateTime(d.createdAt)}
            />
            {/* 补传的旧事件（决策 #52）：头盔上发生的时间可能比建单早好几个小时，记录里要看得到 */}
            {d.triggeredAt && (
              <Row
                label={t("accident.helmetTriggeredAt")}
                value={dateTime(d.triggeredAt)}
              />
            )}
            <Row label={t("accident.deadline")} value={dateTime(d.deadline)} />
            {/* 触发事件里头盔给出的量（冲击力、倾角、触发方式…）：有就显示，没有不占位 */}
            {readableEventFields(d.triggerPayload ?? {}, t).map((f) => (
              <Row key={f.label} label={f.label} value={f.value} />
            ))}
            <Row
              label={t("accident.location")}
              value={
                loc
                  ? `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)} (${
                      loc.source === "event"
                        ? t("accident.locationSource.event")
                        : t("accident.locationSource.track")
                    })`
                  : t("accident.noLocation")
              }
            />

            {/* 事故地点小地图 + 一键导航(监护场景核心:赶到现场) */}
            {loc && gcjPos && (
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
  goneWrap: { justifyContent: "center", paddingHorizontal: 24 },
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
  countdownBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: Radius.card,
  },
  flex: { flex: 1 },
  container: { padding: 20, gap: 10 },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 4,
  },
  title: { fontSize: 26, lineHeight: 32, flexShrink: 1 },
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
