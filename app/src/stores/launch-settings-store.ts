// 华为 / 荣耀「应用启动管理」那一步做没做过（Zustand + SecureStore）。
//
// 默认「自动管理」时从多任务划掉 App = 系统强停，之后求救推送到不了；设成手动管理、三项全开就不会
// （10-18 华为 P30 Pro 实测，DEVELOPMENT 平台限制清单）。系统不给查这项设置，所以「做过」= 点过「去设置」
// 又回到了 App。放成全局状态：设备页状态卡、首次连接引导、安全设置页同时在用，一处点过各处一起变。
// 按手机记、不随退出登录清掉（和省电白名单一样是这台手机的设置）。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import { SECURE_KEYS } from "@/services/secure-keys";

const KEY = SECURE_KEYS.launchSettingsAcked;

type LaunchSettingsState = {
  /** null = 还没读出来（这时按做过算，免得提示一闪） */
  acked: boolean | null;
  /** 点了「去设置」、还没回到 App */
  pending: boolean;
  hydrate: () => Promise<void>;
  markPending: () => void;
  /** 回到前台时调：点过「去设置」就记为做过 */
  onForeground: () => void;
};

let reading: Promise<void> | null = null;

export const useLaunchSettingsStore = create<LaunchSettingsState>(
  (set, get) => ({
    acked: null,
    pending: false,
    hydrate: () => {
      if (get().acked !== null) return Promise.resolve();
      reading ??= SecureStore.getItemAsync(KEY)
        .then((v) => v === "1")
        // 读不出来按没做过：多提示一次，不能少提示
        .catch(() => false)
        .then((stored) => {
          // 读的过程中已经记成做过了：以记下的为准
          if (get().acked === null) set({ acked: stored });
        })
        .finally(() => {
          reading = null;
        });
      return reading;
    },
    markPending: () => set({ pending: true }),
    onForeground: () => {
      if (!get().pending) return;
      set({ pending: false, acked: true });
      SecureStore.setItemAsync(KEY, "1").catch(() => undefined);
    },
  }),
);
