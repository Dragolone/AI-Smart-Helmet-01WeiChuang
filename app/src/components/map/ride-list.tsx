// 地图页「行程」列表：按天分组，一趟一行；加载中 / 加载失败 / 确实没有 三种情况分开写，
// 不把「没取到」说成「没有行程」。数据和翻页在页面里（hooks/use-rides），这里只管画。
import { Ionicons } from "@expo/vector-icons";
import { ScrollView, StyleSheet, View } from "react-native";
import type { RideSummary } from "@helmet/shared";

import { SecondaryButton } from "@/components/form";
import { Skeleton } from "@/components/skeleton";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT, type Locale } from "@/i18n";
import { dayTitle, formatKm, sameLocalDay, shortTime } from "@/i18n/format";
import {
  durationParts,
  rideMaxKmh,
  rideSeconds,
  type MonthCursor,
  type RideDay,
} from "@/services/rides";

type Translate = ReturnType<typeof useT>;

/** 「36 分钟」/「1 小时 46 分」/ 整小时「2 小时」（原来写「2 小时 0 分」） */
export function durationText(seconds: number, t: Translate): string {
  const { hours, minutes } = durationParts(seconds);
  if (hours === 0) return t("map.rides.durMin", { m: minutes });
  return minutes === 0
    ? t("map.rides.durHourOnly", { h: hours })
    : t("map.rides.durHour", { h: hours, m: minutes });
}

/** 「18:05 – 18:41」；进行中的写「19:02 – 现在」；跨过零点的写「15:00 – 次日 15:00」 */
export function rideTimeRange(
  ride: RideSummary,
  locale: Locale,
  t: Translate,
): string {
  const end = ride.ongoing
    ? t("map.rides.now")
    : endTimeLabel(ride.startAt, ride.endAt, locale, t);
  return `${shortTime(ride.startAt, locale)} – ${end}`;
}

/**
 * 结束时刻：和开始不在同一天就加「次日」。行程最长 24 小时（后端按天网格切），所以最多跨一天；
 * 原来只写钟点，「15:00 – 15:00 · 24 小时」看着像零时长（2026-10-15 边界测试）
 */
export function endTimeLabel(
  startIso: string,
  endIso: string,
  locale: Locale,
  t: Translate,
): string {
  const time = shortTime(endIso, locale);
  return sameLocalDay(startIso, endIso)
    ? time
    : t("map.rides.nextDay", { time });
}

export type RideListStatus = "loading" | "error" | "empty" | "ready";

interface Props {
  /** 列表可见区域的高度：抽屉的高度由它定 */
  height: number;
  status: RideListStatus;
  days: RideDay[];
  onRetry: () => void;
  onPick: (ride: RideSummary) => void;
  /** 更早的从哪个月接着加载；null = 没有更早的了 */
  older: MonthCursor | null;
  loadingOlder: boolean;
  olderFailed: boolean;
  onLoadOlder: () => void;
  /**
   * 列表只看某一天 / 某个月时给（按日期找，见 ride-calendar）：底部换成「查看全部行程」，
   * 不再往更早的月翻
   */
  onShowAll?: () => void;
}

