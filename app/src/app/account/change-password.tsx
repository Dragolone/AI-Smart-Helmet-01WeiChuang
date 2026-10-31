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
import { useEnterChain } from "@/hooks/use-enter-chain";
import { useFormErrors } from "@/hooks/use-form-errors";
import { useT } from "@/i18n";
import {
  isPasswordTooLong,
  isPasswordTooShort,
} from "@/services/password-rules";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

export default function ChangePasswordScreen() {
  const t = useT();
  const [oldPassword, setOldPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  // 改好了：按钮先画勾，画完再提示并返回
  const [done, setDone] = useState(false);

  const form = useFormErrors([oldPassword, password, confirm], () => {
    if (oldPassword.length < 8)
      return { key: "oldShort", message: t("auth.passwordTooShort") };
    if (password !== confirm)
      return { key: "mismatch", message: t("auth.passwordMismatch") };
    // 按码点数、与服务端同口径（表情 / 生僻字原来各算两个）
    if (isPasswordTooShort(password))
      return { key: "newShort", message: t("auth.passwordTooShort") };
    // 按字节算、与服务端同口径：原来按字符数，30 个汉字（90 字节）在这里过了、提交后被服务端拒
    if (isPasswordTooLong(password))
      return { key: "newLong", message: t("auth.passwordTooLong") };
    // 新旧相同：服务端照样「改」成功并踢掉其他设备上的登录，用户什么也没得到（10-16 夜测 N25）
    if (password === oldPassword)
      return { key: "same", message: t("auth.passwordSameAsOld") };
    return null;
  });

  const submit = async () => {
    // 回车键也能走到这里，按钮的加载 / 成功态拦不住它
    if (busy || done) return;
    if (!form.check()) return;
    setBusy(true);
    try {
      // 本机的 refreshToken 由 authApi 在发请求时现取（401 重试时要带轮换后的那把）
      await authApi.changePassword({ oldPassword, newPassword: password });
      setDone(true);
    } catch (e) {
      // 会话已失效：正被送回登录页，登录页自有说明
      if (isSessionEnded(e)) return;
      form.fail(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const enter = useEnterChain(3, () => void submit(), "done");

  return (
    <ThemedView style={styles.flex}>
      <KeyboardAvoid>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.lead}
          >
            {t("auth.changePasswordLead")}
          </ThemedText>
          <FormInput
            {...enter.field(0)}
            label={t("auth.currentPassword")}
            icon="lock-closed-outline"
            value={oldPassword}
            onChangeText={setOldPassword}
            secureTextEntry
            autoComplete="current-password"
            placeholder={t("auth.currentPasswordPlaceholder")}
          />
          <FormInput
            {...enter.field(1)}
            label={t("auth.newPassword")}
            icon="key-outline"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="new-password"
            placeholder={t("auth.passwordPlaceholder")}
          />
          <FormInput
            {...enter.field(2)}
            label={t("auth.confirmNewPassword")}
            icon="key-outline"
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoComplete="new-password"
            placeholder={t("auth.confirmPlaceholder")}
          />
        </ScrollView>
        {/* 错误放在固定的按钮区而不是滚动内容底部：键盘开着点保存时，红字在滚动内容最底下，被键盘和按钮挡住看不见 */}
        <View style={styles.bottom}>
          <FormError message={form.pageError} />
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
  bottom: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 22, gap: 10 },
});
