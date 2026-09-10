// 外观：用户在「我的 → 外观」选跟随系统 / 深色 / 浅色（stores/theme-store）。
// 默认深色（品牌主题）；选「跟随系统」时读系统配色。
import { useColorScheme as useSystemColorScheme } from 'react-native';

import { useThemeStore } from '@/stores/theme-store';

export function useColorScheme(): 'dark' | 'light' {
  const mode = useThemeStore((s) => s.mode);
  const system = useSystemColorScheme();
  if (mode === 'system') return system === 'light' ? 'light' : 'dark';
  return mode;
}
