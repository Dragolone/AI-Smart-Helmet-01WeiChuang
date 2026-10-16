// 安全记录（独立页，2026-10-06；2026-10-07 改为所有头盔排在一起）：从安全首页「安全记录」进入。
// 两类记录分开展示、各走各的数据源，不统一叫「事故」：
// - 风险提醒 = 头盔雷达类提醒及其解除（API.md §6）；
// - SOS 记录 = 求救单及处理结果（API.md §7，含已取消的）。
// 所有头盔的记录按时间排成一份，绑了两顶以上时每条写明是哪一顶，分类下面有一排头盔名可以只看一顶。
// 接口是按头盔取的：各取一遍后合并（services/safety-records.ts），没拿到的不当成「没有」。
// 进行中的 SOS 不受头盔筛选影响：别的头盔上有一条正在倒计时，这一页顶部照样显示。
import { Ionicons } from "@expo/vector-icons";
import { useQueries, useQuery } from "@tanstack/react-query";
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

import { accidentHref, sosActiveHref } from "@/services/sos-routes";
import { toUserMessage } from "@/api/error-messages";
import { eventsApi, eventsListQuery } from "@/api/events";
import { sosApi } from "@/api/sos";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { FluidSegmented } from "@/components/fluid-segmented";
import { PrimaryButton, SecondaryButton } from "@/components/form";
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
import { readableEventFields, riskLevelOf } from "@/services/event-fields";
import {
  combinePages,
  detailBelongsTo,
  mergeRecords,
  recordKeyOf,
  type MergedRecords,
  type PageResult,
} from "@/services/safety-records";
import { helmetNameOf, linkLevelOf } from "@/services/safety-status";

type Translate = ReturnType<typeof useT>;

/** 每页条数：风险提醒一页 50、SOS 记录一页 20（与以前首屏一样）；「加载更多」每点一次每顶头盔多取一页 */
const ALERT_PAGE = 50;
const SOS_PAGE = 20;
/** 第 2 页到第 n 页（n < 2 时为空） */
const pagesAfterFirst = (n: number) =>
  Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 2);
