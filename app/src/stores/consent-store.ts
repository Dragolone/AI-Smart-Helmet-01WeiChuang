// 隐私政策 / 用户服务协议的「已同意」标记（2026-09-24）。Zustand + SecureStore，与会话、语言同一存储。
// 为什么要单独存：极光等第三方 SDK 必须等用户明确同意之后才能初始化（商店合规硬要求，THIRD_PARTY §6），
// 而「登录成功」不等于「同意过」——老用户换新手机直接登录、从没见过勾选框。
// 口径：注册页 / 登录页勾选并提交成功 → accept()；每台设备只问一次；不随登出清除（同意的是这台设备上的这个人）。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

const KEY = "helmet.privacy.accepted";
/** 存的是接受时的政策版本号；以后政策大改要重新征求同意时把这个值改掉即可 */
export const PRIVACY_VERSION = "2026-09-23";

type ConsentState = {
  hydrated: boolean;
  /** 当前版本的隐私政策与用户协议是否已同意 */
  privacyAccepted: boolean;
  hydrate: () => Promise<void>;
  accept: () => Promise<void>;
};

export const useConsentStore = create<ConsentState>((set) => ({
  hydrated: false,
  privacyAccepted: false,
  hydrate: async () => {
    try {
      const saved = await SecureStore.getItemAsync(KEY);
      set({ privacyAccepted: saved === PRIVACY_VERSION, hydrated: true });
    } catch {
      // 读失败按未同意：宁可多问一次，不能少问
      set({ privacyAccepted: false, hydrated: true });
    }
  },
  accept: async () => {
    set({ privacyAccepted: true });
    try {
      await SecureStore.setItemAsync(KEY, PRIVACY_VERSION);
    } catch {
      // 落盘失败只影响下次是否再问，不阻塞注册/登录
    }
  },
}));
