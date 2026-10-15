// 状态小标：图标 + 文字。图标带语义色，文字用正文色——状态不只靠颜色区分，小字也保持足够对比度。
// 图标用描边款：实心圆排成一排看着像贴纸（负责人 2026-10-15）。变档时图标淡入淡出并弹一下，不硬切。
import type { Ionicons } from "@expo/vector-icons";
import { StyleSheet, View } from "react-native";

import { CrossfadeIcon } from "@/components/motion";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";
import type { CheckLevel } from "@/services/safety-status";

/**
 * ok = 已核实正常；warn = 此刻不满足但属于常态（头盔没连上）；unknown = 还确认不了；
 * bad = 有设置要用户去改，或出了故障。四档图标各不相同，不靠颜色也分得开。
 */
export type ChipLevel = CheckLevel;

const ICONS: Record<ChipLevel, keyof typeof Ionicons.glyphMap> = {
  ok: "checkmark-circle-outline",
  warn: "alert-circle-outline",
  unknown: "help-circle-outline",
  bad: "close-circle-outline",
};

export function StatusChip({
  level,
  label,
}: {
  level: ChipLevel;
  label: string;
}) {
  const theme = useTheme();
  const color =
    level === "ok"
      ? theme.success
      : level === "bad"
        ? theme.danger
        : theme.warning;
  return (
    <View style={styles.chip}>
      <CrossfadeIcon name={ICONS[level]} size={16} color={color} pop />
      <ThemedText type="small" style={styles.label}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1 },
  label: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
});
