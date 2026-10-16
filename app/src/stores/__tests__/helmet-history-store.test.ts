// 本机记住的「这个账号有过头盔」：绑过又解绑的账号不再走三步指引。
// 守住：重开 App 还在、多个账号各记各的、读写失败不抛、读盘迟到不丢记录也不盖掉别的账号、坏数据当没有。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type Store = typeof import("../helmet-history-store");

const mockKv = new Map<string, string>();
const mockFail = { get: false, set: false };
let mockGetGate: Promise<void> | null = null;

jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => {
    if (mockGetGate) await mockGetGate;
    if (mockFail.get) throw new Error("keychain unavailable");
    return mockKv.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string) => {
    if (mockFail.set) throw new Error("User interaction is not allowed");
    mockKv.set(k, v);
  },
}));

const KEY = "helmet.everHadHelmet";
const load = (): Store => {
  let mod!: Store;
  jest.isolateModules(() => {
    mod = require("../helmet-history-store") as Store;
  });
  return mod;
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  mockKv.clear();
  mockFail.get = false;
  mockFail.set = false;
  mockGetGate = null;
});

describe("这个账号有过头盔吗", () => {
  it("记下来，重开 App 还读得到；没记过的账号、没登录都是没有", async () => {
    const a = load();
    await a.useHelmetHistoryStore.getState().hydrate();
    a.useHelmetHistoryStore.getState().markHad("u1");
    await flush();

    const b = load();
    const st = b.useHelmetHistoryStore;
    expect(st.getState().hydrated).toBe(false);
    await st.getState().hydrate();
    expect(b.hadHelmetBefore(st.getState().users, "u1")).toBe(true);
    expect(b.hadHelmetBefore(st.getState().users, "u2")).toBe(false);
    expect(b.hadHelmetBefore(st.getState().users, null)).toBe(false);
  });

  it("几个账号各记各的，同一个账号不重复记、不重复写", async () => {
    const { useHelmetHistoryStore: st } = load();
    await st.getState().hydrate();
    st.getState().markHad("u1");
    st.getState().markHad("u2");
    await flush();
    mockKv.set(KEY, "sentinel");
    st.getState().markHad("u1");
    await flush();
    expect(mockKv.get(KEY)).toBe("sentinel");
    expect(st.getState().users).toEqual(["u1", "u2"]);
  });

  it("盘上的还没读进来就记了新的：读完两边都在，别的账号的记录没被盖掉", async () => {
    mockKv.set(KEY, JSON.stringify(["old"]));
    let open!: () => void;
    mockGetGate = new Promise<void>((r) => {
      open = r;
    });
    const { useHelmetHistoryStore: st } = load();
    const reading = st.getState().hydrate();
    st.getState().markHad("u1");
    await flush();
    // 读完之前不落盘
    expect(mockKv.get(KEY)).toBe(JSON.stringify(["old"]));
    open();
    await reading;
    await flush();
    expect(st.getState().users).toEqual(["old", "u1"]);
    expect(JSON.parse(mockKv.get(KEY) ?? "[]")).toEqual(["old", "u1"]);
  });

  it("没有记录、读失败、存的是坏数据：都当没有，不抛", async () => {
    const a = load().useHelmetHistoryStore;
    await a.getState().hydrate();
    expect(a.getState()).toMatchObject({ hydrated: true, users: [] });

    mockFail.get = true;
    const b = load().useHelmetHistoryStore;
    await expect(b.getState().hydrate()).resolves.toBeUndefined();
    expect(b.getState()).toMatchObject({ hydrated: true, users: [] });

    mockFail.get = false;
    for (const bad of ["{", "null", '"x"', '{"u1":true}']) {
      mockKv.set(KEY, bad);
      const c = load().useHelmetHistoryStore;
      await c.getState().hydrate();
      expect(c.getState().users).toEqual([]);
    }
    // 数组里混进了别的东西：只留字符串
    mockKv.set(KEY, '["u1",2,null,"u3"]');
    const d = load().useHelmetHistoryStore;
    await d.getState().hydrate();
    expect(d.getState().users).toEqual(["u1", "u3"]);
  });

  it("写失败不抛，本次运行里记着的仍然有效", async () => {
    mockFail.set = true;
    const { useHelmetHistoryStore: st } = load();
    await st.getState().hydrate();
    expect(() => st.getState().markHad("u1")).not.toThrow();
    await flush();
    expect(st.getState().users).toEqual(["u1"]);
  });

  it("只留最近的 20 个账号", async () => {
    const { useHelmetHistoryStore: st } = load();
    await st.getState().hydrate();
    for (let i = 0; i < 25; i += 1) st.getState().markHad(`u${i}`);
    expect(st.getState().users).toHaveLength(20);
    expect(st.getState().users[0]).toBe("u5");
    expect(st.getState().users[19]).toBe("u24");
  });
});
