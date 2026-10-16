// 注册页（API.md §2：POST /auth/sms-code 取验证码 → POST /auth/register 带 code）
import { Link, router } from "expo-router";
import { useState } from "react";
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
import { cleanNickname } from "@/services/user-name";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { useAuthStore } from "@/stores/auth-store";
import { useConsentStore } from "@/stores/consent-store";

export default function RegisterScreen() {
  const theme = useTheme();
  const t = useT();
  const signIn = useAuthStore((s) => s.signIn);
  const acceptPrivacy = useConsentStore((s) => s.accept);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [nickname, setNickname] = useState("");
  // 合规：默认不勾，不勾不让提交（极光等第三方 SDK 也必须等这一步之后才初始化）
  const [consented, setConsented] = useState(false);
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
  const sms = useSmsCode("register", phone);

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
    if (!consented) {
      setError(t("auth.consentRequired"));
      return;
    }
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
      const auth = await authApi.register({
        phone: normalizePhone(phone),
        code: cleanCode,
        password,
        // 昵称按显示时的规则整理：只含零宽字符 / 换行的昵称原来照提交，资料卡、对讲格子里没有名字
        ...(cleanNickname(nickname) && { nickname: cleanNickname(nickname) }),
      });
      // 勾选 + 提交成功 = 同意成立；先记同意再登录，登录态钩子里的推送 SDK 初始化才放行
      await acceptPrivacy();
      await signIn(auth); // 注册即登录（后端直接发 token）
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
            <ThemedText type="title">{t("auth.register")}</ThemedText>

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
              label={t("auth.password")}
              error={fe("password")}
              icon="lock-closed-outline"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder={t("auth.passwordPlaceholder")}
              // 让系统密码管理器给出「建议强密码」并存下，而不是把它当成登录密码去填
              autoComplete="new-password"
            />
            <FormInput
              label={t("auth.confirmPassword")}
              error={fe("confirm")}
              icon="lock-closed-outline"
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              placeholder={t("auth.confirmPlaceholder")}
              autoComplete="new-password"
            />
            <FormInput
              label={t("auth.nickname")}
              error={fe("nickname")}
              icon="person-outline"
              value={nickname}
              onChangeText={setNickname}
              maxLength={30}
              placeholder={t("auth.nicknamePlaceholder")}
            />

            {/* 同意勾选：默认不勾、不勾不让提交（商店合规高频扣分项）。
              书名号两处各自可点，跳 legal/[doc]（正文由后端托管，见 constants/legal.ts）。
              整行可点切换勾选；书名号是嵌套 Text 的 onPress，靠它先成为 touch responder
              来避免连带切换外层勾选——这条依赖 RN 的响应者链，双端真机各点一次确认（REGRESSION 1.1）。 */}
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
                    router.navigate("/legal/terms");
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
                    router.navigate("/legal/privacy");
                  }}
                  suppressHighlighting
                >
                  {t("auth.consentPrivacy")}
                </ThemedText>
              </ThemedText>
            </Pressable>

            <FormError message={error} />
            <PrimaryButton
              title={t("auth.registerAndLogin")}
              onPress={submit}
              loading={busy}
            />

            {/* dismissTo：注册页是从登录页进来的子页面，「已有账号」应当是回去而不是再压一张登录页——
                原来来回点几次，左滑要一张张退回最初的登录页（2026-10-06 iPhone 实测）。
                栈里没有登录页时（直接打开注册页）自动改为替换当前页 */}
            <Link
              href="/login"
              dismissTo
              onPress={() => Keyboard.dismiss()}
              style={styles.link}
            >
              <ThemedText type="link">{t("auth.haveAccount")}</ThemedText>
            </Link>
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
    gap: 12,
  },
  codeRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  consentRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  consentText: { flex: 1, lineHeight: 20 },
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
