// 设备页「设为当前」的选择决定求救记在谁名下；这里守住：按账号分开、重开 App 还在、
// 读写失败不抛、读盘迟到不把刚选的盖回去。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type Store = typeof import("../current-helmet-store");

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

const load = (): Store["useCurrentHelmetStore"] => {
  let mod!: Store;
  jest.isolateModules(() => {
    mod = require("../current-helmet-store") as Store;
  });
  return mod.useCurrentHelmetStore;
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

describe("current-helmet-store", () => {
  it("没读到之前没有结论；读完没有记录 = 没选过", async () => {
    const store = load();
    expect(store.getState().chosen.u1).toBeUndefined();
    await store.getState().load("u1");
    expect(store.getState().chosen.u1).toBeNull();
  });

  it("设为当前：立刻生效并落盘，重开 App 还是这一台", async () => {
    const store = load();
    await store.getState().load("u1");
    store.getState().choose("u1", "helmet_b");
    expect(store.getState().chosen.u1).toBe("helmet_b");
    await flush();

    const next = load();
    await next.getState().load("u1");
    expect(next.getState().chosen.u1).toBe("helmet_b");
  });

  it("可以改选：以最后一次为准", async () => {
    const store = load();
    store.getState().choose("u1", "helmet_a");
    store.getState().choose("u1", "helmet_b");
    await flush();

    const next = load();
    await next.getState().load("u1");
    expect(next.getState().chosen.u1).toBe("helmet_b");
  });

  it("按账号分开：同一台手机换个账号登录，不沿用上一个账号的选择", async () => {
    const store = load();
    store.getState().choose("u1", "helmet_b");
    await flush();
    await store.getState().load("u2");
    expect(store.getState().chosen.u1).toBe("helmet_b");
    expect(store.getState().chosen.u2).toBeNull();
  });

  it("读盘还没回来用户就点了设为当前：迟到的旧值不把它盖回去", async () => {
    mockKv.set("helmet.currentHelmet.u1", "helmet_a");
    let release!: () => void;
    mockGetGate = new Promise<void>((r) => {
      release = r;
    });
    const store = load();
    const loading = store.getState().load("u1");
    store.getState().choose("u1", "helmet_b");
    release();
    await loading;
    expect(store.getState().chosen.u1).toBe("helmet_b");
  });

  it("读不出来按没选过处理，不抛", async () => {
    mockFail.get = true;
    const store = load();
    await expect(store.getState().load("u1")).resolves.toBeUndefined();
    expect(store.getState().chosen.u1).toBeNull();
  });

  it("落盘失败不抛，本次进程内照样生效", async () => {
    mockFail.set = true;
    const store = load();
    expect(() => store.getState().choose("u1", "helmet_b")).not.toThrow();
    await flush();
    expect(store.getState().chosen.u1).toBe("helmet_b");
  });
});
