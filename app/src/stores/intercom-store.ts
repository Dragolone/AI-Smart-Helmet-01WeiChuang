// 对讲的两样跨页面状态（Zustand）：
// - session：此刻在哪个频道的房间里、麦克风开没开——给别的标签页上的「对讲中」小条看。
//   通话本身（TRTC 进房、收发）仍由对讲页管，这里只是它对外的一份摘要；不在房间里时为 null。
// - 「一直开麦」的说明看过没有：按账号存 SecureStore，第一次切到一直开麦时先看一遍说明。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import { openMicSeenKeyOf } from "@/services/secure-keys";

/** 注销账号、重装后清理时一并删掉（services/secure-keys 的 accountSecureKeysOf） */
const keyOf = openMicSeenKeyOf;

export type IntercomSession = {
  channelId: string;
  channelName: string;
  /** 麦克风此刻是否开着（一直开麦且没静音）。按住说话时松着手算关着 */
  micOpen: boolean;
  /** 掉线重连中 */
  reconnecting: boolean;
};

type IntercomState = {
  session: IntercomSession | null;
  setSession: (session: IntercomSession | null) => void;
  /** 各账号是否看过「一直开麦」的说明；没有条目 = 还没读到 */
  openMicSeen: Record<string, boolean>;
  loadOpenMicSeen: (userId: string) => Promise<void>;
  markOpenMicSeen: (userId: string) => void;
};

export const useIntercomStore = create<IntercomState>((set, get) => ({
  session: null,
  setSession: (session) => set({ session }),
  openMicSeen: {},
  loadOpenMicSeen: async (userId) => {
    if (get().openMicSeen[userId] !== undefined) return;
    let seen = false;
    try {
      seen = (await SecureStore.getItemAsync(keyOf(userId))) === "1";
    } catch {
      // 读不出来按没看过处理：多看一遍说明没有害处
    }
    // 读的过程中用户已经确认过：不把它改回去
    if (get().openMicSeen[userId] !== undefined) return;
    set((s) => ({ openMicSeen: { ...s.openMicSeen, [userId]: seen } }));
  },
  markOpenMicSeen: (userId) => {
    if (get().openMicSeen[userId] === true) return;
    set((s) => ({ openMicSeen: { ...s.openMicSeen, [userId]: true } }));
    // 落盘失败只影响下次启动是否再看一遍说明
    SecureStore.setItemAsync(keyOf(userId), "1").catch(() => undefined);
  },
}));
