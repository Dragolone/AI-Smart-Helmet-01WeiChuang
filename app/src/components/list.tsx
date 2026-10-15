// 列表/卡片原语（2026-09-10 重设计定稿）：五个主页共用，保证一致性——
// 描边卡片、单色描边图标 + 灰圆底、48/62 两档行高、灰色小节标题、可点的分组标题。
import { Ionicons } from "@expo/vector-icons";
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

export type IconName = keyof typeof Ionicons.glyphMap;

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** 单色描边图标 + 灰圆底：全 App 唯一的图标容器样式（替代此前多彩方块） */
export function IconCircle({
  icon,
  size = 32,
  iconSize,
  color,
  bg,
}: {
  icon: IconName;
  size?: number;
  iconSize?: number;
  color?: string;
  bg?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg ?? theme.backgroundSelected,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons
        name={icon}
        size={iconSize ?? Math.round(size * 0.56)}
        color={color ?? theme.text}
      />
    </View>
  );
}

/** 小节标题（灰色 13px 加粗），可带右侧「更多」动作 */
export function SectionLabel({
  title,
  caption,
  action,
  onAction,
}: {
  title: string;
  caption?: string;
  action?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.sectionLabel}>
      <View style={styles.sectionLeft}>
        <ThemedText type="smallBold" style={{ fontSize: 16 }}>
          {title}
        </ThemedText>
        {caption && (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={{ fontSize: 13 }}
          >
            {caption}
          </ThemedText>
        )}
      </View>
      {action && onAction && (
        <Tappable onPress={onAction} hitSlop={8} style={styles.sectionAction}>
          <ThemedText type="smallBold" themeColor="brand">
            {action}
          </ThemedText>
          <Ionicons name="chevron-forward" size={16} color={theme.brand} />
        </Tappable>
      )}
    </View>
  );
}

/** 分组小标题：灰色大写感的 13px 标签（我的页两组） */
export function GroupTitle({ title }: { title: string }) {
  return (
    <ThemedText
      type="smallBold"
      themeColor="textSecondary"
      style={styles.groupTitle}
    >
      {title}
    </ThemedText>
  );
}

/**
 * 列表行。两档：
 * - 默认（62px）：圆底图标 + 标题 + 副标题 + chevron，用于功能入口；
 * - compact（48px）：小图标 + 标题 + 右侧当前值，用于设置项（我的页）。
 */
export function ListRow({
  icon,
  title,
  subtitle,
  value,
  right,
  onPress,
  last = false,
  compact = false,
  destructive = false,
}: {
  icon: IconName;
  title: string;
  subtitle?: string;
  value?: string;
  right?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  compact?: boolean;
  destructive?: boolean;
}) {
  const theme = useTheme();
  const titleColor = destructive ? theme.danger : theme.text;
  const body = compact ? (
    <>
      <Ionicons
        name={icon}
        size={20}
        color={destructive ? theme.danger : theme.textSecondary}
      />
      <ThemedText
        type="small"
        numberOfLines={1}
        style={[styles.compactTitle, { color: titleColor }]}
      >
        {title}
      </ThemedText>
      {value && (
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {value}
        </ThemedText>
      )}
      {right}
      {onPress && (
        <Ionicons
          name="chevron-forward"
          size={16}
          color={theme.textSecondary}
        />
      )}
    </>
  ) : (
    <>
      <IconCircle icon={icon} color={destructive ? theme.danger : undefined} />
      <View style={styles.rowBody}>
        <ThemedText
          type="default"
          numberOfLines={1}
          style={{ color: titleColor, lineHeight: 22 }}
        >
          {title}
        </ThemedText>
        {subtitle && (
          <ThemedText
            type="small"
            themeColor="textSecondary"
            numberOfLines={1}
            style={{ fontSize: 13, lineHeight: 18 }}
          >
            {subtitle}
          </ThemedText>
        )}
      </View>
      {/* 右侧的值（版本号、脱敏手机号）：以前只有紧凑行显示，大行传了也不显示——「我的」分层后
          「账号与安全」的手机号、「关于」的版本号因此都不见了（2026-10-15 华为真机） */}
      {value && (
        <ThemedText
          type="small"
          themeColor="textSecondary"
          numberOfLines={1}
          style={styles.rowValue}
        >
          {value}
        </ThemedText>
      )}
      {right}
      {onPress && (
        <Ionicons
          name="chevron-forward"
          size={18}
          color={theme.textSecondary}
        />
      )}
    </>
  );
  const rowStyle = [
    compact ? styles.rowCompact : styles.row,
    !last && {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
  ];
  return onPress ? (
    <Tappable feedback="fill" onPress={onPress} style={rowStyle}>
      {body}
    </Tappable>
  ) : (
    <View style={rowStyle}>{body}</View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Radius.card, borderWidth: 1, overflow: "hidden" },
  sectionLabel: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  sectionLeft: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  sectionAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 44,
    paddingLeft: 8,
  },
  groupTitle: { fontSize: 13, letterSpacing: 0.3, paddingHorizontal: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 62,
  },
  rowCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingLeft: 16,
    paddingRight: 14,
    height: 48,
  },
  rowBody: { flex: 1, gap: 2, minWidth: 0 },
  rowValue: { flexShrink: 1, maxWidth: "45%" },
  compactTitle: { flex: 1, fontSize: 15 },
});
