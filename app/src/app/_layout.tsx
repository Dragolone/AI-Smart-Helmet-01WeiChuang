import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AnimatedSplashOverlay } from "@/components/animated-icon";
import { ToastHost } from "@/components/toast";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useLocaleStore, useT } from "@/i18n";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { ConnectionBanner } from "@/components/connection-banner";
import { PrivacyConsentModal } from "@/components/privacy-consent-modal";
import { ThemeFade } from "@/components/theme-fade";
import { installDevErrorTap } from "@/services/dev-log";
import { useAuthStore } from "@/stores/auth-store";
import { useConsentStore } from "@/stores/consent-store";
import { useThemeStore } from "@/stores/theme-store";

// 开发期：未捕获异常旁路上报（真机 Metro 日志通道断时仍能看到红屏原因）
installDevErrorTap();

// 已知无害：开发期 iOS 摘除了推送 entitlement（个人团队签不了 aps-environment），
// expo-notifications 启动自检读不到钥匙串会报此错。公司账号恢复正式签名后删除本行。
LogBox.ignoreLogs([/ERR_NOTIFICATIONS_KEYCHAIN_ACCESS/]);

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    // 移动端弱网常态：失败重试一次即可，避免错误提示被长时间重试拖延
    queries: { retry: 1, staleTime: 10_000 },
  },
});

// 登出或换账号时清空查询缓存：query key 不含用户 id，staleTime 内新账号会直接看到上一账号的
// 设备/事件/事故（审计 APP-01）。同一账号改昵称等 user 变更不清（id 不变）。
useAuthStore.subscribe((state, prev) => {
  const switched = (state.user?.id ?? null) !== (prev.user?.id ?? null);
  const loggedOut = state.tokens === null && prev.tokens !== null;
  if (switched || loggedOut) queryClient.clear();
});

/** 登录门控：导航器保持挂载，Stack.Protected 按会话状态切换可用路由组（guard 翻转自动重定向） */
function RootNavigator() {
  const authed = useAuthStore((s) => s.tokens !== null);
  const t = useT();
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={authed}>
        {/* 标签页自身不显示 header，但它的 title 会成为下级页面返回键的文字（默认会露出路由组名 "(tabs)"） */}
        <Stack.Screen name="(tabs)" options={{ title: t("nav.back") }} />
        <Stack.Screen
          name="bind-device"
          options={{
            presentation: "modal",
            headerShown: true,
            title: t("nav.bindDevice"),
          }}
        />
        <Stack.Screen
          name="scan-bind"
          options={{
            presentation: "fullScreenModal",
            headerShown: true,
            title: t("scan.title"),
          }}
        />
        <Stack.Screen
          name="device/[deviceId]"
          options={{ headerShown: true, title: t("nav.deviceDetail") }}
        />
        <Stack.Screen
          name="add-contact"
          options={{
            presentation: "modal",
            headerShown: true,
            title: t("nav.addContact"),
          }}
        />
        <Stack.Screen
          name="accident/[accidentId]"
          options={{ headerShown: true, title: t("nav.accidentDetail") }}
        />
        <Stack.Screen
          name="events"
          options={{ headerShown: true, title: t("nav.events") }}
        />
        <Stack.Screen
          name="video-preview"
          options={{ headerShown: true, title: t("nav.videoPreview") }}
        />
        <Stack.Screen
          name="contacts"
          options={{ headerShown: true, title: t("nav.contacts") }}
        />
        <Stack.Screen
          name="accidents"
          options={{ headerShown: true, title: t("nav.accidents") }}
        />
        <Stack.Screen
          name="account/change-password"
          options={{ headerShown: true, title: t("nav.changePassword") }}
        />
        <Stack.Screen
          name="account/change-phone"
          options={{ headerShown: true, title: t("nav.changePhone") }}
        />
        <Stack.Screen
          name="account/delete"
          options={{ headerShown: true, title: t("nav.deleteAccount") }}
        />
        <Stack.Screen
          name="help"
          options={{ headerShown: true, title: t("nav.help") }}
        />
        {/* 隐私政策 / 用户协议共用一页，具体标题由页面按 doc 参数自行 setOptions */}
        <Stack.Screen
          name="legal/[doc]"
          options={{ headerShown: true, title: t("nav.privacy") }}
        />
        {/* SOS 全屏页：手势返回禁用——处理中的求救不允许误滑关闭 */}
        <Stack.Screen
          name="sos-active"
          options={{ presentation: "fullScreenModal", gestureEnabled: false }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!authed}>
        <Stack.Screen name="(auth)/login" />
        <Stack.Screen name="(auth)/register" />
        <Stack.Screen name="(auth)/reset-password" />
      </Stack.Protected>
      {/* 蓝牙工程模式（硬件联调）：登录前后都可进，入口=登录页长按 App 名 3 秒 / 设备页信息区 */}
      <Stack.Screen
        name="ble-bench"
        options={{ headerShown: true, title: t("nav.bleBench") }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const hydrated = useAuthStore((s) => s.hydrated);
  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrateLocale = useLocaleStore((s) => s.hydrate);
  const hydrateTheme = useThemeStore((s) => s.hydrate);
  // 隐私政策同意标记：不门控 UI，只决定第三方 SDK（极光）能不能初始化（services/push.ts）
  const hydrateConsent = useConsentStore((s) => s.hydrate);
  // 语言/外观设置恢复完再挂路由：原生标签条挂载后再改标签文字会错位（2026-09-10 真机实证）
  const localeHydrated = useLocaleStore((s) => s.hydrated);
  const themeHydrated = useThemeStore((s) => s.hydrated);

  useEffect(() => {
    void hydrate();
    void hydrateLocale();
    void hydrateTheme();
    void hydrateConsent();
  }, [hydrate, hydrateLocale, hydrateTheme, hydrateConsent]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ThemeFade scheme={colorScheme} />
        <ThemeProvider
          value={colorScheme === "dark" ? DarkTheme : DefaultTheme}
        >
          <AnimatedSplashOverlay />
          {/* SecureStore 恢复完成前不挂路由，避免登录态闪变；空白由 SplashOverlay 兜住 */}
          {hydrated && localeHydrated && themeHydrated && (
            <AppErrorBoundary scheme={colorScheme}>
              <RootNavigator />
            </AppErrorBoundary>
          )}
          <ToastHost />
          <ConnectionBanner />
          {/* 已登录但本机未同意过隐私政策（升级前就登录着的用户）：一次性弹窗，同意前极光不初始化 */}
          <PrivacyConsentModal />
        </ThemeProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
