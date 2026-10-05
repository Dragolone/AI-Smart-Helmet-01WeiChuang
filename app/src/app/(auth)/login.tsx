// 登录页（API.md §2 POST /auth/login）
import { Link, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
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
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useConsentStore } from "@/stores/consent-store";

export default function LoginScreen() {
  const t = useT();
  const theme = useTheme();
  const router = useRouter();
  const signIn = useAuthStore((s) => s.signIn);
  // 这台设备上还没同意过隐私政策（老用户换机 / 注册在别的手机上）→ 登录页补一次勾选，
  // 之后不再问。极光 SDK 只在同意之后初始化（services/push.ts）。
  const privacyAccepted = useConsentStore((s) => s.privacyAccepted);
  const consentHydrated = useConsentStore((s) => s.hydrated);
  const acceptPrivacy = useConsentStore((s) => s.accept);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  // 标记还没从 SecureStore 读出来时也按「需要」处理：宁可多勾一次，不能让冷启动秒点登录绕过同意
  // （评审 2026-09-26）——读出来通常只要几十毫秒，勾选框最多闪一下
  const needConsent = !consentHydrated || !privacyAccepted;
  const [consented, setConsented] = useState(false);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 能落到具体字段的错误就地显示（红框 + 抖动），落不到的走页面级 FormError */
  const [fieldError, setFieldError] = useState<{
    field: FormField;
    message: string;
  } | null>(null);
  const fe = (f: FormField) =>
    fieldError?.field === f ? fieldError.message : null;
  const [busy, setBusy] = useState(false);

  // 记住上次登录的手机号(只存号码不存密码);读取失败静默忽略
  useEffect(() => {
    SecureStore.getItemAsync("last_login_phone")
      .then((v) => {
        if (v) setPhone((cur) => cur || v);
      })
      .catch(() => {});
  }, []);

  const submit = async () => {
    setError(null);
    setFieldError(null);
    if (needConsent && !consented) {
      setError(t("auth.consentRequired"));
      return;
    }
    setBusy(true);
    try {
      const auth = await authApi.login({ phone: phone.trim(), password });
      if (needConsent) await acceptPrivacy();
      SecureStore.setItemAsync("last_login_phone", phone.trim()).catch(
        () => {},
      );
      await signIn(auth); // AuthGate 检测到会话后自动跳转主页
    } catch (e) {
      const field = errorField(e);
      if (field) setFieldError({ field, message: toUserMessage(e) });
      else setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

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
            {/* 隐藏入口：长按 App 名 3 秒进蓝牙工程模式（硬件联调，不需要账号）；正式上线可删 */}
            <Pressable
              delayLongPress={3000}
              onLongPress={() => router.push("/ble-bench")}
              style={styles.brand}
            >
              <ThemedText type="title">{t("auth.appName")}</ThemedText>
            </Pressable>
            <ThemedText type="small" themeColor="textSecondary">
              {t("auth.slogan")}
            </ThemedText>

            {/* 被动登出要说清楚后果：头盔事件靠这台手机中转，没登录就没有摔倒通知（2026-10-05 评审） */}
            {sessionExpired && (
              <View
                accessibilityRole="alert"
                style={[styles.expiredNotice, { borderColor: theme.danger }]}
              >
                <Ionicons
                  name="warning-outline"
                  size={18}
                  color={theme.danger}
                />
                <ThemedText type="small" style={styles.consentText}>
                  {t("auth.sessionExpiredNotice")}
                </ThemedText>
              </View>
            )}

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
            <FormInput
              label={t("auth.password")}
              error={fe("password")}
              icon="lock-closed-outline"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder={t("auth.passwordPlaceholderLogin")}
              autoComplete="password"
            />

            {needConsent && (
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
                    onPress={() => {
                      Keyboard.dismiss();
                      router.push("/legal/terms");
                    }}
                    suppressHighlighting
                  >
                    {t("auth.consentTerms")}
                  </ThemedText>
                  {t("auth.consentAnd")}
                  <ThemedText
                    type="small"
                    style={{ color: theme.brand }}
                    onPress={() => {
                      Keyboard.dismiss();
                      router.push("/legal/privacy");
                    }}
                    suppressHighlighting
                  >
                    {t("auth.consentPrivacy")}
                  </ThemedText>
                </ThemedText>
              </Pressable>
            )}

            <FormError message={error} />
            <PrimaryButton
              title={t("auth.login")}
              onPress={submit}
              loading={busy}
            />

            <View style={styles.linkRow}>
              {/* 跳走之前先收键盘：输入框还聚焦着就离开的话，回来时 iOS 会把焦点和键盘一起恢复，
                  返回手势途中键盘那块区域也是空的（2026-10-06 iPhone 实测） */}
              <Link href="/register" onPress={() => Keyboard.dismiss()}>
                <ThemedText type="link">{t("auth.noAccount")}</ThemedText>
              </Link>
              <Link href="/reset-password" onPress={() => Keyboard.dismiss()}>
                <ThemedText type="link" themeColor="textSecondary">
                  {t("auth.forgotPassword")}
                </ThemedText>
              </Link>
            </View>
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
    gap: 14,
  },
  brand: { alignSelf: "flex-start" },
  consentRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  expiredNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  consentText: { flex: 1, lineHeight: 20 },
  linkRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
    paddingHorizontal: 4,
  },
});
