// 设备详情状态卡里的一行：图标 + 结论（+ 一句原因）+ 右侧的时间或入口。
// 轻重只落在图标颜色上，文字保持正文色——不靠颜色也读得出来，也不把整张卡染色。
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, useWindowDimensions, View } from "react-native";

import type { IconName } from "@/components/list";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";

export type RowTone = "ok" | "warn" | "bad" | "neutral";

/**
 * 系统字体放到多大时改成上下两行排：结论（+ 原因）一行，右侧的时间 / 入口挪到下面。
 * 并排时右边的值按内容占宽，2 倍字体下左边的结论被挤成一字一行（「设 / 备 / 离 / 线」竖排），
 * 「蓝牙未连接」的原因也挤成三行（2026-10-16 模拟器系统字体 2.0 倍）。
 * 1.3 = Android「最大」、iOS 默认档往上两档（xxxLarge 1.35）附近；正常字号下仍并排。
 */
export const STACK_FONT_SCALE = 1.3;
export const statusRowStacked = (fontScale: number): boolean =>
  fontScale >= STACK_FONT_SCALE;

export function StatusRow({
  icon,
  tone,
  title,
  detail,
  trailing,
  actionLabel,
  onAction,
}: {
  icon: IconName;
  tone: RowTone;
  title: string;
  detail?: string;
  trailing?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const stacked = statusRowStacked(fontScale);
  const color =
    tone === "ok"
      ? theme.success
      : tone === "warn"
        ? theme.warning
        : tone === "bad"
          ? theme.danger
          : theme.textSecondary;
  const trailingText = trailing ? (
    <ThemedText
      type="small"
      themeColor="textSecondary"
      style={stacked ? styles.stackedTrailing : styles.trailing}
    >
      {trailing}
    </ThemedText>
  ) : null;
  const action =
    actionLabel && onAction ? (
      <View style={stacked ? styles.stackedAction : styles.action}>
        <ThemedText type="smallBold" style={styles.actionText}>
          {actionLabel}
        </ThemedText>
        <Ionicons name="chevron-forward" size={14} color={theme.text} />
      </View>
    ) : null;
  const body = (
    <>
      <Ionicons name={icon} size={18} color={color} />
      <View style={styles.text}>
        <ThemedText type="small" style={styles.title}>
          {title}
        </ThemedText>
        {detail ? (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.detail}
          >
            {detail}
          </ThemedText>
        ) : null}
        {stacked && trailingText}
        {stacked && action}
      </View>
      {!stacked && trailingText}
      {!stacked && action}
    </>
  );
  return onAction ? (
    <Tappable
      feedback="opacity"
      accessibilityRole="button"
      onPress={onAction}
      style={styles.row}
    >
      {body}
    </Tappable>
  ) : (
    <View style={styles.row}>{body}</View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 48,
    paddingVertical: 6,
  },
  text: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontSize: 14 },
  detail: { fontSize: 12, lineHeight: 17 },
  // 并排时右边最多占一半：字体略放大（还没到改上下排的档）时左边的结论也放得下，右边的值自己换行
  trailing: { fontSize: 12, lineHeight: 17, flexShrink: 1, maxWidth: "50%" },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 1,
    maxWidth: "50%",
  },
  actionText: { fontSize: 13, flexShrink: 1 },
  stackedTrailing: { fontSize: 12, lineHeight: 17 },
  stackedAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginTop: 2,
  },
});
