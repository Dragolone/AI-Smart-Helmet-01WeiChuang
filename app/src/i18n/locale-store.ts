// 语言设置（2026-09-10）：简体 / 繁体 / English。Zustand + SecureStore 持久化（与会话同一存储，
// 不为一个字符串引入 AsyncStorage 依赖）。默认跟随系统语言，用户在「我的」里改后固定。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import { retryWhenActive } from "@/services/retry-when-active";

export const LOCALES = ["zh-CN", "zh-TW", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** 旧条目：当初没带可访问性选项，是钥匙串默认的 WHEN_UNLOCKED——锁屏时读不到 */
const LEGACY_KEY = "helmet.locale";
/**
 * 现行条目：首次解锁后即可读（同 consent-store）。锁屏下被 BLE 拉起的进程读不到旧条目，原来就按系统语言定死
 * 整个进程（通知通道名、前台服务文案跟着错）。换 key 而不是原地改：钥匙串的 update 不改可访问性。
 */
const KEY = "helmet.locale.v2";
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

const isLocale = (v: string | null): v is Locale =>
  v !== null && (LOCALES as readonly string[]).includes(v);

/** 系统语言 → 支持的三种之一（Hermes 的 Intl 能给出 BCP-47 标签，无需 expo-localization 原生依赖） */
export function detectLocale(): Locale {
  let tag = "zh-CN";
  try {
    tag = Intl.DateTimeFormat().resolvedOptions().locale ?? tag;
  } catch {
    /* 极少数环境 Intl 不可用：按简体 */
  }
  const lower = tag.toLowerCase();
  if (lower.startsWith("en")) return "en";
  // 繁体：脚本写明 Hant，或地区是台湾 / 香港 / 澳门（脚本写明 Hans 的除外，如 zh-Hans-HK）。
  // 粤语（yue-Hant-HK，iOS 可选「粤语（繁体）」）也是繁体字，原来落到简体
  if (/^(zh|yue)(-|$)/.test(lower) && !/-hans(-|$)/.test(lower)) {
    if (/-(hant|tw|hk|mo)(-|$)/.test(lower)) return "zh-TW";
  }
  return "zh-CN";
}

type LocaleState = {
  locale: Locale;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setLocale: (locale: Locale) => Promise<void>;
};

/** 读盘期间用户已经选过：迟到的旧值不把它盖回去 */
let chosenBeforeHydrate = false;

export const useLocaleStore = create<LocaleState>((set, get) => ({
  locale: detectLocale(),
  hydrated: false,
  hydrate: async () => {
    let saved: string | null;
    try {
      saved = await SecureStore.getItemAsync(KEY);
      if (saved === null) {
        saved = await SecureStore.getItemAsync(LEGACY_KEY);
        // 旧条目搬到锁屏可读的新条目；搬不成下次再搬
        if (isLocale(saved))
          SecureStore.setItemAsync(KEY, saved, KEYCHAIN).catch(() => undefined);
      }
    } catch {
      // 读不出来 ≠ 没设过：先按系统语言挂上界面（路由和实时通道都等 hydrated），回到前台再读
      set({ hydrated: true });
      retryWhenActive("locale", () => void get().hydrate());
      return;
    }
    if (!chosenBeforeHydrate && isLocale(saved)) set({ locale: saved });
    set({ hydrated: true });
  },
  setLocale: async (locale) => {
    chosenBeforeHydrate = true;
    set({ locale });
    // 落盘失败不抛：本次运行照样生效（调用方是 `void setLocale(loc)`）
    try {
      await SecureStore.setItemAsync(KEY, locale, KEYCHAIN);
    } catch {
      /* 下次改的时候再写 */
    }
  },
}));
