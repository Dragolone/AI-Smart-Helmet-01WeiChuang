// 安全记录（独立页，2026-10-06）：从安全首页「查看记录」进入，看的是「正在查看的头盔」的记录。
// 两类记录分开展示、各走各的数据源，不统一叫「事故」：
// - 风险提醒 = 头盔雷达类提醒及其解除（API.md §6）；
// - SOS 记录 = 求救单及处理结果（API.md §7，含已取消的）。
// 前身是「安全事件」页（事件列表 + 详情弹层）和「事故记录」列表页，合并到这里。
// 进行中的 SOS 不受头盔筛选影响：别的头盔上有一条正在倒计时，这一页顶部照样显示。
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import type { AccidentListItem, EventListItem } from "@helmet/shared";

import { toUserMessage } from "@/api/error-messages";
import { eventsApi, eventsListQuery } from "@/api/events";
import { sosApi } from "@/api/sos";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { PrimaryButton } from "@/components/form";
import { HelmetSwitcher, helmetNameOf } from "@/components/helmet-switcher";
import { Card, IconCircle, type IconName } from "@/components/list";
import { Skeleton } from "@/components/skeleton";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { RISK_ALERT_TYPE_PARAM } from "@/constants/event-types";
import { Radius } from "@/constants/theme";
import { useHelmetLinks, useHelmets, usePendingSos } from "@/hooks/use-safety";
import { useTheme } from "@/hooks/use-theme";
import {
  LOCALE_TAGS,
  useLocale,
  useT,
  type Locale,
  type MessageKey,
} from "@/i18n";
import { fullDateTime, shortDate, shortTime } from "@/i18n/format";
import { readableEventFields } from "@/services/event-fields";
import { linkLevelOf } from "@/services/safety-status";

type Translate = ReturnType<typeof useT>;
type Tone = "danger" | "warning" | "success" | "neutral";
type RecordTab = "alerts" | "sos";

/** 事件类型元数据(标题 key/图标/配色);标题在渲染时经 t() 解析,模块级不绑定语言。riskLevel 具体值在详情 payload 中 */
const EVENT_META: Record<
  string,
  { title: MessageKey; icon: IconName; tone: Tone }
> = {
  collision_risk: {
    title: "events.type.collision_risk",
    icon: "car-sport-outline",
    tone: "danger",
  },
  obstacle_risk: {
    title: "events.type.obstacle_risk",
    icon: "cube-outline",
    tone: "warning",
  },
  risk_cleared: {
    title: "events.type.risk_cleared",
    icon: "checkmark-circle-outline",
    tone: "success",
  },
  // 下面几类不出现在本页列表里，只在带 eventId 直接打开详情时用得上
  possible_fall: {
    title: "safety.risk.fall",
    icon: "body-outline",
    tone: "danger",
  },
  manual_sos: {
    title: "safety.manualSos",
    icon: "hand-left-outline",
    tone: "danger",
  },
  bluetooth_lost: {
    title: "events.type.bluetooth_lost",
    icon: "bluetooth-outline",
    tone: "neutral",
  },
  video_ready: {
    title: "events.type.video_ready",
    icon: "videocam-outline",
    tone: "neutral",
  },
};

/** 详情里那句「不等同于已发生事故」只对风险提醒类说 */
const RISK_ALERT_DETAIL = new Set([
  "collision_risk",
  "obstacle_risk",
  "risk_cleared",
]);

const RISK_LABEL: Record<
  string,
  { label: MessageKey; tone: "danger" | "warning" | "neutral" }
> = {
  high: { label: "safety.level.high", tone: "danger" },
  medium: { label: "safety.level.medium", tone: "warning" },
  low: { label: "safety.level.low", tone: "neutral" },
};

const dayStart = (x: Date) =>
  new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();

/** 分组标题：今天 · 10月6日 / 昨天 · 10月5日 / 其它按日期，跨年的带上年份 */
function dayHeaderOf(iso: string, locale: Locale, t: Translate): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return shortDate(iso, locale);
  const now = new Date();
  const diff = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (diff === 0) return `${t("common.today")} · ${shortDate(iso, locale)}`;
  if (diff === 1) return `${t("common.yesterday")} · ${shortDate(iso, locale)}`;
  if (d.getFullYear() === now.getFullYear()) return shortDate(iso, locale);
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

/** 按天分组（输入已按时间倒序）；认不出时间的归到同一组，不丢 */
function groupByDay<T>(
  items: readonly T[],
  timeOf: (x: T) => string,
): { key: string; iso: string; items: T[] }[] {
  const groups: { key: string; iso: string; items: T[] }[] = [];
  for (const item of items) {
    const iso = timeOf(item);
    const at = new Date(iso);
    const key = Number.isNaN(at.getTime()) ? "invalid" : String(dayStart(at));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, iso, items: [item] });
  }
  return groups;
}

