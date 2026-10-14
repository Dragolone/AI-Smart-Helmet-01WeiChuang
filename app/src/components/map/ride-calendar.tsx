// 地图页「行程」的月历：按日期找某一天的行程，不用在列表里一直往下翻。
// 哪几天骑过在日子下面标一个点；点有行程的那一天 = 列表只看那一天，「查看整月」= 只看这个月。
// 数据（这个月的行程）和「现在看的是哪个月」在页面里，这里只管画。
import { Ionicons } from "@expo/vector-icons";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";

import { SecondaryButton } from "@/components/form";
import { Skeleton } from "@/components/skeleton";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { useLocale, useT } from "@/i18n";
import { dayTitle, formatKm, monthTitle, weekdayInitials } from "@/i18n/format";
import {
  dayKeyIn,
  isMonthBefore,
  monthGrid,
  newerMonth,
  olderMonth,
  type DayStat,
  type MonthCursor,
} from "@/services/rides";

const BAR = 44;
const WEEKDAYS = 26;
const CELL_MIN = 38;
const CELL_MAX = 46;
/** 日子外面那一圈（选中时的底、今天的描边）的直径 */
const DISC = 34;

interface Props {
  /** 可见区域的高度：和行程列表同一个数，抽屉高度不跟着跳 */
  height: number;
  month: MonthCursor;
  /** 最早能翻到的月（头盔登记的那个月）和最晚的月（这个月） */
  min: MonthCursor;
  max: MonthCursor;
  /** 今天的日期键；晚于今天的日子不能点 */
  todayKey: string;
  status: "loading" | "error" | "ready";
  /** 这个月里有行程的日子 → 几趟、多少米 */
  stats: ReadonlyMap<string, DayStat>;
  /** 列表现在只看的那一天（在这个月里才会被标出来） */
  selectedDayKey: string | null;
  /** 列表现在是不是在按日期看：是的话底部多一个「查看全部行程」 */
  filtered: boolean;
  onMonth: (month: MonthCursor) => void;
  onPickDay: (dayKey: string) => void;
  onPickMonth: () => void;
  onShowAll: () => void;
  onRetry: () => void;
}

