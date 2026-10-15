// Auth/绑定表单的共用控件（2026-08-16 风格迭代；2026-09-10 重设计：按压反馈统一，新增描边次按钮）：
// 药丸主按钮（品牌荧光色 + 深色文字）、描边次按钮、深色描边输入框（可带前置图标）、危险操作红药丸
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { CHECK_DRAW_MS, CheckDraw } from "@/components/check-draw";
import { DotsLoader } from "@/components/motion";
import { ThemedText } from "@/components/themed-text";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

export function FormInput(
  props: TextInputProps & {
    label: string;
    icon?: keyof typeof Ionicons.glyphMap;
    /** 就地错误：边框变红 + 下方红字 + 抖一下；由页面按错误码映射到具体字段 */
    error?: string | null;
  },
) {
  const { label, icon, style, error, secureTextEntry, ...rest } = props;
  const theme = useTheme();
  const t = useT();
  const [focused, setFocused] = useState(false);
  // 密码框的「显示 / 隐藏」：iOS 的密文输入框重新聚焦后第一次按键会清空整段内容（系统行为，改不了），
  // 输错一位就得整段重输。给个眼睛，显示成明文后就是普通输入框，可以把光标移到中间改
  //（2026-10-06 iPhone 实测负责人反馈）。默认隐藏。
  const [revealed, setRevealed] = useState(false);
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
          secureTextEntry={secureTextEntry ? !revealed : undefined}
          {...rest}
        />
        {secureTextEntry && (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t(
              revealed ? "common.hidePassword" : "common.showPassword",
            )}
          >
            <Ionicons
              name={revealed ? "eye-outline" : "eye-off-outline"}
              size={20}
              color={theme.textSecondary}
            />
          </Pressable>
        )}
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
  /** 图标不在 Ionicons 里时自己画（给了它就不看 icon）；尺寸和颜色由按钮决定 */
  renderIcon?: (props: { size: number; color: string }) => ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 紧凑档：46px 高、15px 字，用于卡片内并排的两个动作 */
  compact?: boolean;
};

/** 成功态：文字从什么时候开始滑进来（毫秒，从 success 变 true 算起） */
const SUCCESS_TEXT_AT = 480;
/** 成功态画完（勾画完、文字到位）要多久；到时候才调 onSuccessShown */
const SUCCESS_SHOWN_MS = CHECK_DRAW_MS + 160;
/** 短药丸两端留白 */
const SUCCESS_PAD = 22;

