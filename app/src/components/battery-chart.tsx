// 电量历史图（设备详情页，2026-09-10）：仿 iPhone「电池」页的 24 小时柱状图。
// 纯 View 画柱子，不引 SVG/图表依赖；每根柱 = 一小时（取该小时最后一个采样），充电中的小时用 warning 色。
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { BatteryHistoryPoint } from '@helmet/shared';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

const HOURS = 24;

/** 把散点归到最近 24 个整点；一小时内多点取最后一个，没有点的小时留空 */
function bucketByHour(points: BatteryHistoryPoint[], now: number) {
  const out: (BatteryHistoryPoint | null)[] = Array.from({ length: HOURS }, () => null);
  const start = now - HOURS * 3_600_000;
  for (const p of points) {
    const t = new Date(p.timestamp).getTime();
    const idx = Math.floor((t - start) / 3_600_000);
    if (idx >= 0 && idx < HOURS) out[idx] = p;
  }
  return out;
}

export function BatteryChart({
  points,
  to,
  current,
  charging,
  labels,
}: {
  points: BatteryHistoryPoint[];
  /** 数据窗口右端（服务端响应的 to）；缺省用挂载时刻——渲染期不能调 Date.now()（React Compiler） */
  to?: string;
  current: number | null;
  charging: boolean | null;
  labels: { title: string; window: string; charging: string; empty: string };
}) {
  const theme = useTheme();
  const [mountedAt] = useState(() => Date.now());
  const now = to ? new Date(to).getTime() : mountedAt;
  const buckets = bucketByHour(points, now);
  const hasData = buckets.some((b) => b !== null);
  const currentColor =
    current === null ? theme.textSecondary : current <= 20 ? theme.danger : theme.brand;
  const nowHour = new Date(now).getHours();
  const tick = (offsetFromEnd: number) => `${((nowHour - offsetFromEnd + 24 * 3) % 24).toString().padStart(2, '0')}:00`;

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <View>
          <ThemedText type="small" themeColor="textSecondary" style={{ fontSize: 12 }}>
            {labels.title}
          </ThemedText>
          <View style={styles.valueRow}>
            <ThemedText type="display" style={{ color: currentColor, fontSize: 30, lineHeight: 36 }}>
              {current !== null ? current : '—'}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              %{charging ? ` · ${labels.charging}` : ''}
            </ThemedText>
          </View>
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={{ fontSize: 12 }}>
          {labels.window}
        </ThemedText>
      </View>

      <View style={styles.plot}>
        {/* 参考线 100 / 50 / 0 */}
        {[0, 0.5, 1].map((r) => (
          <View key={r} pointerEvents="none" style={[styles.gridLine, { top: `${r * 100}%`, backgroundColor: theme.border }]} />
        ))}
        <View style={styles.bars}>
          {buckets.map((b, i) => (
            <View key={i} style={styles.barSlot}>
              {b && (
                <View
                  style={[
                    styles.bar,
                    {
                      height: `${Math.max(3, b.battery)}%`,
                      backgroundColor: b.charging ? theme.warning : b.battery <= 20 ? theme.danger : theme.brand,
                    },
                  ]}
                />
              )}
            </View>
          ))}
        </View>
        {!hasData && (
          <View style={styles.emptyOverlay} pointerEvents="none">
            <ThemedText type="small" themeColor="textSecondary">
              {labels.empty}
            </ThemedText>
          </View>
        )}
      </View>
      <View style={styles.axis}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.axisText}>{tick(24)}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.axisText}>{tick(12)}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.axisText}>{tick(0)}</ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  plot: { height: 96, justifyContent: 'flex-end' },
  gridLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth },
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: '100%', gap: 3 },
  barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 2 },
  emptyOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { fontSize: 11 },
});
