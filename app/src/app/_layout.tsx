import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { LogBox } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useAuthStore } from '@/stores/auth-store';

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

/** 登录门控：导航器保持挂载，Stack.Protected 按会话状态切换可用路由组（guard 翻转自动重定向） */
function RootNavigator() {
  const authed = useAuthStore((s) => s.tokens !== null);
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={authed}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="bind-device"
          options={{
            presentation: 'modal',
            headerShown: true,
            title: '绑定设备',
          }}
        />
        <Stack.Screen
          name="device/[deviceId]"
          options={{ headerShown: true, title: '设备详情' }}
        />
        <Stack.Screen
          name="add-contact"
          options={{
            presentation: 'modal',
            headerShown: true,
            title: '添加紧急联系人',
          }}
        />
        <Stack.Screen
          name="accident/[accidentId]"
          options={{ headerShown: true, title: '事故详情' }}
        />
        <Stack.Screen
          name="events"
          options={{ headerShown: true, title: '安全事件' }}
        />
        {/* SOS 全屏页：手势返回禁用——处理中的求救不允许误滑关闭 */}
        <Stack.Screen
          name="sos-active"
          options={{ presentation: 'fullScreenModal', gestureEnabled: false }}
        />
      </Stack.Protected>
      <Stack.Protected guard={!authed}>
        <Stack.Screen name="(auth)/login" />
        <Stack.Screen name="(auth)/register" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const hydrated = useAuthStore((s) => s.hydrated);
  const hydrate = useAuthStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        {/* SecureStore 恢复完成前不挂路由，避免登录态闪变；空白由 SplashOverlay 兜住 */}
        {hydrated && <RootNavigator />}
      </ThemeProvider>
    </QueryClientProvider>
  );
}