/** 主按钮：品牌黄药丸。按压 = 变淡 + 轻缩 + 触觉（主操作都该有"按到了"的确认） */
export function PrimaryButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  danger = false,
  icon,
  renderIcon,
  style,
  compact = false,
  success = false,
  successTitle,
  onSuccessShown,
}: ButtonProps & {
  danger?: boolean;
  /**
   * 成功态（负责人 2026-10-15 定「收成短药丸」）：整条药丸收到刚好包住「✓ 已保存」的宽度、底色变成功绿、
   * 勾一笔画出、文字滑入、轻弹一下。变成 true 后按钮不再可点；画完（约 1 秒）调 onSuccessShown，
   * 页面在那时再返回 / 关弹层。只给撑满一行的保存类按钮用，并排的小按钮不用。
   */
  success?: boolean;
  /** 成功态上的字；默认「已保存」 */
  successTitle?: string;
  onSuccessShown?: () => void;
}) {
  const theme = useTheme();
  const t = useT();
  const reduced = useReducedMotion();
  const bg = danger ? theme.danger : theme.brand;
  const fg = danger ? "#FFFFFF" : theme.onBrand;
  const inactive = loading || disabled || success;
  // 按下 0.965 快缩，松手低阻尼回弹带一点过冲（与 Tappable 手感一致）
  const scale = useSharedValue(1);
  // 成功态的三个量：整体进度（底色、原内容淡出、新内容淡入）、宽度（整条 → 短药丸）、文字滑入
  const p = useSharedValue(0);
  const width = useSharedValue(0);
  const textIn = useSharedValue(0);
  // 整条时多宽、短药丸该多宽：都从布局量，不写死
  const fullWidth = useRef(0);
  const doneWidth = useRef(0);
  // 回调存在 ref 里：页面每次渲染都是新的箭头函数，不能让它触发下面那个 effect 重跑（会重放动画和触觉）
  const shown = useRef(onSuccessShown);
  useEffect(() => {
    shown.current = onSuccessShown;
  }, [onSuccessShown]);
  useEffect(() => {
    if (!success) {
      p.set(0);
      textIn.set(0);
      width.set(0);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {},
    );
    const target =
      fullWidth.current > 0 && doneWidth.current > 0
        ? Math.min(fullWidth.current, doneWidth.current)
        : 0;
    if (reduced) {
      p.set(1);
      textIn.set(1);
      if (target > 0) width.set(target);
    } else {
      const ease = Easing.bezier(0.3, 0.9, 0.25, 1);
      p.set(withTiming(1, { duration: 280, easing: ease }));
      if (target > 0) {
        width.set(fullWidth.current);
        width.set(withTiming(target, { duration: 320, easing: ease }));
      }
      textIn.set(
        withDelay(
          SUCCESS_TEXT_AT,
          withTiming(1, { duration: 240, easing: ease }),
        ),
      );
    }
    const timer = setTimeout(
      () => shown.current?.(),
      reduced ? 200 : SUCCESS_SHOWN_MS,
    );
    return () => clearTimeout(timer);
  }, [success, reduced, p, width, textIn]);

  const boxStyle = useAnimatedStyle(() => {
    const w = width.get();
    return {
      transform: [{ scale: scale.get() }],
      backgroundColor: interpolateColor(p.get(), [0, 1], [bg, theme.success]),
      ...(w > 0 ? { width: w } : {}),
    };
  });
  const idleStyle = useAnimatedStyle(() => ({ opacity: 1 - p.get() }));
  const doneStyle = useAnimatedStyle(() => ({ opacity: p.get() }));
  const doneTextStyle = useAnimatedStyle(() => ({
    opacity: textIn.get(),
    transform: [{ translateX: -6 * (1 - textIn.get()) }],
  }));
  const doneLabel = successTitle ?? t("common.saved");
  return (
    <AnimatedPressable
      onLayout={(e) => {
        // 量的是整条时的宽；收缩过程中的布局不算
        if (!success) fullWidth.current = e.nativeEvent.layout.width;
      }}
      style={[
        styles.button,
        compact && styles.buttonCompact,
        { opacity: inactive && !success ? 0.55 : 1 },
        success && styles.buttonDone,
        style,
        boxStyle,
      ]}
      disabled={inactive}
      accessibilityLabel={success ? doneLabel : undefined}
      accessibilityState={{ disabled: inactive, busy: loading }}
      onPressIn={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        scale.set(withSpring(0.965, { damping: 20, stiffness: 420 }));
      }}
      onPressOut={() =>
        scale.set(withSpring(1, { damping: 9, stiffness: 240 }))
      }
      onPress={onPress}
    >
      {/* 平时的内容留在正常排版里：按内容收缩的按钮（空态、行内）靠它定宽 */}
      <Animated.View style={[styles.idle, idleStyle]}>
        {loading ? (
          <DotsLoader color={fg} />
        ) : (
          <>
            {renderIcon
              ? renderIcon({ size: compact ? 17 : 18, color: fg })
              : icon && (
                  <Ionicons name={icon} size={compact ? 17 : 18} color={fg} />
                )}
            <ThemedText
              type="smallBold"
              style={[
                styles.buttonText,
                { color: fg, fontSize: compact ? 15 : 16 },
              ]}
            >
              {title}
            </ThemedText>
          </>
        )}
      </Animated.View>
      {/* 成功态那一层盖在上面：平时透明但照常排版，这样一开始就量得到短药丸该多宽 */}
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden={!success}
        importantForAccessibility={success ? "auto" : "no-hide-descendants"}
        style={[styles.layer, doneStyle]}
      >
        <View
          style={styles.doneRow}
          onLayout={(e) => {
            doneWidth.current = e.nativeEvent.layout.width + SUCCESS_PAD * 2;
          }}
        >
          <CheckDraw
            size={compact ? 22 : 24}
            color={theme.onBrand}
            play={success}
          />
          <Animated.View style={doneTextStyle}>
            <ThemedText
              type="smallBold"
              style={{ color: theme.onBrand, fontSize: compact ? 15 : 16 }}
            >
              {doneLabel}
            </ThemedText>
          </Animated.View>
        </View>
      </Animated.View>
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
  renderIcon,
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
          {renderIcon
            ? renderIcon({ size: compact ? 17 : 18, color: theme.text })
            : icon && (
                <Ionicons
                  name={icon}
                  size={compact ? 17 : 18}
                  color={theme.text}
                />
              )}
          <ThemedText
            type="smallBold"
            style={[
              styles.buttonText,
              { color: theme.text, fontSize: compact ? 15 : 16 },
            ]}
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
    // 最小高度而不是定高：系统字体放大、字折成两行时按钮跟着长高，定高时第二行被切掉
    //（2026-10-15 边界测试：2 倍字体地图页「导航到最后位置」只剩半行）。1 倍字体下高度不变
    minHeight: 52,
    paddingVertical: 6,
    alignItems: "center",
    justifyContent: "center",
    // 撑满宽度时无感；按内容收缩（空态里的按钮、行内按钮）时文字不能顶着药丸两端（2026-09-26 iPhone 实测）
    paddingHorizontal: 20,
  },
  buttonCompact: { minHeight: 46 },
  buttonText: { flexShrink: 1, textAlign: "center" },
  // 成功态：从中间往里收，收缩中多出来的旧内容裁掉
  buttonDone: { alignSelf: "center", overflow: "hidden" },
  idle: {
    // 能收窄：字放大时文字在药丸里折行，而不是把整行撑出按钮
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  layer: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  doneRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  secondary: { borderWidth: 1 },
});
