// Auth/绑定表单的共用控件（2026-08-16 风格迭代；2026-09-10 重设计：按压反馈统一，新增描边次按钮）：
// 药丸主按钮（品牌荧光色 + 深色文字）、描边次按钮、深色描边输入框（可带前置图标）、危险操作红药丸
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { DotsLoader } from "@/components/motion";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";

export function FormInput(
  props: TextInputProps & {
    label: string;
    icon?: keyof typeof Ionicons.glyphMap;
    /** 就地错误：边框变红 + 下方红字 + 抖一下；由页面按错误码映射到具体字段 */
    error?: string | null;
  },
) {
  const { label, icon, style, error, ...rest } = props;
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  // 聚焦：边框从描边色渐变到品牌色 + 外发光轻起（180 ms），失焦反向；不再硬切
  const focus = useSharedValue(0);
  useEffect(() => {
    focus.set(withTiming(focused ? 1 : 0, { duration: 180 }));
  }, [focused, focus]);
  const shake = useSharedValue(0);
  useEffect(() => {
    if (!error) return;
    shake.set(
      withSequence(
        withTiming(-6, { duration: 40 }),
        withTiming(6, { duration: 60 }),
        withTiming(-4, { duration: 60 }),
        withTiming(3, { duration: 50 }),
        withTiming(0, { duration: 50 }),
      ),
    );
  }, [error, shake]);
  const wrapStyle = useAnimatedStyle(() => ({
    borderColor: error
      ? theme.danger
      : interpolateColor(focus.get(), [0, 1], [theme.border, theme.brand]),
    shadowOpacity: error ? 0 : focus.get() * 0.35,
    transform: [{ translateX: shake.get() }],
  }));
  return (
    <>
      <ThemedText type="label" themeColor={focused ? "brand" : "textSecondary"}>
        {label}
      </ThemedText>
      <Animated.View
        style={[
          styles.inputWrap,
          {
            backgroundColor: theme.backgroundElement,
            shadowColor: theme.brand,
          },
          wrapStyle,
        ]}
      >
        {icon && <Ionicons name={icon} size={18} color={theme.textSecondary} />}
        <TextInput
          placeholderTextColor={theme.textSecondary}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[styles.input, { color: theme.text }, style]}
          {...rest}
        />
      </Animated.View>
      {error ? (
        <ThemedText
          type="small"
          style={[styles.fieldError, { color: theme.danger }]}
        >
          {error}
        </ThemedText>
      ) : null}
    </>
  );
}

type ButtonProps = {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>;
  /** 紧凑档：46px 高、15px 字，用于卡片内并排的两个动作 */
  compact?: boolean;
};

/** 主按钮：品牌黄药丸。按压 = 变淡 + 轻缩 + 触觉（主操作都该有"按到了"的确认） */
export function PrimaryButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  danger = false,
  icon,
  style,
  compact = false,
}: ButtonProps & { danger?: boolean }) {
  const theme = useTheme();
  const bg = danger ? theme.danger : theme.brand;
  const fg = danger ? "#FFFFFF" : theme.onBrand;
  const inactive = loading || disabled;
  // 按下 0.965 快缩，松手低阻尼回弹带一点过冲（与 Tappable 手感一致）
  const scale = useSharedValue(1);
  const springStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  return (
    <AnimatedPressable
      style={[
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: bg, opacity: inactive ? 0.55 : 1 },
        style,
        springStyle,
      ]}
      disabled={inactive}
      onPressIn={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        scale.set(withSpring(0.965, { damping: 20, stiffness: 420 }));
      }}
      onPressOut={() =>
        scale.set(withSpring(1, { damping: 9, stiffness: 240 }))
      }
      onPress={onPress}
    >
      {loading ? (
        <DotsLoader color={fg} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={compact ? 17 : 18} color={fg} />}
          <ThemedText
            type="smallBold"
            style={{ color: fg, fontSize: compact ? 15 : 16 }}
          >
            {title}
          </ThemedText>
        </>
      )}
    </AnimatedPressable>
  );
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** 按错误码把服务端/本地校验错误落到具体字段；映射不到的走页面级 FormError */
export type FormField = "phone" | "password" | "code" | "confirm" | "nickname";
export function errorField(err: unknown): FormField | null {
  const code = String((err as { code?: string })?.code ?? "").toUpperCase();
  if (!code) return null;
  if (code.includes("SMS_CODE") || code.includes("VERIFY_CODE")) return "code";
  if (code.includes("PASSWORD") || code.includes("CREDENTIAL"))
    return "password";
  if (
    code.includes("PHONE") ||
    code.includes("USER_NOT_FOUND") ||
    code.includes("USER_EXISTS")
  )
    return "phone";
  if (code.includes("NICKNAME")) return "nickname";
  return null;
}

/** 次按钮：描边药丸，白字。用于同屏第二动作（绑定新设备、历史轨迹、邀请码加入） */
export function SecondaryButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  icon,
  style,
  compact = false,
}: ButtonProps) {
  const theme = useTheme();
  const inactive = loading || disabled;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        styles.secondary,
        {
          borderColor: theme.borderStrong,
          backgroundColor: pressed ? theme.backgroundSelected : "transparent",
          opacity: inactive ? 0.55 : 1,
        },
        pressed && !inactive && { transform: [{ scale: 0.97 }] },
        style,
      ]}
      disabled={inactive}
      onPress={onPress}
    >
      {loading ? (
        <DotsLoader color={theme.text} />
      ) : (
        <>
          {icon && (
            <Ionicons name={icon} size={compact ? 17 : 18} color={theme.text} />
          )}
          <ThemedText
            type="smallBold"
            style={{ color: theme.text, fontSize: compact ? 15 : 16 }}
          >
            {title}
          </ThemedText>
        </>
      )}
    </Pressable>
  );
}

export function FormError({ message }: { message: string | null }) {
  const theme = useTheme();
  if (!message) return null;
  return (
    <ThemedText type="small" style={{ color: theme.danger }}>
      {message}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  fieldError: { marginTop: -6 },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 16,
  },
  button: {
    flexDirection: "row",
    gap: 8,
    borderRadius: Radius.pill,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonCompact: { height: 46 },
  secondary: { borderWidth: 1 },
});
