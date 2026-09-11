// 语言设置（2026-09-10）：简体 / 繁体 / English。Zustand + SecureStore 持久化（与会话同一存储，
// 不为一个字符串引入 AsyncStorage 依赖）。默认跟随系统语言，用户在「我的」里改后固定。
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

export const LOCALES = ['zh-CN', 'zh-TW', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const KEY = 'helmet.locale';

/** 系统语言 → 支持的三种之一（Hermes 的 Intl 能给出 BCP-47 标签，无需 expo-localization 原生依赖） */
export function detectLocale(): Locale {
  let tag = 'zh-CN';
  try {
    tag = Intl.DateTimeFormat().resolvedOptions().locale ?? tag;
  } catch {
    /* 极少数环境 Intl 不可用：按简体 */
  }
  const lower = tag.toLowerCase();
  if (lower.startsWith('en')) return 'en';
  if (/^zh-(tw|hk|mo|hant)/.test(lower)) return 'zh-TW';
  return 'zh-CN';
}

type LocaleState = {
  locale: Locale;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setLocale: (locale: Locale) => Promise<void>;
};

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: detectLocale(),
  hydrated: false,
  hydrate: async () => {
    try {
      const saved = await SecureStore.getItemAsync(KEY);
      if (saved && (LOCALES as readonly string[]).includes(saved)) {
        set({ locale: saved as Locale, hydrated: true });
        return;
      }
    } catch {
      /* 读失败按系统语言 */
    }
    set({ hydrated: true });
  },
  setLocale: async (locale) => {
    set({ locale });
    await SecureStore.setItemAsync(KEY, locale);
  },
}));