export function RideList({
  height,
  status,
  days,
  onRetry,
  onPick,
  older,
  loadingOlder,
  olderFailed,
  onLoadOlder,
  onShowAll,
}: Props) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();

  if (status === "loading") {
    return (
      <View
        style={[styles.viewport, { height }]}
        accessible
        accessibilityLabel={t("map.rides.loading")}
      >
        <Skeleton width={72} height={14} radius={7} style={styles.skDay} />
        {[130, 150, 120].map((w) => (
          <View key={w} style={styles.row}>
            <Skeleton width={40} height={40} radius={20} />
            <View style={styles.rowBody}>
              <Skeleton width={w} height={14} radius={7} />
              <Skeleton width={w + 40} height={12} radius={6} />
            </View>
          </View>
        ))}
      </View>
    );
  }

  if (status === "error" || status === "empty") {
    const failed = status === "error";
    return (
      <View style={[styles.viewport, styles.center, { height }]}>
        <View
          style={[
            styles.stateIcon,
            {
              backgroundColor: failed
                ? theme.warningBg
                : theme.backgroundSelected,
            },
          ]}
        >
          <Ionicons
            name={failed ? "alert-circle-outline" : "trail-sign-outline"}
            size={26}
            color={failed ? theme.warning : theme.textSecondary}
          />
        </View>
        <ThemedText type="smallBold" style={styles.stateTitle}>
          {t(
            failed
              ? "map.rides.errorTitle"
              : onShowAll
                ? "map.rides.filterEmptyTitle"
                : "map.rides.emptyTitle",
          )}
        </ThemedText>
        {/* 按日期看却一趟都没有：不解释「怎样才会有行程」，给一条回到全部的路 */}
        {(failed || !onShowAll) && (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.stateBody}
          >
            {t(failed ? "map.rides.errorBody" : "map.rides.emptyBody")}
          </ThemedText>
        )}
        {failed ? (
          <SecondaryButton
            compact
            title={t("map.retry")}
            onPress={onRetry}
            style={styles.retry}
          />
        ) : (
          onShowAll && (
            <SecondaryButton
              compact
              title={t("map.rides.showAll")}
              onPress={onShowAll}
              style={styles.retry}
            />
          )
        )}
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.viewport, { height }]}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      // 抽屉自己不跟着列表滚：列表滚到头不带动外层
      nestedScrollEnabled
    >
      {days.map((day) => {
        const title = dayTitle(day.at, locale);
        return (
          <View key={day.key}>
            <View style={styles.dayHead}>
              <ThemedText
                type="smallBold"
                accessibilityRole="header"
                style={styles.dayTitle}
              >
                {title}
              </ThemedText>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.daySum}
              >
                {t("map.rides.daySum", {
                  n: day.rides.length,
                  km: formatKm(day.distanceMeters),
                })}
              </ThemedText>
            </View>
            {day.rides.map((ride, i) => {
              const time = rideTimeRange(ride, locale, t);
              const dur = durationText(rideSeconds(ride), t);
              // 最高速度是服务端取的原始速度：GPS 漂移时会出现「最高 1440 km/h」，不像真的就不写；
              // 不小于平均速度（和一趟详情里同一个口径，O25）
              const max = rideMaxKmh(ride);
              const sub = ride.ongoing
                ? t("map.rides.live", { dur })
                : max !== null
                  ? t("map.rides.rowMax", { dur, max: Math.round(max) })
                  : dur;
              const km = formatKm(ride.distanceMeters);
              return (
                <Tappable
                  key={ride.startAt}
                  feedback="fill"
                  accessibilityRole="button"
                  accessibilityLabel={t("map.rides.rowA11y", {
                    day: title,
                    time,
                    km,
                    sub,
                  })}
                  onPress={() => onPick(ride)}
                  style={[
                    styles.row,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: theme.border,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.rowIcon,
                      {
                        backgroundColor: ride.ongoing
                          ? theme.brand
                          : theme.backgroundSelected,
                      },
                    ]}
                  >
                    <Ionicons
                      name="trail-sign-outline"
                      size={18}
                      color={ride.ongoing ? theme.onBrand : theme.text}
                    />
                  </View>
                  <View style={styles.rowBody}>
                    <ThemedText
                      type="smallBold"
                      numberOfLines={1}
                      style={styles.rowTime}
                    >
                      {time}
                    </ThemedText>
                    <ThemedText
                      type="small"
                      themeColor="textSecondary"
                      numberOfLines={1}
                      style={styles.rowSub}
                    >
                      {sub}
                    </ThemedText>
                  </View>
                  <ThemedText type="smallBold" style={styles.rowKm}>
                    {km}
                    <ThemedText
                      type="small"
                      themeColor="textSecondary"
                      style={styles.rowKmUnit}
                    >
                      {" km"}
                    </ThemedText>
                  </ThemedText>
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={theme.textSecondary}
                  />
                </Tappable>
              );
            })}
          </View>
        );
      })}

      {onShowAll ? (
        <SecondaryButton
          compact
          title={t("map.rides.showAll")}
          onPress={onShowAll}
          style={styles.older}
        />
      ) : older ? (
        <>
          {olderFailed && (
            <ThemedText
              type="small"
              style={[styles.olderFailed, { color: theme.warning }]}
            >
              {t("map.rides.moreFailed")}
            </ThemedText>
          )}
          <SecondaryButton
            compact
            title={t(
              loadingOlder ? "map.rides.loadingMore" : "map.rides.loadOlder",
            )}
            loading={loadingOlder}
            onPress={onLoadOlder}
            style={styles.older}
          />
        </>
      ) : (
        <ThemedText type="small" themeColor="textSecondary" style={styles.end}>
          {t("map.rides.end")}
        </ThemedText>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  viewport: { alignSelf: "stretch" },
  content: { paddingBottom: 20 },
  center: { alignItems: "center", justifyContent: "center", padding: 24 },
  skDay: { marginTop: 18, marginBottom: 4 },
  dayHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingTop: 16,
    paddingBottom: 6,
  },
  dayTitle: { fontSize: 13, lineHeight: 18 },
  daySum: { fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 64,
  },
  rowIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTime: { fontSize: 15, lineHeight: 20, fontVariant: ["tabular-nums"] },
  rowSub: { fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
  rowKm: { fontSize: 15, lineHeight: 20, fontVariant: ["tabular-nums"] },
  rowKmUnit: { fontSize: 13, lineHeight: 20 },
  stateIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  stateTitle: { fontSize: 17, lineHeight: 24, marginTop: 14 },
  stateBody: {
    fontSize: 14,
    lineHeight: 21,
    marginTop: 6,
    textAlign: "center",
  },
  retry: { marginTop: 18, alignSelf: "center", paddingHorizontal: 32 },
  older: { marginTop: 18 },
  olderFailed: { fontSize: 13, lineHeight: 18, marginTop: 14 },
  end: {
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    paddingTop: 20,
    paddingBottom: 4,
  },
});
