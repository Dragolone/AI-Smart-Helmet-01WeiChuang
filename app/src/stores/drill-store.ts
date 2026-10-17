// 「打开过 SOS 演练没有」（Zustand + SecureStore，按账号分开存）。
// 只决定一件事：安全首页 SOS 按钮下面那行演练入口显不显示——没打开过的显示，打开过一次就收起
// （安全设置里的演练入口一直在）。与求救流程无关：不读、不写任何求救状态。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import { drillSeenKeyOf } from "@/services/secure-keys";

/** 注销账号、重装后清理时一并删掉（services/secure-keys 的 accountSecureKeysOf） */
const keyOf = drillSeenKeyOf;

type DrillState = {
  /** 各账号是否打开过演练；没有条目 = 还没读到 */
  seen: Record<string, boolean>;
  load: (userId: string) => Promise<void>;
  markSeen: (userId: string) => void;
};

export const useDrillStore = create<DrillState>((set, get) => ({
  seen: {},
  load: async (userId) => {
    if (get().seen[userId] !== undefined) return;
    let stored = false;
    try {
      stored = (await SecureStore.getItemAsync(keyOf(userId))) === "1";
    } catch {
      // 读不出来按没打开过处理：多显示一行入口没有害处
    }
    // 读的过程中用户已经点开了演练：不把「打开过」改回去
    if (get().seen[userId] !== undefined) return;
    set((s) => ({ seen: { ...s.seen, [userId]: stored } }));
  },
  markSeen: (userId) => {
    if (get().seen[userId] === true) return;
    set((s) => ({ seen: { ...s.seen, [userId]: true } }));
    // 落盘失败只影响下次启动是否再显示一次入口
    SecureStore.setItemAsync(keyOf(userId), "1").catch(() => undefined);
  },
}));
