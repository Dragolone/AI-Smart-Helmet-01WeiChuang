// 本机记住的「上次启动时账号下有没有头盔」（Zustand + SecureStore）。
// 开屏动画在商标完成那一刻要知道落到哪种页面，而设备列表每次冷启动都要从网络取：没回来时照这份记录播
// （负责人 2026-10-08 定）。只影响开屏怎么收尾，不参与任何业务判断；记录和实际不符时，
// 页面以接口返回的为准。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

const KEY = "helmet.launchMemory";

export type LaunchRecord = {
  userId: string;
  hasHelmet: boolean;
};

type LaunchMemoryState = {
  hydrated: boolean;
  record: LaunchRecord | null;
  hydrate: () => Promise<void>;
  remember: (userId: string, hasHelmet: boolean) => void;
  forget: () => void;
};

export const useLaunchMemoryStore = create<LaunchMemoryState>((set, get) => ({
  hydrated: false,
  record: null,
  hydrate: async () => {
    if (get().hydrated) return;
    let record: LaunchRecord | null = null;
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as LaunchRecord).userId === "string" &&
        typeof (parsed as LaunchRecord).hasHelmet === "boolean"
      ) {
        record = {
          userId: (parsed as LaunchRecord).userId,
          hasHelmet: (parsed as LaunchRecord).hasHelmet,
        };
      }
    } catch {
      // 读不出来按没有记录处理：开屏在商标上多等一会儿
    }
    // 读的过程中已经记了新的：不拿旧值盖回去
    if (get().hydrated) return;
    set({ hydrated: true, record: get().record ?? record });
  },
  remember: (userId, hasHelmet) => {
    const cur = get().record;
    if (cur && cur.userId === userId && cur.hasHelmet === hasHelmet) return;
    const record = { userId, hasHelmet };
    set({ record, hydrated: true });
    SecureStore.setItemAsync(KEY, JSON.stringify(record)).catch(
      () => undefined,
    );
  },
  forget: () => {
    if (!get().record) return;
    set({ record: null });
    SecureStore.deleteItemAsync(KEY).catch(() => undefined);
  },
}));
