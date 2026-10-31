// 外观设置（2026-09-10）：跟随系统 / 深色 / 浅色。持久化到 SecureStore（与语言设置同一做法，不加 AsyncStorage）。
import * as SecureStore from "expo-secure-store";
import { Appearance } from "react-native";
import { create } from "zustand";

import { retryWhenActive } from "@/services/retry-when-active";
import { SECURE_KEYS } from "@/services/secure-keys";
import { notePersistFailure, warnIfDiskLow } from "@/services/persist-notice";

export const THEME_MODES = ["system", "dark", "light"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** 旧条目：钥匙串默认的 WHEN_UNLOCKED，锁屏时读不到 */
const LEGACY_KEY = SECURE_KEYS.themeLegacy;
/** 现行条目：首次解锁后即可读（同 locale-store / consent-store；换 key 是因为钥匙串的 update 不改可访问性） */
const KEY = SECURE_KEYS.theme;
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

const isMode = (v: string | null): v is ThemeMode =>
  v !== null && (THEME_MODES as readonly string[]).includes(v);

/** iOS 原生标签条（液态玻璃）与系统弹窗只认 App 级 UIUserInterfaceStyle，JS 主题必须同步过去 */
const applyNative = (mode: ThemeMode) => {
  try {
    Appearance.setColorScheme(mode === "system" ? "unspecified" : mode);
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

/** 读盘期间用户已经选过：迟到的旧值不把它盖回去（同 current-helmet-store 等的口径） */
let chosenBeforeHydrate = false;

export const useThemeStore = create<ThemeState>((set, get) => ({
  // 品牌默认深色（2026-08-16 风格迭代口径）；用户改过才跟随其选择
  mode: "dark",
  hydrated: false,
  hydrate: async () => {
    let saved: string | null;
    try {
      saved = await SecureStore.getItemAsync(KEY);
      if (saved === null) {
        saved = await SecureStore.getItemAsync(LEGACY_KEY);
        if (isMode(saved))
          SecureStore.setItemAsync(KEY, saved, KEYCHAIN).catch(() => undefined);
      }
    } catch {
      // 读不出来（锁屏下被拉起）：先按当前值挂上界面，回到前台再读，不让默认深色定死整个进程
      if (!chosenBeforeHydrate) applyNative(get().mode);
      set({ hydrated: true });
      retryWhenActive("theme", () => void get().hydrate());
      return;
    }
    if (chosenBeforeHydrate) {
      set({ hydrated: true });
      return;
    }
    const mode = isMode(saved) ? saved : "dark";
    applyNative(mode);
    set({ mode, hydrated: true });
  },
  setMode: async (mode) => {
    chosenBeforeHydrate = true;
    applyNative(mode);
    set({ mode });
    // 落盘失败不抛：本次运行照样生效（调用方是 `void setMode(m)`，抛出去就是一个没人接的 Promise 拒绝）
    try {
      await SecureStore.setItemAsync(KEY, mode, KEYCHAIN);
      warnIfDiskLow("setting");
    } catch (e) {
      // 下次改的时候再写；说一声是因为重启后会还原，用户看不出来（O37）
      notePersistFailure("setting", e);
    }
  },
}));
