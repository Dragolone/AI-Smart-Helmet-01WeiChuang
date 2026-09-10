// 外观设置（2026-09-10）：跟随系统 / 深色 / 浅色。持久化到 SecureStore（与语言设置同一做法，不加 AsyncStorage）。
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

export const THEME_MODES = ['system', 'dark', 'light'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

const KEY = 'helmet.theme';

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
        set({ mode: saved as ThemeMode, hydrated: true });
        return;
      }
    } catch {
      /* 读失败按默认深色 */
    }
    set({ hydrated: true });
  },
  setMode: async (mode) => {
    set({ mode });
    await SecureStore.setItemAsync(KEY, mode);
  },
}));