function ListSkeleton() {
  return (
    <View style={styles.skeletonWrap}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.skeletonRow}>
          <Skeleton width={36} height={36} radius={18} />
          <View style={styles.skeletonLines}>
            <Skeleton width="45%" height={15} />
            <Skeleton width="65%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

export default function SafetyRecordsScreen() {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();
  // 首页的「查看记录」带 tab=sos 进来（首页那一格放的是 SOS 记录）；不带参数时落在「风险提醒」
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<RecordTab>(
    params.tab === "sos" ? "sos" : "alerts",
  );
  const [detailId, setDetailId] = useState<string | null>(null);

  const helmets = useHelmets();
  const { list, viewed } = helmets;
  const links = useHelmetLinks(list, !helmets.stale);
  const pending = usePendingSos(list.map((d) => d.deviceId));
  const viewedId = viewed?.deviceId;
  const several = list.length > 1;
  const nameOfDevice = (deviceId: string) =>
    helmetNameOf(
      list.find((d) => d.deviceId === deviceId) ?? { name: null, deviceId },
    );

  const alerts = useQuery({
    ...eventsListQuery(viewedId ?? "", {
      type: RISK_ALERT_TYPE_PARAM,
      pageSize: 50,
    }),
    enabled: !!viewedId,
    refetchInterval: 30_000,
  });
  // 与此前事故列表同一个缓存键：实时通道收到 sos_update 时按前缀失效（use-realtime）
  const sosRecords = useQuery({
    queryKey: ["accidents", viewedId],
    queryFn: () => sosApi.accidents(viewedId!),
    enabled: !!viewedId,
  });
  const current = tab === "alerts" ? alerts : sosRecords;

  // 只由手势驱动：绑到 isRefetching 的话，30 秒轮询也会拉出转圈（设备页同一口径）
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([helmets.refetch(), current.refetch()]);
    } finally {
      setRefreshing(false);
    }
  };

  const detail = useQuery({
    queryKey: ["event-detail", detailId],
    queryFn: () => eventsApi.detail(detailId!),
    enabled: !!detailId,
  });

  const toneColor = (tone: Tone) =>
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
  const dFields = d
    ? [
        {
          label: t("records.detail.time"),
          value: fullDateTime(d.timestamp, locale),
        },
        {
          label: t("records.detail.helmet"),
          value: nameOfDevice(d.deviceId),
        },
        ...readableEventFields(d.payload, t),
      ]
    : [];

  const rowBorder = (last: boolean) =>
    !last && {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    };

  const alertRow = (e: EventListItem, last: boolean) => {
    const meta = EVENT_META[e.eventType];
    const c = toneColor(meta?.tone ?? "neutral");
    return (
      <Tappable
        key={e.eventId}
        feedback="fill"
        accessibilityRole="button"
        onPress={() => setDetailId(e.eventId)}
        style={[styles.row, rowBorder(last)]}
      >
        <IconCircle
          icon={meta?.icon ?? "alert-circle-outline"}
          size={36}
          color={c.fg}
          bg={c.bg}
        />
        <View style={styles.rowBody}>
          <ThemedText type="small" style={styles.rowTitle} numberOfLines={1}>
            {meta ? t(meta.title) : e.eventType}
          </ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.rowSub}
          >
            {shortTime(e.timestamp, locale)}
          </ThemedText>
        </View>
        <Ionicons
          name="chevron-forward"
          size={16}
          color={theme.textSecondary}
        />
      </Tappable>
    );
  };

  const sosRow = (a: AccidentListItem, last: boolean) => {
    const status =
      a.status === "pending"
        ? { variant: "danger" as const, label: t("safety.status.pending") }
        : a.status === "notified"
          ? { variant: "warning" as const, label: t("safety.status.notified") }
          : {
              variant: "neutral" as const,
              label: t("safety.status.cancelled"),
            };
    return (
      <Tappable
        key={a.sosId}
        feedback="fill"
        accessibilityRole="button"
        onPress={() => router.push(`/accident/${a.sosId}`)}
        style={[styles.row, rowBorder(last)]}
      >
        <IconCircle
          icon={
            a.triggerType === "manual_sos"
              ? "hand-left-outline"
              : "body-outline"
          }
          size={36}
          color={theme.danger}
          bg={theme.dangerBg}
        />
        <View style={styles.rowBody}>
          <ThemedText type="small" style={styles.rowTitle} numberOfLines={1}>
            {t(
              a.triggerType === "manual_sos"
                ? "records.sos.manual"
                : "records.sos.fall",
            )}
          </ThemedText>
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.rowSub}
          >
            {shortTime(a.createdAt, locale)}
          </ThemedText>
        </View>
        <Badge variant={status.variant} label={status.label} />
        <Ionicons
          name="chevron-forward"
          size={16}
          color={theme.textSecondary}
        />
      </Tappable>
    );
  };

  const note = (text: string) => (
    <ThemedText
      key={text}
      type="small"
      themeColor="textSecondary"
      style={styles.note}
    >
      {text}
    </ThemedText>
  );

  /** 一类记录的列表：加载中 / 加载失败 / 空 / 按天分组。加载失败不显示成「暂无记录」 */
  function recordList<T>(opts: {
    query: {
      data?: { items: T[]; total: number };
      isError: boolean;
      error: unknown;
      refetch: () => unknown;
    };
    timeOf: (x: T) => string;
    renderRow: (x: T, last: boolean) => ReactNode;
    emptyTitle: MessageKey;
    notes: string[];
  }) {
    const { query } = opts;
    const data = query.data;
    if (!data) {
      if (query.isError)
        return (
          <EmptyState
            icon="cloud-offline-outline"
            title={t("records.loadFailed")}
            body={toUserMessage(query.error)}
            actionLabel={t("safety.action.retry")}
            onAction={() => void query.refetch()}
          />
        );
      return <ListSkeleton />;
    }
    if (data.items.length === 0)
      return (
        <EmptyState
          icon="file-tray-outline"
          title={t(opts.emptyTitle)}
          // 只说这顶头盔：绑了多顶时补一句，免得被读成「所有头盔都没有记录」
          body={several ? t("records.emptyOtherHelmets") : undefined}
        />
      );
    return (
      <>
        {query.isError &&
          note(`${t("records.loadFailed")}：${toUserMessage(query.error)}`)}
        {groupByDay(data.items, opts.timeOf).map((g) => (
          <View key={g.key} style={styles.group}>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.dayHeader}
            >
              {dayHeaderOf(g.iso, locale, t)}
            </ThemedText>
            <Card>
              {g.items.map((x, i) =>
                opts.renderRow(x, i === g.items.length - 1),
              )}
            </Card>
          </View>
        ))}
        {data.total > data.items.length &&
          note(
            t("records.truncated", {
              n: data.items.length,
              total: data.total,
            }),
          )}
        {opts.notes.map(note)}
      </>
    );
  }

  const body = () => {
    // 头盔列表没拿到：不知道该看谁的记录，也不能说成「没有头盔」
    if (!helmets.known) {
      if (helmets.stale)
        return (
          <EmptyState
            icon="cloud-offline-outline"
            title={t("records.loadFailed")}
            body={toUserMessage(helmets.error)}
            actionLabel={t("safety.action.retry")}
            onAction={() => void helmets.refetch()}
          />
        );
      return <ListSkeleton />;
    }
    if (!viewed)
      return (
        <EmptyState
          icon="shield-half-outline"
          title={t("safety.state.noHelmet")}
          body={t("records.noHelmetBody")}
        />
      );
    const linkDown = linkLevelOf(links[viewed.deviceId]) === "down";
    return (
      <>
        <HelmetSwitcher
          devices={list}
          viewed={viewed}
          links={links}
          locked={pending.length > 0}
          onSelect={helmets.select}
        />
        <View
          accessibilityRole="tablist"
          style={[styles.tabs, { borderBottomColor: theme.border }]}
        >
          {(["alerts", "sos"] as const).map((k) => {
            const selected = tab === k;
            return (
              <Tappable
                key={k}
                feedback="opacity"
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setTab(k)}
                style={[
                  styles.tab,
                  { borderBottomColor: selected ? theme.text : "transparent" },
                ]}
              >
                <ThemedText
                  type={selected ? "smallBold" : "small"}
                  themeColor={selected ? "text" : "textSecondary"}
                >
                  {t(k === "alerts" ? "records.tab.alerts" : "records.tab.sos")}
                </ThemedText>
              </Tappable>
            );
          })}
        </View>
        {tab === "alerts"
          ? recordList({
              query: alerts,
              timeOf: (e) => e.timestamp,
              renderRow: alertRow,
              emptyTitle: "records.alertsEmpty",
              notes: [
                ...(several ? [t("records.onlyThisHelmet")] : []),
                ...(linkDown ? [t("records.linkDownNote")] : []),
              ],
            })
          : recordList({
              query: sosRecords,
              timeOf: (a) => a.createdAt,
              renderRow: sosRow,
              emptyTitle: "records.sosEmpty",
              notes: [
                ...(several ? [t("records.onlyThisHelmet")] : []),
                t("records.sosNote"),
              ],
            })}
      </>
    );
  };

  return (
    <ThemedView style={styles.flex}>
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
        {pending.map((sos) => (
          <Tappable
            key={sos.sosId}
            feedback="opacity"
            accessibilityRole="button"
            onPress={() =>
              router.push(
                `/sos-active?sosId=${sos.sosId}&deviceId=${sos.deviceId}`,
              )
            }
            style={[
              styles.pending,
              { borderColor: theme.danger, backgroundColor: theme.dangerBg },
            ]}
          >
            <Ionicons name="warning" size={20} color={theme.danger} />
            <View style={styles.rowBody}>
              <ThemedText type="smallBold" style={styles.rowTitle}>
                {t("records.pending", { device: nameOfDevice(sos.deviceId) })}
              </ThemedText>
              <ThemedText type="small" style={styles.rowSub}>
                {t("safety.action.openCountdown")}
              </ThemedText>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.text} />
          </Tappable>
        ))}
        {body()}
      </ScrollView>

      {/* 风险提醒详情弹层：准确时间 + 来源头盔 + payload 里用户看得懂的字段 */}
      <Modal
        visible={!!detailId}
        transparent
        animationType="fade"
        onRequestClose={() => setDetailId(null)}
      >
        <Pressable style={styles.modalMask} onPress={() => setDetailId(null)}>
          <Animated.View entering={FadeInDown.duration(200)}>
            <Pressable
              accessibilityViewIsModal
              style={[
                styles.modalCard,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: theme.border,
                },
              ]}
              onPress={() => undefined}
            >
              <View style={styles.detailHeader}>
                <ThemedText type="smallBold" style={styles.detailTitle}>
                  {d
                    ? EVENT_META[d.eventType]
                      ? t(EVENT_META[d.eventType].title)
                      : d.eventType
                    : t(
                        detail.isError
                          ? "records.detail.failed"
                          : "events.loading",
                      )}
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
                      {t(dRisk.label)}
                    </ThemedText>
                  </View>
                )}
                <Tappable
                  accessibilityRole="button"
                  accessibilityLabel={t("common.close")}
                  onPress={() => setDetailId(null)}
                  style={[
                    styles.close,
                    { backgroundColor: theme.backgroundSelected },
                  ]}
                >
                  <Ionicons name="close" size={20} color={theme.text} />
                </Tappable>
              </View>
              {d ? (
                <>
                  <View
                    style={[
                      styles.fieldBox,
                      { backgroundColor: theme.backgroundSelected },
                    ]}
                  >
                    {dFields.map((f) => (
                      <View key={f.label} style={styles.fieldRow}>
                        <ThemedText type="small" themeColor="textSecondary">
                          {f.label}
                        </ThemedText>
                        <ThemedText type="smallBold" style={styles.fieldValue}>
                          {f.value}
                        </ThemedText>
                      </View>
                    ))}
                  </View>
                  {/* 视频片段：头盔侧留档后在此列出（守护模式类体验，MVP 后第一迭代） */}
                  <ThemedText type="small" themeColor="textSecondary">
                    {d.media.length > 0
                      ? t("events.mediaCount", { n: d.media.length })
                      : t("events.mediaNone")}
                  </ThemedText>
                  {RISK_ALERT_DETAIL.has(d.eventType) && (
                    <ThemedText
                      type="small"
                      themeColor="textSecondary"
                      style={styles.note}
                    >
                      {t("records.detail.note")}
                    </ThemedText>
                  )}
                  <PrimaryButton
                    compact
                    title={t("events.viewOnMap")}
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
                detail.isError && (
                  <ThemedText type="small" themeColor="textSecondary">
                    {toUserMessage(detail.error)}
                  </ThemedText>
                )
              )}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, paddingTop: 14, gap: 12 },
  pending: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  tabs: {
    flexDirection: "row",
    gap: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    minHeight: 46,
    justifyContent: "center",
    borderBottomWidth: 2,
  },
  group: { gap: 8 },
  dayHeader: { fontSize: 12, lineHeight: 16, paddingHorizontal: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 64,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: 15 },
  rowSub: { fontSize: 13, lineHeight: 18 },
  note: { fontSize: 12, lineHeight: 19, paddingHorizontal: 2 },
  skeletonWrap: { gap: 12, paddingTop: 8 },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 6,
  },
  skeletonLines: { flex: 1, gap: 8 },
  modalMask: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 18,
    gap: 12,
  },
  detailHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  detailTitle: { flex: 1, minWidth: 0, fontSize: 20, lineHeight: 26 },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  riskPill: {
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  fieldBox: { borderRadius: Radius.control, padding: 12, gap: 10 },
  fieldRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  fieldValue: { flexShrink: 1, textAlign: "right" },
});
