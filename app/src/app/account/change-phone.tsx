// 更换手机号（已登录）：sms-code purpose=change_phone（phone 为新号）→ POST /auth/change-phone。
// 成功即生效：用返回的档案刷新会话 store 后返回。
import { useRef, useState } from "react";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";

import { authApi, maskPhone } from "@/api/auth";
import {
  changePhoneErrorMessage,
  isSessionEnded,
} from "@/api/error-messages";
import { FormError, FormInput, PrimaryButton } from "@/components/form";
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { Tappable } from "@/components/tappable";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { showToast } from "@/components/toast";
import { Radius } from "@/constants/theme";
import { useFormErrors, type FormProblem } from "@/hooks/use-form-errors";
import {
  PHONE_INPUT_MAX,
  isValidPhone,
  normalizePhone,
  normalizeSmsCode,
  useSmsCode,
} from "@/hooks/use-sms-code";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { SECURE_KEYS } from "@/services/secure-keys";
import { useAuthStore } from "@/stores/auth-store";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

export default function ChangePhoneScreen() {
  const theme = useTheme();
  const t = useT();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // 换好了：按钮先画勾，画完再提示并返回
  const [done, setDone] = useState(false);
  const sms = useSmsCode("change_phone", phone);
  const codeInput = useRef<TextInput>(null);

  // 与联系人页同一个 normalizePhone：「+86 139 …」、全角数字原来被判成格式不对；
  // 和当前号码比也按规整后的比，「+86 138…」不会被当成换了个新号
  const cleanPhone = normalizePhone(phone);
  const cleanCode = normalizeSmsCode(code);
  const phoneProblem = (): FormProblem | null => {
    if (!isValidPhone(cleanPhone))
      return { key: "phone", message: t("auth.invalidPhone") };
    if (cleanPhone === normalizePhone(user?.phone ?? ""))
      return { key: "samePhone", message: t("auth.samePhone") };
    return null;
  };
  const form = useFormErrors([phone, code, password], () => {
    const problem = phoneProblem();
    if (problem) return problem;
    if (!/^\d{6}$/.test(cleanCode))
      return { key: "code", message: t("auth.invalidCode") };
    if (password.length < 8)
      return { key: "password", message: t("auth.passwordTooShort") };
    return null;
  });

  const sendCode = async () => {
    form.clear();
    const invalid = phoneProblem();
    if (invalid) {
      form.fail(invalid.message);
      return;
    }
    try {
      await sms.send(cleanPhone);
      // 验证码马上就到：焦点给验证码框（iOS 键盘上方会出现短信里的验证码建议）
      codeInput.current?.focus();
    } catch (e) {
      // 会话已失效：正被送回登录页，登录页自有说明
      if (isSessionEnded(e)) return;
      form.fail(changePhoneErrorMessage(e));
    }
  };

  const submit = async () => {
    if (!form.check()) return;
    setBusy(true);
    try {
      const updated = await authApi.changePhone({
        newPhone: cleanPhone,
        code: cleanCode,
        password,
      });
      await setUser(updated);
      // 登录页预填的是上次登录用的号码：换成新号，不然下次登录预填的是已经释放、可能被别人注册的旧号
      SecureStore.setItemAsync(SECURE_KEYS.lastLoginPhone, cleanPhone).catch(
        () => undefined,
      );
      setDone(true);
    } catch (e) {
      // 会话已失效：正被送回登录页，登录页自有说明
      if (isSessionEnded(e)) return;
      form.fail(changePhoneErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const codeButtonDisabled = sms.disabled;

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
            // 留出 +86 / 空格 / 横线的位置（自动填充、粘贴），提交前再规整成 11 位
            maxLength={PHONE_INPUT_MAX}
            placeholder={t("auth.newPhonePlaceholder")}
            autoComplete="tel"
          />
          <View style={styles.codeRow}>
            <View style={styles.flex}>
              <FormInput
                ref={codeInput}
                label={t("auth.smsCode")}
                icon="chatbox-ellipses-outline"
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                maxLength={6}
                placeholder={t("auth.smsCodePlaceholder")}
                autoComplete="sms-otp"
                textContentType="oneTimeCode"
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
              showToast(t("auth.changePhoneDone"));
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
  bottom: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 22, gap: 10 },
});