type Tone = "danger" | "warning" | "success" | "neutral";
type RecordTab = "alerts" | "sos";
/** 筛选 chip 里「全部头盔」那一项的值（deviceId 不会长这样） */
const ALL_HELMETS = "__all__";

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
  // 安全首页的「安全记录」带 tab=sos 进来（那一行写的是最近一条 SOS）；不带参数时落在「风险提醒」
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<RecordTab>(
    params.tab === "sos" ? "sos" : "alerts",
  );
  // 点开的是哪一顶头盔的哪一条：eventId 只在一顶头盔内唯一（决策 #54），只记 eventId 分不清两顶的同号事件
  const [detailOf, setDetailOf] = useState<{
    deviceId: string;
    eventId: string;
  } | null>(null);
  const closeDetail = () => setDetailOf(null);

  const helmets = useHelmets();
  const { list } = helmets;
  const links = useHelmetLinks(list, !helmets.stale);
  const pending = usePendingSos(list.map((d) => d.deviceId));
  const several = list.length > 1;
  const nameOfDevice = (deviceId: string) =>
    helmetNameOf(
      list.find((d) => d.deviceId === deviceId) ?? { name: null, deviceId },
    );
  // 只看哪一顶：null = 全部。选过的那顶已经解绑时回到全部
  const [picked, setPicked] = useState<string | null>(null);
  const only = several
    ? (list.find((d) => d.deviceId === picked) ?? null)
    : (list[0] ?? null);

  // 每顶头盔各取一份（第 1 页的缓存键与此前相同：实时通道按前缀失效，use-realtime）；筛选只决定显示哪几份
  const alertQueries = useQueries({
    queries: list.map((d) => ({
      ...eventsListQuery(d.deviceId, {
        type: RISK_ALERT_TYPE_PARAM,
        pageSize: ALERT_PAGE,
      }),
      refetchInterval: 30_000,
    })),
  });
  const sosQueries = useQueries({
    queries: list.map((d) => ({
      queryKey: ["accidents", d.deviceId],
      queryFn: () => sosApi.accidents(d.deviceId),
    })),
  });
  // 「加载更多」：原来只取第 1 页，1000 条只看得到最近 20 / 50 条（2026-10-15 边界测试）。
  // 每点一次把要取的页数加一；只给第 1 页说还有的头盔取后面的页
  const [alertPages, setAlertPages] = useState(1);
  const [sosPages, setSosPages] = useState(1);
  const extraPagesOf = (
    total: number | undefined,
    pageSize: number,
    want: number,
  ) => pagesAfterFirst(Math.min(want, Math.ceil((total ?? 0) / pageSize)));
  const alertExtraPlan = list.flatMap((d, i) =>
    extraPagesOf(alertQueries[i]?.data?.total, ALERT_PAGE, alertPages).map(
      (page) => ({ i, page }),
    ),
  );
  const alertExtra = useQueries({
    queries: alertExtraPlan.map(({ i, page }) =>
      eventsListQuery(list[i].deviceId, {
        type: RISK_ALERT_TYPE_PARAM,
        pageSize: ALERT_PAGE,
        page,
      }),
    ),
  });
  const sosExtraPlan = list.flatMap((d, i) =>
    extraPagesOf(sosQueries[i]?.data?.total, SOS_PAGE, sosPages).map(
      (page) => ({ i, page }),
    ),
  );
  const sosExtra = useQueries({
    queries: sosExtraPlan.map(({ i, page }) => ({
      queryKey: ["accidents", list[i].deviceId, page],
      queryFn: () => sosApi.accidents(list[i].deviceId, page, SOS_PAGE),
    })),
  });
  /** 一顶头盔的第 1 页 + 已取的后面几页拼成一份 */
  const withPages = <T,>(
    first: PageResult<T>[],
    plan: { i: number; page: number }[],
    extra: PageResult<T>[],
    keyOf: (item: T) => string,
  ) =>
    list.map((d, i) =>
      combinePages(
        d.deviceId,
        first[i],
        plan
          .map((p, k) => ({ ...p, q: extra[k] }))
          .filter((p) => p.i === i)
          .sort((a, b) => a.page - b.page)
          .map((p) => p.q),
        keyOf,
      ),
    );
  // 两页刷新之间来了新记录时，同一条会暂时同时出现在两页里：按编号去重（见 combinePages）
  const alertSources = withPages(
    alertQueries,
    alertExtraPlan,
    alertExtra,
    (e: EventListItem) => e.eventId,
  );
  const sosSources = withPages(
    sosQueries,
    sosExtraPlan,
    sosExtra,
    (a: AccidentListItem) => a.sosId,
  );
  const shown = (i: number) => !only || list[i].deviceId === only.deviceId;
  const alerts = mergeRecords(
    alertSources.filter((_, i) => shown(i)),
    (e: EventListItem) => e.timestamp,
  );
  const sosRecords = mergeRecords(
    sosSources.filter((_, i) => shown(i)),
    (a: AccidentListItem) => a.createdAt,
  );
  const alertsLoadingMore = alertSources.some(
    (s, i) => shown(i) && s.loadingMore,
  );
  const sosLoadingMore = sosSources.some((s, i) => shown(i) && s.loadingMore);
  const refetchRecords = () =>
    Promise.all(
      (tab === "alerts" ? alertQueries : sosQueries)
        .filter((_, i) => shown(i))
        .map((q) => q.refetch()),
    );

  // 只由手势驱动：绑到 isRefetching 的话，30 秒轮询也会拉出转圈（设备页同一口径）
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([helmets.refetch(), refetchRecords()]);
    } finally {
      setRefreshing(false);
    }
  };

  const detail = useQuery({
    queryKey: ["event-detail", detailOf?.deviceId, detailOf?.eventId],
    queryFn: () => eventsApi.detail(detailOf!.eventId),
    enabled: !!detailOf,
  });

  const toneColor = (tone: Tone) =>
    tone === "danger"
      ? { fg: theme.danger, bg: theme.dangerBg }
      : tone === "warning"
        ? { fg: theme.warning, bg: theme.warningBg }
        : tone === "success"
          ? { fg: theme.success, bg: theme.successBg }
          : { fg: theme.textSecondary, bg: theme.backgroundSelected };

  // 详情接口只按 eventId 查，可能拿回另一顶头盔的同号事件：对不上就不显示，提示打不开
  const d = detailBelongsTo(detail.data, detailOf) ? detail.data : undefined;
  const detailMismatch = !!detail.data && !d;
  const level = d ? riskLevelOf(d.payload) : null;
  const dRisk = level ? RISK_LABEL[level] : null;
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

  // 绑了两顶以上时每条写明是哪一顶，名字放在时间前面：竖着扫一眼就能分出是谁的
  // 头盔名 + 时间：名字可以省略，时间不能被挤掉——原来拼成一串单行截断，右边有「通知已启动」
  // 这类徽标时整段时间都看不到，只剩「helmet_night_a ·…」（2026-10-16 模拟器）
  const subOf = (deviceId: string, iso: string) => (
    <View style={styles.subLine}>
      {several && (
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={[styles.rowSub, styles.subName]}
          numberOfLines={1}
        >
          {nameOfDevice(deviceId)}
        </ThemedText>
      )}
      <ThemedText type="small" themeColor="textSecondary" style={styles.rowSub}>
        {several ? ` · ${shortTime(iso, locale)}` : shortTime(iso, locale)}
      </ThemedText>
    </View>
  );

  const alertRow = (e: EventListItem, deviceId: string, last: boolean) => {
    const meta = EVENT_META[e.eventType];
    const c = toneColor(meta?.tone ?? "neutral");
    return (
      <Tappable
        key={recordKeyOf(deviceId, e.eventId)}
        feedback="fill"
        accessibilityRole="button"
        onPress={() => setDetailOf({ deviceId, eventId: e.eventId })}
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
          {subOf(deviceId, e.timestamp)}
        </View>
        <Ionicons
          name="chevron-forward"
          size={16}
          color={theme.textSecondary}
        />
      </Tappable>
    );
  };

  const sosRow = (a: AccidentListItem, deviceId: string, last: boolean) => {
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
        onPress={() => router.navigate(accidentHref(a.sosId))}
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
          {subOf(deviceId, a.createdAt)}
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

  /** 一类记录的列表：加载中 / 加载失败 / 空 / 按天分组。没拿全的不显示成「暂无记录」 */
  function recordList<T>(opts: {
    merged: MergedRecords<T>;
    timeOf: (x: T) => string;
    renderRow: (x: T, deviceId: string, last: boolean) => ReactNode;
    emptyTitle: MessageKey;
    notes: string[];
    loadingMore: boolean;
    onLoadMore: () => void;
  }) {
    const { merged } = opts;
    const failedState = (
      <EmptyState
        icon="cloud-offline-outline"
        title={t("records.loadFailed")}
        body={toUserMessage(merged.error)}
        actionLabel={t("safety.action.retry")}
        onAction={() => void refetchRecords()}
      />
    );
    if (merged.status === "loading") return <ListSkeleton />;
    if (merged.status === "failed") return failedState;
    if (merged.rows.length === 0) {
      // 还有头盔的列表没拿到：先别说「暂无」
      if (merged.incomplete)
        return merged.error ? failedState : <ListSkeleton />;
      return <EmptyState icon="file-tray-outline" title={t(opts.emptyTitle)} />;
    }
    return (
      <>
        {merged.error != null &&
          note(
            t("records.partialFailed", {
              reason: toUserMessage(merged.error),
            }),
          )}
        {groupByDay(merged.rows, (r) => opts.timeOf(r.item)).map((g) => (
          <View key={g.key} style={styles.group}>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.dayHeader}
            >
              {dayHeaderOf(g.iso, locale, t)}
            </ThemedText>
            <Card>
              {g.items.map((r, i) =>
                opts.renderRow(r.item, r.deviceId, i === g.items.length - 1),
              )}
            </Card>
          </View>
        ))}
        {merged.total > merged.rows.length &&
          note(
            t("records.truncated", {
              n: merged.rows.length,
              total: merged.total,
            }),
          )}
        {merged.hasMore && (
          <SecondaryButton
            compact
            title={t(
              opts.loadingMore ? "records.loadingMore" : "records.loadMore",
            )}
            loading={opts.loadingMore}
            onPress={opts.onLoadMore}
          />
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
    if (list.length === 0)
      return (
        <EmptyState
          icon="shield-half-outline"
          title={t("safety.state.noHelmet")}
          body={t("records.noHelmetBody")}
        />
      );
    // 「连接断开期间收不到新事件」只在看单独一顶、且它没连着时说
    const linkDown = !!only && linkLevelOf(links[only.deviceId]) === "down";
    const chips = [
      { id: null as string | null, label: t("records.allHelmets") },
      ...list.map((d) => ({
        id: d.deviceId as string | null,
        label: helmetNameOf(d),
      })),
    ];
    return (
      <>
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
        {/* 只有一顶头盔时没有可筛的，这一排不出现 */}
        {several && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityLabel={t("records.filterA11y")}
            style={styles.chipsScroll}
            contentContainerStyle={styles.chips}
          >
            {/* 高亮是一颗滑块，在 chip 之间滑过去；「全部」用一个占位值，deviceId 不会长这样 */}
            <FluidSegmented
              equal={false}
              options={chips.map((c) => ({
                value: c.id ?? ALL_HELMETS,
                label: c.label,
              }))}
              current={only?.deviceId ?? ALL_HELMETS}
              onSelect={(v) => setPicked(v === ALL_HELMETS ? null : v)}
              palette={{
                thumb: theme.text,
                activeText: theme.background,
                text: theme.text,
                tentativeText: theme.text,
                outline: theme.borderStrong,
                border: theme.borderStrong,
              }}
              style={styles.chipRow}
              segmentStyle={styles.chip}
              thumbStyle={styles.chipThumb}
            />
          </ScrollView>
        )}
        {tab === "alerts"
          ? recordList({
              merged: alerts,
              timeOf: (e) => e.timestamp,
              renderRow: alertRow,
              emptyTitle: only
                ? "records.alertsEmpty"
                : "records.alertsEmptyAll",
              notes: linkDown ? [t("records.linkDownNote")] : [],
              loadingMore: alertsLoadingMore,
              onLoadMore: () => setAlertPages((n) => n + 1),
            })
          : recordList({
              merged: sosRecords,
              timeOf: (a) => a.createdAt,
              renderRow: sosRow,
              emptyTitle: only ? "records.sosEmpty" : "records.sosEmptyAll",
              notes: [t("records.sosNote")],
              loadingMore: sosLoadingMore,
              onLoadMore: () => setSosPages((n) => n + 1),
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
              router.navigate(sosActiveHref(sos.sosId, sos.deviceId))
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
        visible={!!detailOf}
        transparent
        animationType="fade"
        onRequestClose={closeDetail}
      >
        <Pressable
          accessible={false}
          style={styles.modalMask}
          onPress={closeDetail}
        >
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
              // 只用来挡住「点卡片关弹层」；不能自成一个读屏焦点，否则里面的选项 / 输入框被合成一块、读屏选不中
              accessible={false}
              onPress={() => undefined}
            >
              <View style={styles.detailHeader}>
                <ThemedText type="smallBold" style={styles.detailTitle}>
                  {d
                    ? EVENT_META[d.eventType]
                      ? t(EVENT_META[d.eventType].title)
                      : d.eventType
                    : t(
                        detail.isError || detailMismatch
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
                  onPress={closeDetail}
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
                      closeDetail();
                      router.navigate({
                        pathname: "/map",
                        params: { deviceId: dev, at },
                      });
                    }}
                  />
                </>
              ) : detailMismatch ? (
                <ThemedText type="small" themeColor="textSecondary">
                  {t("records.detail.mismatch")}
                </ThemedText>
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
  // 左右各伸出 20 到屏幕边：头盔多了横向滑动时不被页面内边距切一刀
  chipsScroll: { marginHorizontal: -20, flexGrow: 0 },
  chips: { paddingHorizontal: 20, alignItems: "center", minHeight: 44 },
  chipRow: { gap: 8, alignItems: "center" },
  chip: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    borderWidth: 1,
    justifyContent: "center",
  },
  chipThumb: { borderRadius: 17 },
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
  subLine: { flexDirection: "row", alignItems: "center" },
  subName: { flexShrink: 1 },
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
