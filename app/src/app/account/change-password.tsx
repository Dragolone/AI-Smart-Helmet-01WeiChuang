// 修改密码（已登录）：POST /auth/change-password 带本机 refreshToken，服务端撤销其他会话、本机保持登录。
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { authApi } from "@/api/auth";
import { isSessionEnded, toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { showToast } from "@/components/toast";
import { useT } from "@/i18n";
import {
  isPasswordTooLong,
  isPasswordTooShort,
} from "@/services/password-rules";

export default function ChangePasswordScreen() {
  const t = useT();
  const [oldPassword, setOldPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 改好了：按钮先画勾，画完再提示并返回
  const [done, setDone] = useState(false);

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
    // 按码点数、与服务端同口径（表情 / 生僻字原来各算两个）
    if (isPasswordTooShort(password)) {
      setError(t("auth.passwordTooShort"));
      return;
    }
    // 按字节算、与服务端同口径：原来按字符数，30 个汉字（90 字节）在这里过了、提交后被服务端拒
    if (isPasswordTooLong(password)) {
      setError(t("auth.passwordTooLong"));
      return;
    }
    // 新旧相同：服务端照样「改」成功并踢掉其他设备上的登录，用户什么也没得到（10-16 夜测 N25）
    if (password === oldPassword) {
      setError(t("auth.passwordSameAsOld"));
      return;
    }
    setBusy(true);
    try {
      // 本机的 refreshToken 由 authApi 在发请求时现取（401 重试时要带轮换后的那把）
      await authApi.changePassword({ oldPassword, newPassword: password });
      setDone(true);
    } catch (e) {
      // 会话已失效：正被送回登录页，登录页自有说明
      if (isSessionEnded(e)) return;
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThemedView style={styles.flex}>
      <KeyboardAvoid>
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
            success={done}
            onSuccessShown={() => {
              showToast(t("auth.changePasswordDone"));
              router.back();
            }}
          />
        </View>
      </KeyboardAvoid>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 12 },
  lead: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  bottom: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 22 },
});
