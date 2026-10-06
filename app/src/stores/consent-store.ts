// 隐私政策 / 用户服务协议的「已同意」标记（2026-09-24）。Zustand + SecureStore，与会话、语言同一存储。
// 为什么要单独存：极光等第三方 SDK 必须等用户明确同意之后才能初始化（商店合规硬要求，THIRD_PARTY §6），
// 而「登录成功」不等于「同意过」——老用户换新手机直接登录、从没见过勾选框。
// 口径：注册页 / 登录页勾选并提交成功 → accept()；每台设备只问一次；不随登出清除（同意的是这台设备上的这个人）。
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { create } from "zustand";

/** 旧条目：当初没带可访问性选项，是钥匙串默认的 WHEN_UNLOCKED——锁屏时读不到 */
const LEGACY_KEY = "helmet.privacy.accepted";
/**
 * 现行条目：首次解锁后即可读（与会话 token 同口径，见 auth-store）。
 * 头盔的 BLE 事件能在锁屏下把被回收的 App 重新拉起（状态恢复）：token 读得出、登录态成立，
 * 同意标记却读不到——原来按「未同意」处理，这次进程里极光不初始化，用户解锁后还被要求重新勾选，
 * 旁边就是「不同意，退出登录」（2026-10-05 评审）。换 key 而不是原地改：钥匙串的 update 不改可访问性。
 */
const KEY = "helmet.privacy.accepted.v2";
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
/** 存的是接受时的政策版本号；以后政策大改要重新征求同意时把这个值改掉即可 */
export const PRIVACY_VERSION = "2026-09-23";

type ConsentState = {
  hydrated: boolean;
  /** 当前版本的隐私政策与用户协议是否已同意 */
  privacyAccepted: boolean;
  hydrate: () => Promise<void>;
  accept: () => Promise<void>;
};

/** 读不出来时挂一次「回到前台再读」：锁屏下拉起的进程，用户解锁打开 App 的那一刻就能读了 */
let retrySub: { remove: () => void } | null = null;
function retryWhenActive(hydrate: () => Promise<void>): void {
  if (retrySub) return;
  retrySub = AppState.addEventListener("change", (state) => {
    if (state !== "active") return;
    retrySub?.remove();
    retrySub = null;
    void hydrate();
  });
}

export const useConsentStore = create<ConsentState>((set, get) => ({
  hydrated: false,
  privacyAccepted: false,
  hydrate: async () => {
    try {
      if ((await SecureStore.getItemAsync(KEY)) === PRIVACY_VERSION) {
        set({ privacyAccepted: true, hydrated: true });
        return;
      }
      const legacy = await SecureStore.getItemAsync(LEGACY_KEY);
      const accepted = legacy === PRIVACY_VERSION;
      // 本次会话里已经点过同意的不回退（accept 与重读交错时）
      set({
        privacyAccepted: accepted || get().privacyAccepted,
        hydrated: true,
      });
      // 旧条目搬到锁屏可读的新条目；搬不成下次再搬
      if (accepted)
        SecureStore.setItemAsync(KEY, PRIVACY_VERSION, KEYCHAIN).catch(
          () => undefined,
        );
    } catch {
      // 读不出来 ≠ 没同意：保持「还没读完」（登录页照样要求勾选、极光照样不初始化——宁可多问不能少问，
      // 但不弹「请同意否则退出登录」），回到前台再读一次
      if (!get().privacyAccepted) set({ hydrated: false });
      retryWhenActive(get().hydrate);
    }
  },
  accept: async () => {
    set({ privacyAccepted: true, hydrated: true });
    try {
      await SecureStore.setItemAsync(KEY, PRIVACY_VERSION, KEYCHAIN);
    } catch {
      // 落盘失败只影响下次是否再问，不阻塞注册/登录
    }
  },
}));
