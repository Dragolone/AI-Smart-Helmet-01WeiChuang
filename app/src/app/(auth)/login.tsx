// 登录页（API.md §2 POST /auth/login）
import { Link, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
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
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";

export default function LoginScreen() {
  const t = useT();
  const router = useRouter();
  const signIn = useAuthStore((s) => s.signIn);
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
    setBusy(true);
    try {
      const auth = await authApi.login({ phone: phone.trim(), password });
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
    <SafeAreaView style={styles.flex}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ThemedView style={styles.container}>
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

          <FormError message={error} />
          <PrimaryButton
            title={t("auth.login")}
            onPress={submit}
            loading={busy}
          />

          <View style={styles.linkRow}>
            <Link href="/register">
              <ThemedText type="link">{t("auth.noAccount")}</ThemedText>
            </Link>
            <Link href="/reset-password">
              <ThemedText type="link" themeColor="textSecondary">
                {t("auth.forgotPassword")}
              </ThemedText>
            </Link>
          </View>
        </ThemedView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, justifyContent: "center", padding: 24, gap: 14 },
  brand: { alignSelf: "flex-start" },
  linkRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
    paddingHorizontal: 4,
  },
});
