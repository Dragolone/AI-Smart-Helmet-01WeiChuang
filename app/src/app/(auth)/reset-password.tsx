// 找回密码页（API.md §2：sms-code purpose=reset_password → POST /auth/reset-password）
// 成功后服务端撤销该用户全部会话,所有设备需重新登录——页面提示后回登录页。
import { router } from "expo-router";
import { useState } from "react";
import {
  Keyboard,
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
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { showToast } from "@/components/toast";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import {
  PHONE_INPUT_MAX,
  isValidPhone,
  normalizePhone,
  normalizeSmsCode,
  useSmsCode,
} from "@/hooks/use-sms-code";
import {
  isPasswordTooLong,
  isPasswordTooShort,
} from "@/services/password-rules";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

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
  // 重置成功：按钮先画勾（「已重置」），画完再提示并回登录页
  const [done, setDone] = useState(false);
  const sms = useSmsCode("reset_password", phone);

  const sendCode = async () => {
    setError(null);
    setFieldError(null);
    const cleanPhone = normalizePhone(phone);
    if (!isValidPhone(cleanPhone)) {
      fail("phone", t("auth.invalidPhone"));
      return;
    }
    try {
      await sms.send(cleanPhone);
    } catch (e) {
      const field = errorField(e);
      if (field) fail(field, toUserMessage(e));
      else setError(toUserMessage(e));
    }
  };

  const submit = async () => {
    setError(null);
    setFieldError(null);
    const cleanCode = normalizeSmsCode(code);
    if (!/^\d{6}$/.test(cleanCode)) {
      fail("code", t("auth.invalidCode"));
      return;
    }
    if (password !== confirm) {
      fail("confirm", t("auth.passwordMismatch"));
      return;
    }
    // 按码点数、与服务端同口径（表情 / 生僻字原来各算两个）
    if (isPasswordTooShort(password)) {
      fail("password", t("auth.passwordTooShort"));
      return;
    }
    // 上限按字节、与服务端同口径（超出时原来只回一句笼统的「输入格式不正确」）
    if (isPasswordTooLong(password)) {
      fail("password", t("auth.passwordTooLong"));
      return;
    }
    setBusy(true);
    try {
      await authApi.resetPassword({
        phone: normalizePhone(phone),
        code: cleanCode,
        newPassword: password,
      });
      // 成功即全端会话作废(API.md §2)：按钮画完勾再回登录页用新密码登录
      setDone(true);
    } catch (e) {
      const field = errorField(e);
      if (field) fail(field, toUserMessage(e));
      else setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const codeButtonDisabled = sms.disabled;

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: theme.background }]}>
      <KeyboardAvoid>
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
              // 留出 +86 / 空格 / 横线的位置（自动填充、粘贴），提交前再规整成 11 位
              maxLength={PHONE_INPUT_MAX}
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
                  // 系统从短信里读出验证码填进来（iOS 键盘上方的建议、Android 的短信验证码自动填充）
                  autoComplete="sms-otp"
                  textContentType="oneTimeCode"
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
                  {sms.sending
                    ? t("auth.sending")
                    : sms.cooldown > 0
                      ? t("auth.resend", { n: sms.cooldown })
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
              // 让系统密码管理器给出「建议强密码」并更新存下的那条，而不是把它当成登录密码去填
              autoComplete="new-password"
            />
            <FormInput
              label={t("auth.confirmNewPassword")}
              error={fe("confirm")}
              icon="lock-closed-outline"
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              placeholder={t("auth.confirmPlaceholder")}
              autoComplete="new-password"
            />

            <FormError message={error} />
            <PrimaryButton
              title={t("auth.resetPassword")}
              onPress={submit}
              loading={busy}
              success={done}
              successTitle={t("auth.resetDoneShort")}
              onSuccessShown={() => {
                showToast(t("auth.resetDone"));
                router.back();
              }}
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
      </KeyboardAvoid>
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
