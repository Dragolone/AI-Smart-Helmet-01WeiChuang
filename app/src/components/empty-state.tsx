// 空态统一样式：图标圆 + 标题 + 一句话 + 可选主动作。空态本身就是引导，不是一行灰字。
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";

import { PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { useTheme } from "@/hooks/use-theme";

export function EmptyState({
  icon,
  title,
  body,
  actionLabel,
  actionIcon,
  onAction,
  style,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body?: string;
  actionLabel?: string;
  actionIcon?: keyof typeof Ionicons.glyphMap;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <Animated.View
      entering={FadeInDown.duration(260)}
      style={[styles.wrap, style]}
    >
      <View
        style={[
          styles.iconCircle,
          { backgroundColor: theme.backgroundSelected },
        ]}
      >
        <Ionicons name={icon} size={30} color={theme.textSecondary} />
      </View>
      <ThemedText type="smallBold" style={styles.title}>
        {title}
      </ThemedText>
      {body ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.body}>
          {body}
        </ThemedText>
      ) : null}
      {actionLabel && onAction ? (
        <PrimaryButton
          compact
          title={actionLabel}
          icon={actionIcon}
          onPress={onAction}
          style={styles.action}
        />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    paddingVertical: 44,
    paddingHorizontal: 24,
    gap: 8,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  title: { fontSize: 17, lineHeight: 23, textAlign: "center" },
  body: { textAlign: "center", lineHeight: 20, maxWidth: 300 },
  action: { marginTop: 12, minWidth: 200 },
});
