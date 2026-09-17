// 首页「今日骑行」：本地零点到现在的里程 / 移动时长 / 最高速，数据由服务端 summary 累加。
// 今天没骑（无点或里程 <50 m）就不占位；接口未部署（404）也静默不显示。
import { useQuery } from "@tanstack/react-query";
import { StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";

import { devicesApi } from "@/api/devices";
import { Card } from "@/components/list";
import { ValueTransition } from "@/components/motion";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

const MIN_DISTANCE_M = 50;

function todayWindow(): { from: string; to: string } {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: new Date().toISOString() };
}

function formatDuration(seconds: number): { value: string; unit: "h" | "min" } {
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return { value: `${h}:${String(m).padStart(2, "0")}`, unit: "h" };
  }
  return { value: String(Math.max(1, Math.round(seconds / 60))), unit: "min" };
}

export function RideSummaryCard({ deviceId }: { deviceId: string }) {
  const theme = useTheme();
  const t = useT();
  const summary = useQuery({
    queryKey: ["ride-today", deviceId],
    queryFn: () => {
      const { from, to } = todayWindow();
      return devicesApi.locationSummary(deviceId, from, to);
    },
    refetchInterval: 60_000,
    retry: false,
  });
  const s = summary.data;
  if (!s || s.distanceMeters < MIN_DISTANCE_M) return null;
  const dur = formatDuration(s.movingSeconds);
  const maxKmh = s.maxSpeed !== null ? Math.round(s.maxSpeed * 3.6) : null;
  const stats: { label: string; value: string; unit: string }[] = [
    {
      label: t("ride.distance"),
      value: (s.distanceMeters / 1000).toFixed(1),
      unit: "km",
    },
    {
      label: t("ride.duration"),
      value: dur.value,
      unit: dur.unit === "h" ? t("ride.hours") : t("ride.minutes"),
    },
    {
      label: t("ride.maxSpeed"),
      value: maxKmh !== null ? String(maxKmh) : "—",
      unit: "km/h",
    },
  ];
  return (
    <Animated.View entering={FadeInDown.duration(260)}>
      <Card>
        <View style={styles.head}>
          <ThemedText type="smallBold" style={{ fontSize: 15 }}>
            {t("ride.today")}
          </ThemedText>
        </View>
        <View style={[styles.stats, { borderTopColor: theme.border }]}>
          {stats.map((st) => (
            <View key={st.label} style={styles.stat}>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.label}
              >
                {st.label}
              </ThemedText>
              <View style={styles.valueRow}>
                <ValueTransition value={st.value}>
                  <ThemedText type="display" style={styles.value}>
                    {st.value}
                  </ThemedText>
                </ValueTransition>
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={styles.unit}
                >
                  {st.unit}
                </ThemedText>
              </View>
            </View>
          ))}
        </View>
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10 },
  stats: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  stat: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 4,
    minWidth: 0,
  },
  label: { fontSize: 12, lineHeight: 16 },
  valueRow: { flexDirection: "row", alignItems: "baseline", gap: 3 },
  value: { fontSize: 22, lineHeight: 26, fontWeight: 600 },
  unit: { fontSize: 12 },
});
