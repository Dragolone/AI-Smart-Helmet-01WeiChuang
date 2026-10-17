// 登录页（API.md §2 POST /auth/login）
import { Link, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { Image } from "expo-image";
import { useEffect, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { SafeAreaView } from "react-native-safe-area-context";

import { authApi } from "@/api/auth";
import { PHONE_INPUT_MAX, normalizePhone } from "@/hooks/use-sms-code";
import { toUserMessage } from "@/api/error-messages";
import {
  FormError,
  FormInput,
  PrimaryButton,
  errorField,
  type FormField,
} from "@/components/form";
import { LOGIN_BRAND } from "@/components/splash/login-brand";
import { SplashAnchor } from "@/components/splash/splash-anchor";
import { SplashArrive } from "@/components/splash/splash-arrive";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useTheme } from "@/hooks/use-theme";
import { useT } from "@/i18n";
import { SECURE_KEYS } from "@/services/secure-keys";
import { useAuthStore } from "@/stores/auth-store";
import { useConsentStore } from "@/stores/consent-store";

export default function LoginScreen() {
  const t = useT();
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  const router = useRouter();
  const signIn = useAuthStore((s) => s.signIn);
  // 这台设备上还没同意过隐私政策（老用户换机 / 注册在别的手机上）→ 登录页补一次勾选，
  // 之后不再问。极光 SDK 只在同意之后初始化（services/push.ts）。
  const privacyAccepted = useConsentStore((s) => s.privacyAccepted);
  const consentHydrated = useConsentStore((s) => s.hydrated);
  const acceptPrivacy = useConsentStore((s) => s.accept);
  const sessionExpired = useAuthStore((s) => s.sessionExpired);
  // 标记还没从 SecureStore 读出来时也按「需要」处理：宁可多勾一次，不能让冷启动秒点登录绕过同意
  // （评审 2026-09-26）——读出来通常只要几十毫秒，勾选框最多闪一下
  const needConsent = !consentHydrated || !privacyAccepted;
  const [consented, setConsented] = useState(false);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 能落到具体字段的错误就地显示（红框 + 抖动），落不到的走页面级 FormError */
  const [fieldError, setFieldError] = useState<{
    field: FormField;
    message: string;
  } | null>(null);
  const fe = (f: FormField) =>
    fieldError?.field === f ? fieldError.message : null;
  const [busy, setBusy] = useState(false);
  // 顶部的商标和 App 名是开屏动画落下来的地方，尺寸两边共用
  const { width } = useWindowDimensions();
  const markSize = LOGIN_BRAND.markSize(width);
  const titleSize = LOGIN_BRAND.titleSize(width);

  // 记住上次登录的手机号(只存号码不存密码);读取失败静默忽略
  useEffect(() => {
    SecureStore.getItemAsync(SECURE_KEYS.lastLoginPhone)
      .then((v) => {
        if (v) setPhone((cur) => cur || v);
      })
      .catch(() => {});
  }, []);

  const submit = async () => {
    setError(null);
    setFieldError(null);
    if (needConsent && !consented) {
      setError(t("auth.consentRequired"));
      return;
    }
    // 「+86 138 0000 0000」、全角数字、通讯录复制带的方向标记先规整（与联系人页同一个 normalizePhone），
    // 原来原样提交，正确的号码被服务端判成「输入格式不正确」
    const cleanPhone = normalizePhone(phone);
    setBusy(true);
    try {
      const auth = await authApi.login({ phone: cleanPhone, password });
      if (needConsent) await acceptPrivacy();
      SecureStore.setItemAsync(SECURE_KEYS.lastLoginPhone, cleanPhone).catch(
        () => {},
      );
      await signIn(auth); // AuthGate 检测到会话后自动跳转主页
    } catch (e) {
      const field = errorField(e);
      if (field) setFieldError({ field, message: toUserMessage(e) });
      else setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

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
            {/* 开屏动画把商标和 App 名送到这里（冷启动、没登录时）；下面各块在页面涌上来之后依次进场。
                平时进这一页（登出、从注册页回来）没有这些动作，就是普通的静态页面。 */}
            <View style={styles.brand}>
              <SplashAnchor name="loginMark">
                {/* 商标的「0」是白的：浅色外观下放在一块深色底上（就是 App 图标的样子），否则看不见 */}
                <Image
                  source={
                    dark
                      ? require("@/assets/images/company-mark-solid.webp")
                      : require("@/assets/images/icon-brand.png")
                  }
                  style={{
                    width: markSize,
                    height: markSize,
                    borderRadius: dark ? 0 : markSize * 0.225,
                  }}
                  contentFit="contain"
                  accessible={false}
                />
              </SplashAnchor>
              {/* 隐藏入口：长按 App 名 3 秒进蓝牙工程模式（硬件联调，不需要账号）；正式上线可删 */}
              <Pressable
                delayLongPress={3000}
                onLongPress={() => router.navigate("/ble-bench")}
                style={{ marginTop: LOGIN_BRAND.gap(width) }}
              >
                <SplashAnchor name="loginTitle">
                  <ThemedText
                    allowFontScaling={false}
                    style={[
                      styles.brandName,
                      {
                        fontSize: titleSize,
                        lineHeight: titleSize * 1.3,
                        letterSpacing: LOGIN_BRAND.titleSpacing(width),
                      },
                    ]}
                  >
                    {t("auth.appName")}
                  </ThemedText>
                </SplashAnchor>
              </Pressable>
            </View>
            <SplashArrive order={0}>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.slogan}
              >
                {t("auth.slogan")}
              </ThemedText>
            </SplashArrive>

            {/* 被动登出要说清楚后果：头盔事件靠这台手机中转，没登录就没有摔倒通知（2026-10-05 评审） */}
            {sessionExpired && (
              <View
                accessibilityRole="alert"
                style={[styles.expiredNotice, { borderColor: theme.danger }]}
              >
                <Ionicons
                  name="warning-outline"
                  size={18}
                  color={theme.danger}
                />
                <ThemedText type="small" style={styles.consentText}>
                  {t("auth.sessionExpiredNotice")}
                </ThemedText>
              </View>
            )}

            <SplashArrive order={1}>
              <FormInput
                label={t("auth.phone")}
                error={fe("phone")}
                icon="phone-portrait-outline"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                // 留出 +86 / 空格 / 横线的位置：系统自动填充本机号码常是「+86 138 0000 0000」，
                // 卡 11 位会被截成「+86 138 000」，提交前再规整成 11 位
                maxLength={PHONE_INPUT_MAX}
                placeholder={t("auth.phonePlaceholder")}
                autoComplete="tel"
              />
            </SplashArrive>
            <SplashArrive order={2}>
              <FormInput
                label={t("auth.password")}
                error={fe("password")}
                icon="lock-closed-outline"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder={t("auth.passwordPlaceholderLogin")}
                autoComplete="password"
              />
            </SplashArrive>

            {needConsent && (
              <SplashArrive order={3}>
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
              </SplashArrive>
            )}

            <FormError message={error} />
            <SplashArrive order={4}>
              <PrimaryButton
                title={t("auth.login")}
                onPress={submit}
                loading={busy}
              />
            </SplashArrive>

            <SplashArrive order={5}>
              <View style={styles.linkRow}>
                {/* 跳走之前先收键盘：输入框还聚焦着就离开的话，回来时 iOS 会把焦点和键盘一起恢复，
                  返回手势途中键盘那块区域也是空的（2026-10-06 iPhone 实测） */}
                <Link href="/register" onPress={() => Keyboard.dismiss()}>
                  <ThemedText type="link">{t("auth.noAccount")}</ThemedText>
                </Link>
                <Link href="/reset-password" onPress={() => Keyboard.dismiss()}>
                  <ThemedText type="link" themeColor="textSecondary">
                    {t("auth.forgotPassword")}
                  </ThemedText>
                </Link>
              </View>
            </SplashArrive>
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
    gap: 14,
  },
  brand: { alignItems: "center", marginBottom: 6 },
  brandName: { fontWeight: "400", textAlign: "center" },
  slogan: { textAlign: "center" },
  consentRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  expiredNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  consentText: { flex: 1, lineHeight: 20 },
  linkRow: {
    flexDirection: "row",
    // 放不下就把「忘记密码」换到下一行：系统字体 2 倍时两个链接挤在一行、后一个被切掉（2026-10-15 边界测试）
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 8,
    columnGap: 16,
    marginTop: 8,
    paddingHorizontal: 4,
  },
});
