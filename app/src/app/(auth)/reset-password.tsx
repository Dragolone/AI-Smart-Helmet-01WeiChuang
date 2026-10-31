// 找回密码页（API.md §2：sms-code purpose=reset_password → POST /auth/reset-password）
// 成功后服务端撤销该用户全部会话,所有设备需重新登录——页面提示后回登录页。
import { router } from "expo-router";
import { useRef, useState } from "react";
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
} from "@/components/form";
import { KeyboardAvoid } from "@/components/keyboard-avoid";
import { showToast } from "@/components/toast";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { Radius } from "@/constants/theme";
import { useEnterChain } from "@/hooks/use-enter-chain";
import { useFormErrors } from "@/hooks/use-form-errors";
import {
  PHONE_INPUT_MAX,
  isValidPhone,
  normalizePhone,
  normalizeSmsCode,
  useSmsCode,
} from "@/hooks/use-sms-code";
import { phoneFromParam, useRouteParams } from "@/hooks/use-route-params";
import {
  isPasswordTooLong,
  isPasswordTooShort,
} from "@/services/password-rules";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";

export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";

export default function ResetPasswordScreen() {
  const theme = useTheme();
  const t = useT();
  // 登录页常是预填好的号码：点「忘记密码」带过来，不用再输一遍
  const params = useRouteParams<{ phone?: string }>();
  const [phone, setPhone] = useState(() => phoneFromParam(params.phone));
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const cleanCode = normalizeSmsCode(code);
  const form = useFormErrors([phone, code, password, confirm], () => {
    if (!/^\d{6}$/.test(cleanCode))
      return { key: "code", field: "code", message: t("auth.invalidCode") };
    if (password !== confirm)
      return {
        key: "confirm",
        field: "confirm",
        message: t("auth.passwordMismatch"),
      };
    // 按码点数、与服务端同口径（表情 / 生僻字原来各算两个）
    if (isPasswordTooShort(password))
      return {
        key: "short",
        field: "password",
        message: t("auth.passwordTooShort"),
      };
    // 上限按字节、与服务端同口径（超出时原来只回一句笼统的「输入格式不正确」）
    if (isPasswordTooLong(password))
      return {
        key: "long",
        field: "password",
        message: t("auth.passwordTooLong"),
      };
    // 号码放在最后查：拿到验证码后又把号码改坏的，原来要等服务端回 400 才说「输入格式不正确」
    if (!isValidPhone(normalizePhone(phone)))
      return {
        key: "phone",
        field: "phone",
        message: t("auth.invalidPhone"),
      };
    return null;
  });
  const [busy, setBusy] = useState(false);
  // 重置成功：按钮先画勾（「已重置」），画完再提示并回登录页
  const [done, setDone] = useState(false);
  // 成功时重置的是哪个号码：画勾的一秒里用户还能改输入框，回登录页带的要是请求里那个
  const resetPhone = useRef("");
  const sms = useSmsCode("reset_password", phone);

  const submit = async () => {
    // 回车键也能走到这里，按钮的加载 / 成功态拦不住它
    if (busy || done) return;
    if (!form.check()) return;
    const cleanPhone = normalizePhone(phone);
    setBusy(true);
    try {
      await authApi.resetPassword({
        phone: cleanPhone,
        code: cleanCode,
        newPassword: password,
      });
      // 成功即全端会话作废(API.md §2)：按钮画完勾再回登录页用新密码登录
      resetPhone.current = cleanPhone;
      setDone(true);
    } catch (e) {
      form.fail(toUserMessage(e), errorField(e) ?? undefined);
    } finally {
      setBusy(false);
    }
  };

  const enter = useEnterChain(4, () => void submit());

  const sendCode = async () => {
    form.clear();
    const cleanPhone = normalizePhone(phone);
    if (!isValidPhone(cleanPhone)) {
      form.fail(t("auth.invalidPhone"), "phone");
      return;
    }
    try {
      await sms.send(cleanPhone);
      // 验证码马上就到：焦点给验证码框（iOS 键盘上方会出现短信里的验证码建议）
      enter.focus(1);
    } catch (e) {
      form.fail(toUserMessage(e), errorField(e) ?? undefined);
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
              {...enter.field(0)}
              label={t("auth.phone")}
              error={form.fieldError("phone")}
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
                  {...enter.field(1)}
                  label={t("auth.smsCode")}
                  error={form.fieldError("code")}
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
              {...enter.field(2)}
              label={t("auth.newPassword")}
              error={form.fieldError("password")}
              icon="lock-closed-outline"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder={t("auth.passwordPlaceholder")}
              // 让系统密码管理器给出「建议强密码」并更新存下的那条，而不是把它当成登录密码去填
              autoComplete="new-password"
            />
            <FormInput
              {...enter.field(3)}
              label={t("auth.confirmNewPassword")}
              error={form.fieldError("confirm")}
              icon="lock-closed-outline"
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              placeholder={t("auth.confirmPlaceholder")}
              autoComplete="new-password"
            />

            <FormError message={form.pageError} />
            <PrimaryButton
              title={t("auth.resetPassword")}
              onPress={submit}
              loading={busy}
              success={done}
              successTitle={t("auth.resetDoneShort")}
              onSuccessShown={() => {
                showToast(t("auth.resetDone"));
                // dismissTo：登录页还在栈里，回去而不是再压一张；把刚重置的号码带回去，登录页直接填好
                router.dismissTo({
                  pathname: "/login",
                  params: { phone: resetPhone.current },
                });
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
