// 设备页「设为当前」的选择（Zustand + SecureStore，按账号分开存）。
// 只存「用户点过哪一顶」；实际的当前头盔由 services/safety-status.ts 的 currentHelmetOf 推导
// （只有一台在线时不看这个选择）。它决定设备页大图显示谁、安全页默认查看谁、App 内求救记在谁名下
// ——不连接、不断开、不解绑任何设备。
// 落盘：同时在线多台的人（一家人各戴一顶）每次重开 App 都要重选一遍的话，求救会记到别人头上。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import { retryWhenActive } from "@/services/retry-when-active";

/** SecureStore 的 key 只允许字母数字和 . - _；用户 id 是 cuid，满足 */
const legacyKeyOf = (userId: string) => `helmet.currentHelmet.${userId}`;
/**
 * 现行条目：首次解锁后即可读。旧条目是钥匙串默认的 WHEN_UNLOCKED，锁屏下被 BLE 拉起的进程读不到，
 * 原来按「没选过」定死整个进程——这期间 App 内求救可能记到另一顶头盔名下（10-17 评审）
 */
const keyOf = (userId: string) => `helmet.currentHelmet.v2.${userId}`;
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

/** 这个账号在本机存过的条目（注销账号时一并删掉，见 account/delete） */
export const currentHelmetKeysOf = (userId: string): string[] => [
  keyOf(userId),
  legacyKeyOf(userId),
];

/** 读失败、暂按「没选过」顶着的账号：回到前台再读一次，读到之前用户点了「设为当前」就以用户的为准 */
const unread = new Set<string>();

type CurrentHelmetState = {
  /** 各账号选过的头盔；null = 读过了、没选过；没有条目 = 还没读到 */
  chosen: Record<string, string | null>;
  load: (userId: string) => Promise<void>;
  choose: (userId: string, deviceId: string) => void;
};

export const useCurrentHelmetStore = create<CurrentHelmetState>((set, get) => ({
  chosen: {},
  load: async (userId) => {
    const settled = () =>
      get().chosen[userId] !== undefined && !unread.has(userId);
    if (settled()) return;
    let stored: string | null;
    try {
      stored = await SecureStore.getItemAsync(keyOf(userId));
      if (stored === null) {
        stored = await SecureStore.getItemAsync(legacyKeyOf(userId));
        // 旧条目搬到锁屏可读的新条目；搬不成下次再搬
        if (stored)
          SecureStore.setItemAsync(keyOf(userId), stored, KEYCHAIN).catch(
            () => undefined,
          );
      }
    } catch {
      // 读不出来：先按没选过走默认规则（第一台在线的），页面不用一直等；回到前台再读
      unread.add(userId);
      if (get().chosen[userId] === undefined)
        set((s) => ({ chosen: { ...s.chosen, [userId]: null } }));
      retryWhenActive("currentHelmet", () => {
        for (const id of unread) void get().load(id);
      });
      return;
    }
    // 读的过程中用户已经点了「设为当前」：不拿旧值盖回去
    if (settled()) return;
    unread.delete(userId);
    set((s) => ({ chosen: { ...s.chosen, [userId]: stored } }));
  },
  choose: (userId, deviceId) => {
    unread.delete(userId);
    if (get().chosen[userId] === deviceId) return;
    set((s) => ({ chosen: { ...s.chosen, [userId]: deviceId } }));
    // 落盘失败只影响下次启动：回到默认规则，设备页大图上看得见
    SecureStore.setItemAsync(keyOf(userId), deviceId, KEYCHAIN).catch(
      () => undefined,
    );
  },
}));
