import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

// Web 静态渲染时服务端没有配色信息：hydration 前固定返回 'light'，
// 到客户端后再返回真实配色，避免服务端/客户端首屏不一致。
const emptySubscribe = () => () => {};

export function useColorScheme() {
  const hasHydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );

  const colorScheme = useRNColorScheme();

  return hasHydrated ? colorScheme : 'light';
}
