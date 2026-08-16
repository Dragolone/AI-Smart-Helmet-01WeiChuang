// 状态药丸（参考风格：Active/Critical/High 半透明底小标签）：圆点 + 文字
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'neutral';

export function Badge({ variant, label }: { variant: BadgeVariant; label: string }) {
  const theme = useTheme();
  const color =
    variant === 'success'
      ? theme.success
      : variant === 'warning'
        ? theme.warning
        : variant === 'danger'
          ? theme.danger
          : theme.textSecondary;
  const bg =
    variant === 'success'
      ? theme.successBg
      : variant === 'warning'
        ? theme.warningBg
        : variant === 'danger'
          ? theme.dangerBg
          : theme.backgroundSelected;

  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <ThemedText type="smallBold" style={{ color, fontSize: 12, lineHeight: 16 }}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: Radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
