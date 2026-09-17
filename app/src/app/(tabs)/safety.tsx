// 安全（底部标签，2026-09-10 重设计）：
// 第一眼 = 状态卡（周围安全 / 进行中 SOS / 未连接 / 无联系人）→ 最近风险事件 → 紧急联系人 & 事故记录入口
// → 底部固定的红色「SOS · 按住呼救」（全页唯一红色，长按 2 秒经 app-relay 注入 manual_sos，
//   与头盔实体键走同一服务端状态机，倒计时页由 WS 推送弹出）。
import { Ionicons } from "@expo/vector-icons";
import { useQueries, useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState, useRef } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { EventListItem } from "@helmet/shared";

import { contactsApi } from "@/api/contacts";
import { devicesApi } from "@/api/devices";
import { toUserMessage } from "@/api/error-messages";
import { eventsApi } from "@/api/events";
import { relayApi } from "@/api/relay";
import { sosApi } from "@/api/sos";
import { Card, IconCircle, ListRow, SectionLabel } from "@/components/list";
import { useJello } from "@/components/motion";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { translate, useLocale, useT, type MessageKey } from "@/i18n";
import { shortDate, shortTime } from "@/i18n/format";
import { AnimatedPressable } from "@/components/animated-pressable";

const MAX_CONTACTS = 5; // API.md §3 定稿
const RISK_TYPES = "collision_risk,obstacle_risk,possible_fall,risk_cleared";

const RISK_META: Record<
  string,
  { key: MessageKey; icon: keyof typeof Ionicons.glyphMap; cleared?: boolean }
> = {
  collision_risk: { key: "safety.risk.collision", icon: "car-outline" },
  obstacle_risk: { key: "safety.risk.obstacle", icon: "warning-outline" },
  possible_fall: { key: "safety.risk.fall", icon: "body-outline" },
  risk_cleared: {
    key: "safety.risk.cleared",
    icon: "checkmark-circle-outline",
    cleared: true,
  },
};

function StatusCard({
  tone,
  icon,
  title,
  body,
  onPress,
}: {
  tone: "success" | "warning" | "danger";
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const color = theme[tone];
  const bg =
    tone === "success"
      ? theme.successBg
      : tone === "warning"
        ? theme.warningBg
        : theme.dangerBg;
  const inner = (
    <View style={styles.statusRow}>
      <IconCircle icon={icon} size={44} iconSize={22} color={color} bg={bg} />
      <View style={styles.statusBody}>
        <ThemedText type="smallBold" style={{ fontSize: 17 }}>
          {title}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={{ fontSize: 13 }}
        >
          {body}
        </ThemedText>
      </View>
      {onPress && (
        <Ionicons
          name="chevron-forward"
          size={18}
          color={theme.textSecondary}
        />
      )}
    </View>
  );
  return onPress ? (
    <Tappable feedback="scale" haptic onPress={onPress}>
      <Card
        style={tone === "danger" ? { borderColor: theme.danger } : undefined}
      >
        {inner}
      </Card>
    </Tappable>
  ) : (
    <Card>{inner}</Card>
  );
}

function EventRow({ event, last }: { event: EventListItem; last: boolean }) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  const meta = RISK_META[event.eventType];
  const cleared = meta?.cleared ?? false;
  const color = cleared ? theme.success : theme.warning;
  const bg = cleared ? theme.successBg : theme.warningBg;
  return (
    <Tappable
      feedback="fill"
      onPress={() => router.push("/events")}
      style={[
        styles.eventRow,
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.border,
        },
      ]}
    >
      <IconCircle
        icon={meta?.icon ?? "alert-circle-outline"}
        color={color}
        bg={bg}
      />
      <View style={styles.eventBody}>
        <ThemedText type="small" style={{ fontSize: 15 }} numberOfLines={1}>
          {meta ? t(meta.key) : event.eventType}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={{ fontSize: 13 }}
          numberOfLines={1}
        >
          {shortDate(event.timestamp, locale)}{" "}
          {shortTime(event.timestamp, locale)}
        </ThemedText>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
    </Tappable>
  );
}

