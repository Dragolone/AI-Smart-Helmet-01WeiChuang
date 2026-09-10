// 修改密码（已登录）：POST /auth/change-password 带本机 refreshToken，服务端撤销其他会话、本机保持登录。
import { router } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import { authApi } from "@/api/auth";
import { toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { showToast } from "@/components/toast";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";

export default function ChangePasswordScreen() {
  const t = useT();
  const tokens = useAuthStore((s) => s.tokens);
  const [oldPassword, setOldPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (oldPassword.length < 8) {
      setError(t("auth.passwordTooShort"));
      return;
    }
    if (password !== confirm) {
      setError(t("auth.passwordMismatch"));
      return;
    }
    if (password.length < 8) {
      setError(t("auth.passwordTooShort"));
      return;
    }
    if (password.length > 72) {
      setError(t("auth.passwordTooLong"));
      return;
    }
    setBusy(true);
    try {
      await authApi.changePassword({
        oldPassword,
        newPassword: password,
        refreshToken: tokens?.refreshToken ?? "",
      });
      showToast(t("auth.changePasswordDone"));
      router.back();
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThemedView style={styles.flex}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.lead}
          >
            {t("auth.changePasswordLead")}
          </ThemedText>
          <FormInput
            label={t("auth.currentPassword")}
            icon="lock-closed-outline"
            value={oldPassword}
            onChangeText={setOldPassword}
            secureTextEntry
            autoComplete="current-password"
            placeholder={t("auth.currentPasswordPlaceholder")}
          />
          <FormInput
            label={t("auth.newPassword")}
            icon="key-outline"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="new-password"
            placeholder={t("auth.passwordPlaceholder")}
          />
          <FormInput
            label={t("auth.confirmNewPassword")}
            icon="key-outline"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoComplete="new-password"
            placeholder={t("auth.confirmPlaceholder")}
          />
          <FormError message={error} />
        </ScrollView>
        <View style={styles.bottom}>
          <PrimaryButton
            title={t("common.save")}
            onPress={() => void submit()}
            loading={busy}
          />
        </View>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 12 },
  lead: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  bottom: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 22 },
});
