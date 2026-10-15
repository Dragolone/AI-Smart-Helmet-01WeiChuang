// 更换手机号（已登录）：sms-code purpose=change_phone（phone 为新号）→ POST /auth/change-phone。
// 成功即生效：用返回的档案刷新会话 store 后返回。
import { useState } from "react";
import { router } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";

import { authApi, maskPhone } from "@/api/auth";
import { toUserMessage } from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { showToast } from "@/components/toast";
import { Radius } from "@/constants/theme";
import { useSmsCode, isValidPhone } from "@/hooks/use-sms-code";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";

export default function ChangePhoneScreen() {
  const theme = useTheme();
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 换好了：按钮先画勾，画完再提示并返回
  const [done, setDone] = useState(false);
  const sms = useSmsCode("change_phone");

  const validPhone = (): string | null => {
    const value = phone.trim();
    if (!isValidPhone(value)) return t("auth.invalidPhone");
    if (value === user?.phone) return t("auth.samePhone");
    return null;
  };

  const sendCode = async () => {
    setError(null);
    const invalid = validPhone();
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      await sms.send(phone);
    } catch (e) {
      setError(toUserMessage(e));
    }
  };

  const submit = async () => {
    setError(null);
    const invalid = validPhone();
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError(t("auth.invalidCode"));
      return;
    }
    if (password.length < 8) {
      setError(t("auth.passwordTooShort"));
      return;
    }
    setBusy(true);
    try {
      const updated = await authApi.changePhone({
        newPhone: phone.trim(),
        code,
        password,
      });
      await setUser(updated);
      setDone(true);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const codeButtonDisabled = sms.disabled;

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
            {t("auth.changePhoneLead")}
          </ThemedText>

          <ThemedText type="label" themeColor="textSecondary">
            {t("auth.currentPhone")}
          </ThemedText>
          <View
            style={[
              styles.current,
              {
                backgroundColor: theme.backgroundSelected,
                borderColor: theme.border,
              },
            ]}
          >
            <ThemedText
              type="default"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {maskPhone(user?.phone)}
            </ThemedText>
          </View>

          <FormInput
            label={t("auth.currentPassword")}
            icon="lock-closed-outline"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            placeholder={t("auth.currentPasswordPlaceholder")}
          />
          <FormInput
            label={t("auth.newPhone")}
            icon="phone-portrait-outline"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            maxLength={11}
            placeholder={t("auth.newPhonePlaceholder")}
            autoComplete="tel"
          />
          <View style={styles.codeRow}>
            <View style={styles.flex}>
              <FormInput
                label={t("auth.smsCode")}
                icon="chatbox-ellipses-outline"
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                maxLength={6}
                placeholder={t("auth.smsCodePlaceholder")}
                autoComplete="sms-otp"
              />
            </View>
            <Tappable
              feedback={["opacity", "scale"]}
              disabled={codeButtonDisabled}
              onPress={() => void sendCode()}
              style={[
                styles.codeButton,
                {
                  borderColor: codeButtonDisabled ? theme.border : theme.brand,
                },
              ]}
            >
              <ThemedText
                type="smallBold"
                style={{
                  color: codeButtonDisabled ? theme.textSecondary : theme.brand,
                }}
              >
                {sms.sending
                  ? t("auth.sending")
                  : sms.cooldown > 0
                    ? t("auth.resend", { n: sms.cooldown })
                    : t("auth.getCode")}
              </ThemedText>
            </Tappable>
          </View>
          <FormError message={error} />
        </ScrollView>
        <View style={styles.bottom}>
          <PrimaryButton
            title={t("common.save")}
            onPress={() => void submit()}
            loading={busy}
            success={done}
            onSuccessShown={() => {
              showToast(t("auth.changePhoneDone"));
              router.back();
            }}
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
  current: {
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
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
  bottom: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 22 },
});