export default function SafetyScreen() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const t = useT();
  const locale = useLocale();

  const devices = useQuery({ queryKey: ["devices"], queryFn: devicesApi.list });
  const deviceList = devices.data ?? [];
  const deviceIds = deviceList.map((d) => d.deviceId);
  const onlineDevice = deviceList.find((d) => d.online);

  // 每台设备的进行中 SOS（WS 推送也会直写同 key 缓存）
  const activeSos = useQueries({
    queries: deviceIds.map((id) => ({
      queryKey: ["sos-active", id],
      queryFn: () => sosApi.active(id),
      refetchInterval: 30_000,
    })),
  });
  const pendingSos = activeSos
    .map((q) => q.data?.sos)
    .find((s) => s && s.status === "pending");

  const contacts = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.list,
  });
  const contactList = contacts.data ?? [];

  const accidents = useQueries({
    queries: deviceIds.map((id) => ({
      queryKey: ["accidents", id],
      queryFn: () => sosApi.accidents(id),
    })),
  });
  const accidentItems = accidents
    .flatMap((q) => q.data?.items ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const events = useQueries({
    queries: deviceIds.map((id) => ({
      queryKey: ["events", id, RISK_TYPES],
      queryFn: () => eventsApi.list(id, { type: RISK_TYPES, pageSize: 5 }),
      refetchInterval: 30_000,
    })),
  });
  const recentEvents = events
    .flatMap((q) => q.data?.items ?? [])
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 3);

  /** 长按 2 秒触发（防误触）：进度从左到右填满按钮 */
  const sosP = useSharedValue(0);
  const sosFillStyle = useAnimatedStyle(() => ({
    width: `${sosP.get() * 100}%`,
  }));
  const sosScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(sosP.get(), [0, 1], [1, 0.97]) }],
  }));
  const sosTarget = onlineDevice?.deviceId ?? deviceIds[0];
  // 长按未满 2 s 就松手：按钮果冻抖一下，提示"要按住"（可用性提示，不是装饰）
  const jello = useJello();
  const sosFired = useRef(false);
  const fireSos = () => {
    sosFired.current = true;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
      () => {},
    );
    relayApi
      .pushEvent(sosTarget, "manual_sos", {})
      .catch((e) =>
        Alert.alert(translate("safety.sosSendFailed"), toUserMessage(e)),
      );
  };

  const [devOpen, setDevOpen] = useState(false);
  const inject = (type: "possible_fall" | "collision_risk") =>
    relayApi
      .pushEvent(
        deviceIds[0],
        type,
        type === "possible_fall"
          ? { confidence: 0.95 }
          : { riskLevel: "high", direction: "rear" },
      )
      .catch((e) =>
        Alert.alert(translate("safety.dev.failed"), toUserMessage(e)),
      );

  const latestAccident = accidentItems[0];

  return (
    <ThemedView style={styles.flex}>
      <SafeAreaView style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.container}
          showsVerticalScrollIndicator={false}
        >
          <ThemedText type="title" style={styles.pageTitle}>
            {t("safety.title")}
          </ThemedText>

          {pendingSos ? (
            <StatusCard
              tone="danger"
              icon="warning-outline"
              title={t("safety.statusSos")}
              body={t("safety.statusSosBody")}
              onPress={() =>
                router.push(
                  `/sos-active?sosId=${pendingSos.sosId}&deviceId=${pendingSos.deviceId}`,
                )
              }
            />
          ) : !onlineDevice ? (
            <StatusCard
              tone="warning"
              icon="bluetooth-outline"
              title={t("safety.statusNoDevice")}
              body={t("safety.statusNoDeviceBody")}
              onPress={
                deviceList.length === 0
                  ? () => router.push("/bind-device")
                  : undefined
              }
            />
          ) : contactList.length === 0 && !contacts.isLoading ? (
            <StatusCard
              tone="warning"
              icon="call-outline"
              title={t("safety.statusNoContacts")}
              body={t("safety.statusNoContactsBody")}
              onPress={() => router.push("/add-contact")}
            />
          ) : (
            <StatusCard
              tone="success"
              icon="shield-checkmark-outline"
              title={t("safety.statusSafe")}
              body={t("safety.statusSafeBody", {
                device: onlineDevice.name ?? onlineDevice.deviceId,
              })}
            />
          )}

          <SectionLabel
            title={t("safety.events")}
            action={t("common.all")}
            onAction={() => router.push("/events")}
          />
          <Card>
            {recentEvents.length === 0 ? (
              <View style={styles.emptyRow}>
                <ThemedText type="small" themeColor="textSecondary">
                  {t("safety.eventsEmpty")}
                </ThemedText>
              </View>
            ) : (
              recentEvents.map((e, i) => (
                <EventRow
                  key={e.eventId}
                  event={e}
                  last={i === recentEvents.length - 1}
                />
              ))
            )}
          </Card>

          <Card>
            <ListRow
              icon="call-outline"
              title={t("safety.contacts")}
              subtitle={
                contactList.length > 0
                  ? t("safety.contactsCaption", {
                      n: contactList.length,
                      max: MAX_CONTACTS,
                    })
                  : t("safety.contactsNone")
              }
              onPress={() => router.push("/contacts")}
            />
            <ListRow
              icon="time-outline"
              title={t("safety.accidents")}
              subtitle={
                latestAccident
                  ? t("safety.accidentsCaption", {
                      n: accidentItems.length,
                      date: shortDate(latestAccident.createdAt, locale),
                    })
                  : t("safety.accidentsNone")
              }
              onPress={() => router.push("/accidents")}
              last
            />
          </Card>

          {/* 开发测试：经 app-relay 真实链路注入事件（仅 DEV 构建可见） */}
          {__DEV__ && deviceIds[0] && (
            <View style={[styles.devBox, { borderColor: theme.border }]}>
              <Tappable
                onPress={() => setDevOpen((v) => !v)}
                style={styles.devHeader}
              >
                <ThemedText type="label" themeColor="textSecondary">
                  {t("safety.dev.title")}
                </ThemedText>
                <Ionicons
                  name={devOpen ? "chevron-up" : "chevron-down"}
                  size={14}
                  color={theme.textSecondary}
                />
              </Tappable>
              {devOpen && (
                <View style={styles.devRow}>
                  <Tappable
                    style={[styles.devBtn, { backgroundColor: theme.dangerBg }]}
                    onPress={() => void inject("possible_fall")}
                  >
                    <ThemedText
                      type="smallBold"
                      style={{ color: theme.danger, fontSize: 13 }}
                    >
                      {t("safety.dev.fall")}
                    </ThemedText>
                  </Tappable>
                  <Tappable
                    style={[
                      styles.devBtn,
                      { backgroundColor: theme.warningBg },
                    ]}
                    onPress={() => void inject("collision_risk")}
                  >
                    <ThemedText
                      type="smallBold"
                      style={{ color: theme.warning, fontSize: 13 }}
                    >
                      {t("safety.dev.collision")}
                    </ThemedText>
                  </Tappable>
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {/* 拇指区固定：有进行中 SOS 时同一位置变成处理入口，不挪窝 */}
        {sosTarget && !pendingSos && (
          <View style={styles.bottomSos}>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.sosHint}
            >
              {t("safety.sosHint")}{" "}
              <ThemedText type="smallBold" style={{ fontSize: 13 }}>
                {t("safety.sosHintStrong")}
              </ThemedText>
            </ThemedText>
            <AnimatedPressable
              delayLongPress={2000}
              onPressIn={() => {
                // 按下瞬间就要有触觉确认（骑行戴手套看不清屏幕），2 秒后触发时再一次警示振动
                sosFired.current = false;
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(
                  () => {},
                );
                sosP.set(
                  withTiming(1, { duration: 2000, easing: Easing.linear }),
                );
              }}
              onPressOut={() => {
                sosP.set(withTiming(0, { duration: 180 }));
                if (!sosFired.current) jello.trigger();
              }}
              onLongPress={fireSos}
              style={[
                styles.sosBtn,
                {
                  backgroundColor: theme.sos,
                  shadowColor: theme.sos,
                  shadowOpacity: scheme === "light" ? 0.18 : 0.45,
                },
                sosScaleStyle,
                jello.style,
              ]}
            >
              <Animated.View style={[styles.sosFill, sosFillStyle]} />
              <ThemedText type="display" style={styles.sosWord}>
                SOS
              </ThemedText>
              <View style={styles.sosDivider} />
              <View style={styles.sosTextCol}>
                <ThemedText type="smallBold" style={styles.sosTitle}>
                  {t("safety.sosHold")}
                </ThemedText>
                <ThemedText type="small" style={styles.sosSub}>
                  {t("safety.sosCancelable")}
                </ThemedText>
              </View>
            </AnimatedPressable>
          </View>
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { paddingHorizontal: 20, paddingBottom: 12, gap: 14 },
  pageTitle: { fontSize: 32, lineHeight: 40, marginBottom: -2 },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
  },
  statusBody: { flex: 1, gap: 3, minWidth: 0 },
  eventRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  eventBody: { flex: 1, gap: 2, minWidth: 0 },
  emptyRow: {
    paddingHorizontal: 16,
    paddingVertical: 18,
    alignItems: "center",
  },
  bottomSos: {
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 22,
    gap: 10,
  },
  sosHint: { textAlign: "center", fontSize: 13 },
  sosBtn: {
    height: 72,
    borderRadius: Radius.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    overflow: "hidden",
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  sosFill: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  sosWord: { color: "#FFFFFF", fontSize: 26, lineHeight: 30, letterSpacing: 2 },
  sosDivider: {
    width: 1,
    height: 28,
    backgroundColor: "rgba(255,255,255,0.35)",
  },
  sosTextCol: { gap: 2 },
  sosTitle: { color: "#FFFFFF", fontSize: 16, lineHeight: 20 },
  sosSub: { color: "rgba(255,255,255,0.85)", fontSize: 12, lineHeight: 14 },
  devBox: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: Radius.card,
    padding: 12,
    gap: 10,
  },
  devHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 32,
  },
  devRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  devBtn: {
    borderRadius: Radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
});
