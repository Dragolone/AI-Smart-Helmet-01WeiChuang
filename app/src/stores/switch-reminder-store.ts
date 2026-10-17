// 「更换头盔提醒」（Zustand）：开关按账号存 SecureStore；问过谁、此刻该不该问只在内存里。
// 判断条件见 services/switch-reminder.ts，弹出来的面板见 components/switch-helmet-prompt。
// 它只是提醒：用户点了才换当前头盔（stores/current-helmet-store），不自动换。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import { switchReminderKeyOf } from "@/services/secure-keys";

/** 注销账号、重装后清理时一并删掉（services/secure-keys 的 accountSecureKeysOf） */
const keyOf = switchReminderKeyOf;

export type SwitchPrompt = { currentId: string; otherId: string };

const pairKey = (userId: string, p: SwitchPrompt) =>
  `${userId}:${p.currentId}>${p.otherId}`;

type SwitchReminderState = {
  /** 各账号的开关；没有条目 = 还没读到（读到之前不提醒） */
  enabled: Record<string, boolean>;
  load: (userId: string) => Promise<void>;
  setEnabled: (userId: string, on: boolean) => void;
  /** 这次打开 App 期间已经问过的「当前 → 另一台」：同一对不再问 */
  asked: Record<string, true>;
  /** 此刻要问的那一对；null = 没有要问的 */
  prompt: SwitchPrompt | null;
  /** 条件满足时提出来：开关关着、这一对问过、已有一条在问，都不提 */
  offer: (userId: string, p: SwitchPrompt) => void;
  /** 用户答了（换 / 不换）：记为问过并收起 */
  answer: (userId: string) => void;
  /** 条件不再成立（那台停了、掉线了、当前头盔已经换了）：收起，但不算问过 */
  withdraw: () => void;
};

export const useSwitchReminderStore = create<SwitchReminderState>(
  (set, get) => ({
    enabled: {},
    load: async (userId) => {
      if (get().enabled[userId] !== undefined) return;
      let on = true;
      try {
        on = (await SecureStore.getItemAsync(keyOf(userId))) !== "0";
      } catch {
        // 读不出来按开着处理：多问一次没有害处，用户可以在面板里勾「以后不再提醒」
      }
      // 读的过程中用户已经改了开关：不拿旧值盖回去
      if (get().enabled[userId] !== undefined) return;
      set((s) => ({ enabled: { ...s.enabled, [userId]: on } }));
    },
    setEnabled: (userId, on) => {
      if (get().enabled[userId] === on) return;
      set((s) => ({
        enabled: { ...s.enabled, [userId]: on },
        prompt: on ? s.prompt : null,
      }));
      // 落盘失败只影响下次启动：回到默认的开着
      SecureStore.setItemAsync(keyOf(userId), on ? "1" : "0").catch(
        () => undefined,
      );
    },
    asked: {},
    prompt: null,
    offer: (userId, p) => {
      const s = get();
      if (s.enabled[userId] !== true || s.prompt) return;
      if (s.asked[pairKey(userId, p)]) return;
      set({ prompt: p });
    },
    answer: (userId) => {
      const p = get().prompt;
      if (!p) return;
      set((s) => ({
        prompt: null,
        asked: { ...s.asked, [pairKey(userId, p)]: true },
      }));
    },
    withdraw: () => {
      if (get().prompt) set({ prompt: null });
    },
  }),
);
