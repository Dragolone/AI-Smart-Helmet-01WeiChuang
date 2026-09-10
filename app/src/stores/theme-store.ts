// 外观设置（2026-09-10）：跟随系统 / 深色 / 浅色。持久化到 SecureStore（与语言设置同一做法，不加 AsyncStorage）。
import * as SecureStore from 'expo-secure-store';
import { Appearance } from 'react-native';
import { create } from 'zustand';

export const THEME_MODES = ['system', 'dark', 'light'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

const KEY = 'helmet.theme';

/** iOS 原生标签条（液态玻璃）与系统弹窗只认 App 级 UIUserInterfaceStyle，JS 主题必须同步过去 */
const applyNative = (mode: ThemeMode) => {
  try {
    Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
  } catch {
    /* 旧版 RN 无此 API 时忽略 */
  }
};

type ThemeState = {
  mode: ThemeMode;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setMode: (mode: ThemeMode) => Promise<void>;
};

export const useThemeStore = create<ThemeState>((set) => ({
  // 品牌默认深色（2026-08-16 风格迭代口径）；用户改过才跟随其选择
  mode: 'dark',
  hydrated: false,
  hydrate: async () => {
    try {
      const saved = await SecureStore.getItemAsync(KEY);
      if (saved && (THEME_MODES as readonly string[]).includes(saved)) {
        applyNative(saved as ThemeMode);
        set({ mode: saved as ThemeMode, hydrated: true });
        return;
      }
    } catch {
      /* 读失败按默认深色 */
    }
    applyNative('dark');
    set({ hydrated: true });
  },
  setMode: async (mode) => {
    applyNative(mode);
    set({ mode });
    await SecureStore.setItemAsync(KEY, mode);
  },
}));
