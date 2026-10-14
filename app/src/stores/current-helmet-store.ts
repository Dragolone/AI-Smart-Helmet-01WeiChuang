// 设备页「设为当前」的选择（Zustand + SecureStore，按账号分开存）。
// 只存「用户点过哪一顶」；实际的当前头盔由 services/safety-status.ts 的 currentHelmetOf 推导
// （只有一台在线时不看这个选择）。它决定设备页大图显示谁、安全页默认查看谁、App 内求救记在谁名下
// ——不连接、不断开、不解绑任何设备。
// 落盘：同时在线多台的人（一家人各戴一顶）每次重开 App 都要重选一遍的话，求救会记到别人头上。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

/** SecureStore 的 key 只允许字母数字和 . - _；用户 id 是 cuid，满足 */
const keyOf = (userId: string) => `helmet.currentHelmet.${userId}`;

type CurrentHelmetState = {
  /** 各账号选过的头盔；null = 读过了、没选过；没有条目 = 还没读到 */
  chosen: Record<string, string | null>;
  load: (userId: string) => Promise<void>;
  choose: (userId: string, deviceId: string) => void;
};

export const useCurrentHelmetStore = create<CurrentHelmetState>((set, get) => ({
  chosen: {},
  load: async (userId) => {
    if (get().chosen[userId] !== undefined) return;
    let stored: string | null = null;
    try {
      stored = await SecureStore.getItemAsync(keyOf(userId));
    } catch {
      // 读不出来按没选过处理：落回默认规则（第一台在线的）
    }
    // 读的过程中用户已经点了「设为当前」：不拿旧值盖回去
    if (get().chosen[userId] !== undefined) return;
    set((s) => ({ chosen: { ...s.chosen, [userId]: stored } }));
  },
  choose: (userId, deviceId) => {
    if (get().chosen[userId] === deviceId) return;
    set((s) => ({ chosen: { ...s.chosen, [userId]: deviceId } }));
    // 落盘失败只影响下次启动：回到默认规则，设备页大图上看得见
    SecureStore.setItemAsync(keyOf(userId), deviceId).catch(() => undefined);
  },
}));
