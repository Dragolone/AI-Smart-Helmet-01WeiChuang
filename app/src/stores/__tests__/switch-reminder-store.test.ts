// 「更换头盔提醒」的开关与「问过没有」：默认开、按账号存；同一对头盔一次运行只问一次；
// 关掉开关后不再问；条件不成立时收起不算问过。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type Store = typeof import("../switch-reminder-store");

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

const load = (): Store["useSwitchReminderStore"] => {
  let mod!: Store;
  jest.isolateModules(() => {
    mod = require("../switch-reminder-store") as Store;
  });
  return mod.useSwitchReminderStore;
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
const AB = { currentId: "a", otherId: "b" };

beforeEach(() => {
  mockKv.clear();
  mockFail.get = false;
  mockFail.set = false;
  mockGetGate = null;
});

describe("开关", () => {
  it("没读到之前没有结论；没存过 = 开着", async () => {
    const store = load();
    expect(store.getState().enabled.u1).toBeUndefined();
    await store.getState().load("u1");
    expect(store.getState().enabled.u1).toBe(true);
  });

  it("关掉：立刻生效并落盘，重开 App 还是关着；按账号分开", async () => {
    const store = load();
    await store.getState().load("u1");
    store.getState().setEnabled("u1", false);
    expect(store.getState().enabled.u1).toBe(false);
    await flush();

    const next = load();
    await next.getState().load("u1");
    await next.getState().load("u2");
    expect(next.getState().enabled.u1).toBe(false);
    expect(next.getState().enabled.u2).toBe(true);
  });

  it("读盘还没回来用户就改了开关：迟到的旧值不把它盖回去", async () => {
    let release!: () => void;
    mockGetGate = new Promise<void>((r) => {
      release = r;
    });
    const store = load();
    const loading = store.getState().load("u1");
    store.getState().setEnabled("u1", false);
    release();
    await loading;
    expect(store.getState().enabled.u1).toBe(false);
  });

  it("读不出来按开着处理、落盘失败不抛", async () => {
    mockFail.get = true;
    mockFail.set = true;
    const store = load();
    await expect(store.getState().load("u1")).resolves.toBeUndefined();
    expect(store.getState().enabled.u1).toBe(true);
    expect(() => store.getState().setEnabled("u1", false)).not.toThrow();
    await flush();
    expect(store.getState().enabled.u1).toBe(false);
  });
});

describe("问一次", () => {
  it("开关还没读到时不问", () => {
    const store = load();
    store.getState().offer("u1", AB);
    expect(store.getState().prompt).toBeNull();
  });

  it("答过之后（换或不换），同一对这次运行不再问；反过来的那一对是另一回事", async () => {
    const store = load();
    await store.getState().load("u1");
    store.getState().offer("u1", AB);
    expect(store.getState().prompt).toEqual(AB);
    store.getState().answer("u1");
    expect(store.getState().prompt).toBeNull();

    store.getState().offer("u1", AB);
    expect(store.getState().prompt).toBeNull();

    const BA = { currentId: "b", otherId: "a" };
    store.getState().offer("u1", BA);
    expect(store.getState().prompt).toEqual(BA);
  });

  it("已经有一条在问时，不被另一对顶掉", async () => {
    const store = load();
    await store.getState().load("u1");
    store.getState().offer("u1", AB);
    store.getState().offer("u1", { currentId: "a", otherId: "c" });
    expect(store.getState().prompt).toEqual(AB);
  });

  it("条件不成立了收起：不算问过，之后还可以再问", async () => {
    const store = load();
    await store.getState().load("u1");
    store.getState().offer("u1", AB);
    store.getState().withdraw();
    expect(store.getState().prompt).toBeNull();
    store.getState().offer("u1", AB);
    expect(store.getState().prompt).toEqual(AB);
  });

  it("关掉开关：正在问的那条收起，之后也不再问", async () => {
    const store = load();
    await store.getState().load("u1");
    store.getState().offer("u1", AB);
    store.getState().setEnabled("u1", false);
    expect(store.getState().prompt).toBeNull();
    store.getState().offer("u1", { currentId: "a", otherId: "c" });
    expect(store.getState().prompt).toBeNull();
  });

  it("重开 App 后可以再问（问过只记在内存里）", async () => {
    const store = load();
    await store.getState().load("u1");
    store.getState().offer("u1", AB);
    store.getState().answer("u1");

    const next = load();
    await next.getState().load("u1");
    next.getState().offer("u1", AB);
    expect(next.getState().prompt).toEqual(AB);
  });
});
