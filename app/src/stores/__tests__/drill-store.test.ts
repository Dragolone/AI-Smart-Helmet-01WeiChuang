// 「打开过演练没有」只影响首页那行入口显不显示；这里守住三件事：按账号分开、
// 读写失败不抛、读盘迟到不把「打开过」改回去。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type DrillStore = typeof import("../drill-store");

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

const load = (): DrillStore["useDrillStore"] => {
  let mod!: DrillStore;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../drill-store") as DrillStore;
  });
  return mod.useDrillStore;
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

describe("drill-store", () => {
  it("没读到之前没有结论；读完没有记录 = 没打开过", async () => {
    const store = load();
    expect(store.getState().seen.u1).toBeUndefined();
    await store.getState().load("u1");
    expect(store.getState().seen.u1).toBe(false);
  });

  it("打开过一次：立刻生效并落盘，下次启动仍是打开过", async () => {
    const store = load();
    await store.getState().load("u1");
    store.getState().markSeen("u1");
    expect(store.getState().seen.u1).toBe(true);
    await flush();

    const next = load();
    await next.getState().load("u1");
    expect(next.getState().seen.u1).toBe(true);
  });

  it("按账号分开：同一台手机换个账号登录，入口对新账号仍然显示", async () => {
    const store = load();
    store.getState().markSeen("u1");
    await flush();
    await store.getState().load("u2");
    expect(store.getState().seen.u1).toBe(true);
    expect(store.getState().seen.u2).toBe(false);
  });

  it("读盘还没回来用户就点开了演练：迟到的「没有记录」不把它改回去", async () => {
    let release!: () => void;
    mockGetGate = new Promise<void>((r) => {
      release = r;
    });
    const store = load();
    const loading = store.getState().load("u1");
    store.getState().markSeen("u1");
    release();
    await loading;
    expect(store.getState().seen.u1).toBe(true);
  });

  it("读不出来按没打开过处理，不抛", async () => {
    mockFail.get = true;
    const store = load();
    await expect(store.getState().load("u1")).resolves.toBeUndefined();
    expect(store.getState().seen.u1).toBe(false);
  });

  it("落盘失败不抛，本次进程内照样算打开过", async () => {
    mockFail.set = true;
    const store = load();
    expect(() => store.getState().markSeen("u1")).not.toThrow();
    await flush();
    expect(store.getState().seen.u1).toBe(true);
  });
});
