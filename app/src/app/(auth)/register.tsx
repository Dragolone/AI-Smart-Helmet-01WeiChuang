// 注册页（API.md §2：POST /auth/sms-code 取验证码 → POST /auth/register 带 code）
import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
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
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useConsentStore } from "@/stores/consent-store";

/** 与后端 SMS_CODE_RESEND_INTERVAL_SECONDS 默认一致；超前点击由服务端 429 兜底 */
const RESEND_SECONDS = 60;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export default function RegisterScreen() {
  const theme = useTheme();
  const t = useT();
  const signIn = useAuthStore((s) => s.signIn);
  const acceptPrivacy = useConsentStore((s) => s.accept);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [nickname, setNickname] = useState("");
  // 合规：默认不勾，不勾不让提交（极光等第三方 SDK 也必须等这一步之后才初始化）
  const [consented, setConsented] = useState(false);
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
      await authApi.sendSmsCode({ phone: phone.trim(), purpose: "register" });
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
    if (!consented) {
      setError(t("auth.consentRequired"));
      return;
    }
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
      const auth = await authApi.register({
        phone: phone.trim(),
        code,
        password,
        ...(nickname.trim() && { nickname: nickname.trim() }),
      });
      // 勾选 + 提交成功 = 同意成立；先记同意再登录，登录态钩子里的推送 SDK 初始化才放行
      await acceptPrivacy();
      await signIn(auth); // 注册即登录（后端直接发 token）
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
    <SafeAreaView style={styles.flex}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ThemedView style={styles.container}>
          <ThemedText type="title">{t("auth.register")}</ThemedText>

          <FormInput
            label={t("auth.phone")}
            error={fe("phone")}
            icon="phone-portrait-outline"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            maxLength={11}
            placeholder={t("auth.phonePlaceholder")}
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
                  borderColor: codeButtonDisabled ? theme.border : theme.brand,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <ThemedText
                type="smallBold"
                style={{
                  color: codeButtonDisabled ? theme.textSecondary : theme.brand,
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
            label={t("auth.password")}
            error={fe("password")}
            icon="lock-closed-outline"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder={t("auth.passwordPlaceholder")}
          />
          <FormInput
            label={t("auth.confirmPassword")}
            error={fe("confirm")}
            icon="lock-closed-outline"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            placeholder={t("auth.confirmPlaceholder")}
          />
          <FormInput
            label={t("auth.nickname")}
            error={fe("nickname")}
            icon="person-outline"
            value={nickname}
            onChangeText={setNickname}
            maxLength={30}
            placeholder={t("auth.nicknamePlaceholder")}
          />

          {/* 同意勾选：默认不勾、不勾不让提交（商店合规高频扣分项）。
              书名号两处各自可点，跳 legal/[doc]（正文由后端托管，见 constants/legal.ts）。
              整行可点切换勾选；书名号是嵌套 Text 的 onPress，靠它先成为 touch responder
              来避免连带切换外层勾选——这条依赖 RN 的响应者链，双端真机各点一次确认（REGRESSION 1.1）。 */}
          <Pressable
            onPress={() => setConsented((v) => !v)}
            style={styles.consentRow}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: consented }}
            accessibilityLabel={`${t("auth.consentPrefix")}${t("auth.consentTerms")}${t("auth.consentAnd")}${t("auth.consentPrivacy")}`}
          >
            <Ionicons
              name={consented ? "checkbox" : "square-outline"}
              size={20}
              color={consented ? theme.brand : theme.textSecondary}
            />
            <ThemedText type="small" style={styles.consentText}>
              {t("auth.consentPrefix")}
              <ThemedText
                type="small"
                style={{ color: theme.brand }}
                onPress={() => router.push("/legal/terms")}
                suppressHighlighting
              >
                {t("auth.consentTerms")}
              </ThemedText>
              {t("auth.consentAnd")}
              <ThemedText
                type="small"
                style={{ color: theme.brand }}
                onPress={() => router.push("/legal/privacy")}
                suppressHighlighting
              >
                {t("auth.consentPrivacy")}
              </ThemedText>
            </ThemedText>
          </Pressable>

          <FormError message={error} />
          <PrimaryButton
            title={t("auth.registerAndLogin")}
            onPress={submit}
            loading={busy}
          />

          <Link href="/login" style={styles.link}>
            <ThemedText type="link">{t("auth.haveAccount")}</ThemedText>
          </Link>
        </ThemedView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  codeRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  consentRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  consentText: { flex: 1, lineHeight: 20 },
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
