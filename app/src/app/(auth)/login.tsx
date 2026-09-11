// 登录页（API.md §2 POST /auth/login）
import { Link } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { authApi } from "@/api/auth";
import { toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";

export default function LoginScreen() {
  const t = useT();
  const signIn = useAuthStore((s) => s.signIn);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    setBusy(true);
    try {
      const auth = await authApi.login({ phone: phone.trim(), password });
      SecureStore.setItemAsync("last_login_phone", phone.trim()).catch(
        () => {},
      );
      await signIn(auth); // AuthGate 检测到会话后自动跳转主页
    } catch (e) {
      setError(toUserMessage(e));
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
          <ThemedText type="title">{t("auth.appName")}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {t("auth.slogan")}
          </ThemedText>

          <FormInput
            label={t("auth.phone")}
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
  linkRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
    paddingHorizontal: 4,
  },
});
