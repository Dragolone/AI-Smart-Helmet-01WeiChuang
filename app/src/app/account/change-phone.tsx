// 更换手机号（已登录）：sms-code purpose=change_phone（phone 为新号）→ POST /auth/change-phone。
// 成功即生效：用返回的档案刷新会话 store 后返回。
import { useEffect, useState } from "react";
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
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";

/** 与后端 SMS_CODE_RESEND_INTERVAL_SECONDS 默认一致；超前点击由服务端 429 兜底 */
const RESEND_SECONDS = 60;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export default function ChangePhoneScreen() {
  const theme = useTheme();
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  /** 重发限频按截止时间戳 + 墙钟算剩余（同 register.tsx：iOS 退后台定时器暂停，回前台首个 tick 即校准） */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  useEffect(() => {
    if (cooldownUntil <= now) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [cooldownUntil, now]);

  const validPhone = (): string | null => {
    const value = phone.trim();
    if (!PHONE_PATTERN.test(value)) return t("auth.invalidPhone");
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
    setSending(true);
    try {
      await authApi.sendSmsCode({
        phone: phone.trim(),
        purpose: "change_phone",
      });
      const sentAt = Date.now();
      setNow(sentAt);
      setCooldownUntil(sentAt + RESEND_SECONDS * 1000);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setSending(false);
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
    setBusy(true);
    try {
      const updated = await authApi.changePhone({
        newPhone: phone.trim(),
        code,
      });
      await setUser(updated);
      showToast(t("auth.changePhoneDone"));
      router.back();
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const codeButtonDisabled = sending || cooldown > 0;

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
                {sending
                  ? t("auth.sending")
                  : cooldown > 0
                    ? t("auth.resend", { n: cooldown })
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
