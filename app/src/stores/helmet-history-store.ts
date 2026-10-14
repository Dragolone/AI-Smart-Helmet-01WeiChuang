// 本机记住的「这个账号有过头盔」（Zustand + SecureStore）。
//
// 设备页在账号下没有头盔时要分两种人：从没绑过的新用户走三步指引；绑过又解绑的只给绑定那一张卡
// （负责人 2026-10-08：「解绑了头盔又重新开始未绑定页，应该判定是否为新用户第一次打开」）。
// 后端没有这项记录——解绑之后设备列表就是空的，和新账号一样——所以记在本机：见到账号下有头盔就记上，
// 不随退出登录清掉。换手机、重装之后没有记录，会按新用户再走一遍三步指引：只是多看一遍，不影响功能。
import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

const KEY = "helmet.everHadHelmet";
/** 最多记这么多个账号（一台手机上登过的账号不会多；有上限是为了存的东西不会一直长） */
const MAX_USERS = 20;

type HelmetHistoryState = {
  hydrated: boolean;
  /** 有过头盔的账号，最近记的在后面 */
  users: string[];
  hydrate: () => Promise<void>;
  markHad: (userId: string) => void;
};

function persist(users: string[]): void {
  SecureStore.setItemAsync(KEY, JSON.stringify(users)).catch(() => undefined);
}

export const useHelmetHistoryStore = create<HelmetHistoryState>((set, get) => ({
  hydrated: false,
  users: [],
  hydrate: async () => {
    if (get().hydrated) return;
    let stored: string[] = [];
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed))
        stored = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      // 读不出来按没有记录处理：最多是让绑过的人再看一遍三步指引
    }
    if (get().hydrated) return;
    // 读的过程中已经记了新的：两边合起来，再存回去
    const now = get().users;
    const fresh = now.filter((u) => !stored.includes(u));
    const users = [...stored, ...fresh].slice(-MAX_USERS);
    set({ hydrated: true, users });
    if (fresh.length > 0) persist(users);
  },
  markHad: (userId) => {
    if (get().users.includes(userId)) return;
    const users = [...get().users, userId].slice(-MAX_USERS);
    set({ users });
    // 盘上的还没读进来时先不写：这时写会把别的账号的记录盖掉；读完那一下会合起来再存
    if (get().hydrated) persist(users);
  },
}));

export const hadHelmetBefore = (users: string[], userId: string | null) =>
  userId !== null && users.includes(userId);