export function RideCalendar({
  height,
  month,
  min,
  max,
  todayKey,
  status,
  stats,
  selectedDayKey,
  filtered,
  onMonth,
  onPickDay,
  onPickMonth,
  onShowAll,
  onRetry,
}: Props) {
  const theme = useTheme();
  const t = useT();
  const locale = useLocale();

  const weeks = monthGrid(month);
  const canOlder = isMonthBefore(min, month);
  const canNewer = isMonthBefore(month, max);
  // 留给格子的高度按行数分：四行的月份格子高一点，六行的矮一点
  const footer = filtered ? 108 : 56;
  const cell = Math.max(
    CELL_MIN,
    Math.min(
      CELL_MAX,
      Math.floor((height - BAR - WEEKDAYS - footer) / weeks.length),
    ),
  );

  let rides = 0;
  let meters = 0;
  for (const stat of stats.values()) {
    rides += stat.rides;
    meters += stat.distanceMeters;
  }
  const title = monthTitle(month.year, month.month, locale);

  return (
    <ScrollView
      style={[styles.viewport, { height }]}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
    >
      <View style={styles.bar}>
        <Tappable
          feedback="opacity"
          accessibilityRole="button"
          accessibilityLabel={t("map.rides.prevMonth")}
          disabled={!canOlder}
          onPress={() => onMonth(olderMonth(month))}
          style={[styles.nav, { backgroundColor: theme.backgroundSelected }]}
        >
          <Ionicons name="chevron-back" size={20} color={theme.text} />
        </Tappable>
        <ThemedText
          type="smallBold"
          accessibilityRole="header"
          style={styles.month}
        >
          {title}
        </ThemedText>
        <Tappable
          feedback="opacity"
          accessibilityRole="button"
          accessibilityLabel={t("map.rides.nextMonth")}
          disabled={!canNewer}
          onPress={() => onMonth(newerMonth(month))}
          style={[styles.nav, { backgroundColor: theme.backgroundSelected }]}
        >
          <Ionicons name="chevron-forward" size={20} color={theme.text} />
        </Tappable>
      </View>

      <View
        style={styles.weekdays}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {weekdayInitials(locale).map((name, i) => (
          <ThemedText
            key={i}
            type="small"
            themeColor="textSecondary"
            style={styles.weekday}
          >
            {name}
          </ThemedText>
        ))}
      </View>

      {/* 换月份时格子淡入一下：日子的位置整体挪了，直接跳过去像闪了一下 */}
      <Animated.View
        key={`${month.year}-${month.month}`}
        entering={FadeIn.duration(160)}
      >
        {weeks.map((week, w) => (
          <View key={w} style={styles.week}>
            {week.map((day, i) => {
              if (day === null) {
                return <View key={i} style={[styles.cell, { height: cell }]} />;
              }
              const key = dayKeyIn(month, day);
              const stat = stats.get(key);
              const future = key > todayKey;
              const selected = key === selectedDayKey;
              const today = key === todayKey;
              const label = dayTitle(
                new Date(month.year, month.month, day, 12).toISOString(),
                locale,
              );
              const disc = (
                <View
                  style={[
                    styles.disc,
                    selected && { backgroundColor: theme.brand },
                    today &&
                      !selected && {
                        borderWidth: 1.5,
                        borderColor: theme.borderStrong,
                      },
                  ]}
                >
                  <ThemedText
                    type={stat ? "smallBold" : "small"}
                    style={[
                      styles.dayText,
                      {
                        color: selected
                          ? theme.onBrand
                          : stat
                            ? theme.text
                            : theme.textSecondary,
                      },
                      !stat && { opacity: future ? 0.35 : 0.7 },
                    ]}
                  >
                    {day}
                  </ThemedText>
                </View>
              );
              if (!stat) {
                return (
                  <View
                    key={i}
                    accessible
                    accessibilityLabel={t("map.rides.dayNoneA11y", {
                      date: label,
                    })}
                    style={[styles.cell, { height: cell }]}
                  >
                    {disc}
                    <View style={styles.dot} />
                  </View>
                );
              }
              return (
                <Tappable
                  key={i}
                  feedback="opacity"
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={t("map.rides.dayA11y", {
                    date: label,
                    n: stat.rides,
                    km: formatKm(stat.distanceMeters),
                  })}
                  onPress={() => onPickDay(key)}
                  style={[styles.cell, { height: cell }]}
                >
                  {disc}
                  <View
                    style={[
                      styles.dot,
                      {
                        backgroundColor: selected ? "transparent" : theme.brand,
                      },
                    ]}
                  />
                </Tappable>
              );
            })}
          </View>
        ))}
      </Animated.View>

      <View style={[styles.sum, { borderTopColor: theme.border }]}>
        {status === "loading" ? (
          <View
            accessible
            accessibilityLabel={t("map.rides.monthLoading")}
            style={styles.sumBody}
          >
            <Skeleton width={150} height={14} radius={7} />
          </View>
        ) : status === "error" ? (
          <>
            <ThemedText
              type="small"
              numberOfLines={2}
              style={[styles.sumText, { color: theme.warning }]}
            >
              {t("map.rides.monthFailed")}
            </ThemedText>
            <Tappable
              feedback="opacity"
              accessibilityRole="button"
              onPress={onRetry}
              style={styles.sumLink}
            >
              <ThemedText type="smallBold" style={styles.sumLinkText}>
                {t("map.retry")}
              </ThemedText>
            </Tappable>
          </>
        ) : rides === 0 ? (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.sumText}
          >
            {t("map.rides.monthNone")}
          </ThemedText>
        ) : (
          <>
            <ThemedText type="small" numberOfLines={1} style={styles.sumText}>
              {t("map.rides.monthSum", { n: rides, km: formatKm(meters) })}
            </ThemedText>
            <Tappable
              feedback="opacity"
              accessibilityRole="button"
              accessibilityLabel={t("map.rides.monthAllA11y", { month: title })}
              onPress={onPickMonth}
              style={styles.sumLink}
            >
              <ThemedText type="smallBold" style={styles.sumLinkText}>
                {t("map.rides.monthAll")}
              </ThemedText>
              <Ionicons name="chevron-forward" size={16} color={theme.text} />
            </Tappable>
          </>
        )}
      </View>

      {filtered && (
        <SecondaryButton
          compact
          title={t("map.rides.showAll")}
          onPress={onShowAll}
          style={styles.all}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  viewport: { alignSelf: "stretch" },
  content: { paddingBottom: 12 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: BAR,
  },
  nav: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  month: { fontSize: 16, lineHeight: 22, fontVariant: ["tabular-nums"] },
  weekdays: { flexDirection: "row", height: WEEKDAYS, alignItems: "center" },
  weekday: { flex: 1, textAlign: "center", fontSize: 12, lineHeight: 16 },
  week: { flexDirection: "row" },
  cell: { flex: 1, alignItems: "center", justifyContent: "center" },
  disc: {
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dayText: { fontSize: 15, lineHeight: 20, fontVariant: ["tabular-nums"] },
  // 有行程的日子下面的小点；没有行程的也占着这个位置，日子的数字才对得齐
  dot: { width: 5, height: 5, borderRadius: 2.5, marginTop: -3 },
  sum: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 48,
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sumBody: { flex: 1, justifyContent: "center" },
  sumText: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    lineHeight: 20,
    fontVariant: ["tabular-nums"],
  },
  sumLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 44,
    paddingLeft: 8,
  },
  sumLinkText: { fontSize: 14, lineHeight: 20 },
  all: { marginTop: 6 },
});
