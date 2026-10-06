// 找回密码页（API.md §2：sms-code purpose=reset_password → POST /auth/reset-password）
// 成功后服务端撤销该用户全部会话,所有设备需重新登录——页面提示后回登录页。
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { authApi } from "@/api/auth";
import { toUserMessage } from "@/api/error-messages";
import {
  FormError,
  FormInput,
  PrimaryButton,
  errorField,
  type FormField,
} from "@/components/form";
import { showToast } from "@/components/toast";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

/** 与后端 SMS_CODE_RESEND_INTERVAL_SECONDS 默认一致；超前点击由服务端 429 兜底 */
const RESEND_SECONDS = 60;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export default function ResetPasswordScreen() {
  const theme = useTheme();
  const t = useT();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 能落到具体字段的错误就地显示（红框 + 抖动），落不到的走页面级 FormError */
  const [fieldError, setFieldError] = useState<{
    field: FormField;
    message: string;
  } | null>(null);
  const fe = (f: FormField) =>
    fieldError?.field === f ? fieldError.message : null;
  const fail = (field: FormField, message: string) =>
    setFieldError({ field, message });
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  /** 重发限频用截止时间戳 + 墙钟计算剩余——递减 state 在 App 退后台时定时器
   *  被 iOS 暂停,回前台倒计时冻在原地(2026-09-10 真机实证);按墙钟算则
   *  回前台首个 tick 即校准。同 sos-active 倒计时的口径。 */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  useEffect(() => {
    if (cooldownUntil <= now) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [cooldownUntil, now]);

  const sendCode = async () => {
    setError(null);
    setFieldError(null);
    if (!PHONE_PATTERN.test(phone.trim())) {
      fail("phone", t("auth.invalidPhone"));
      return;
    }
    setSending(true);
    try {
      await authApi.sendSmsCode({
        phone: phone.trim(),
        purpose: "reset_password",
      });
      const t = Date.now();
      setNow(t);
      setCooldownUntil(t + RESEND_SECONDS * 1000);
    } catch (e) {
      const field = errorField(e);
      if (field) fail(field, toUserMessage(e));
      else setError(toUserMessage(e));
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    setError(null);
    setFieldError(null);
    if (!/^\d{6}$/.test(code)) {
      fail("code", t("auth.invalidCode"));
      return;
    }
    if (password !== confirm) {
      fail("confirm", t("auth.passwordMismatch"));
      return;
    }
    if (password.length < 8) {
      fail("password", t("auth.passwordTooShort"));
      return;
    }
    setBusy(true);
    try {
      await authApi.resetPassword({
        phone: phone.trim(),
        code,
        newPassword: password,
      });
      // 成功即全端会话作废(API.md §2),回登录页用新密码登录
      showToast(t("auth.resetDone"));
      router.back();
    } catch (e) {
      const field = errorField(e);
      if (field) fail(field, toUserMessage(e));
      else setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const codeButtonDisabled = sending || cooldown > 0;

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* 可滚动 + 点空白 / 拖动收键盘：原来是一个定高的居中容器，键盘弹出后既收不回去，
            也够不到被挡住的按钮和底部链接（2026-10-06 iPhone 实测：注册页想回登录页回不去） */}
        <ThemedView style={styles.flex}>
          <ScrollView
            contentContainerStyle={styles.container}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            // 内容放得下时页面不该能拖动（iOS 默认会回弹，Android 默认有越界光晕）；
            // 只有键盘把内容挤出屏幕时才滚得动
            bounces={false}
            alwaysBounceVertical={false}
            overScrollMode="never"
          >
            <ThemedText type="title">{t("auth.resetTitle")}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {t("auth.resetLead")}
            </ThemedText>

            <FormInput
              label={t("auth.phone")}
              error={fe("phone")}
              icon="phone-portrait-outline"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              maxLength={11}
              placeholder={t("auth.phonePlaceholder")}
              autoComplete="tel"
            />
            <View style={styles.codeRow}>
              <View style={styles.flex}>
                <FormInput
                  label={t("auth.smsCode")}
                  error={fe("code")}
                  icon="chatbox-ellipses-outline"
                  value={code}
                  onChangeText={setCode}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder={t("auth.smsCodePlaceholder")}
                />
              </View>
              <Pressable
                disabled={codeButtonDisabled}
                onPress={sendCode}
                style={({ pressed }) => [
                  styles.codeButton,
                  {
                    borderColor: codeButtonDisabled
                      ? theme.border
                      : theme.brand,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <ThemedText
                  type="smallBold"
                  style={{
                    color: codeButtonDisabled
                      ? theme.textSecondary
                      : theme.brand,
                  }}
                >
                  {sending
                    ? t("auth.sending")
                    : cooldown > 0
                      ? t("auth.resend", { n: cooldown })
                      : t("auth.getCode")}
                </ThemedText>
              </Pressable>
            </View>
            <FormInput
              label={t("auth.newPassword")}
              error={fe("password")}
              icon="lock-closed-outline"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder={t("auth.passwordPlaceholder")}
            />
            <FormInput
              label={t("auth.confirmNewPassword")}
              error={fe("confirm")}
              icon="lock-closed-outline"
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              placeholder={t("auth.confirmPlaceholder")}
            />

            <FormError message={error} />
            <PrimaryButton
              title={t("auth.resetPassword")}
              onPress={submit}
              loading={busy}
            />

            <Pressable
              style={styles.link}
              onPress={() => {
                Keyboard.dismiss();
                router.back();
              }}
            >
              <ThemedText type="link">{t("auth.backToLogin")}</ThemedText>
            </Pressable>
          </ScrollView>
        </ThemedView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  codeRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  codeButton: {
    borderWidth: 1,
    borderRadius: Radius.control,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minWidth: 112,
    alignItems: "center",
  },
  link: { alignSelf: "center", marginTop: 8 },
});
