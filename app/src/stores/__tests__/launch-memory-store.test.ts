// 本机记住的「上次启动时账号下有没有头盔」：开屏在设备列表没回来时照它播。
// 守住：重开 App 还在、读写失败不抛、读盘迟到不把刚记的盖回去、坏数据当没有。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type Store = typeof import("../launch-memory-store");

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
  deleteItemAsync: async (k: string) => {
    mockKv.delete(k);
  },
}));

const load = (): Store["useLaunchMemoryStore"] => {
  let mod!: Store;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../launch-memory-store") as Store;
  });
  return mod.useLaunchMemoryStore;
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

describe("开屏用的启动记忆", () => {
  it("记下来，重开 App 还读得到", async () => {
    const a = load();
    a.getState().remember("u1", true);
    await flush();
    const b = load();
    expect(b.getState().record).toBeNull();
    await b.getState().hydrate();
    expect(b.getState().record).toEqual({ userId: "u1", hasHelmet: true });
    expect(b.getState().hydrated).toBe(true);
  });

  it("没有记录、读失败、存的是坏数据：都当没有，不抛", async () => {
    const a = load();
    await a.getState().hydrate();
    expect(a.getState()).toMatchObject({ hydrated: true, record: null });

    mockFail.get = true;
    const b = load();
    await expect(b.getState().hydrate()).resolves.toBeUndefined();
    expect(b.getState()).toMatchObject({ hydrated: true, record: null });

    mockFail.get = false;
    for (const bad of [
      "{",
      "null",
      '"x"',
      '{"userId":1,"hasHelmet":true}',
      '{"userId":"u","hasHelmet":"yes"}',
    ]) {
      mockKv.set("helmet.launchMemory", bad);
      const c = load();
      await c.getState().hydrate();
      expect(c.getState().record).toBeNull();
    }
  });

  it("读盘还没回来时已经记了新的：不拿旧值盖回去", async () => {
    mockKv.set(
      "helmet.launchMemory",
      JSON.stringify({ userId: "u1", hasHelmet: false }),
    );
    let open!: () => void;
    mockGetGate = new Promise<void>((r) => {
      open = r;
    });
    const s = load();
    const reading = s.getState().hydrate();
    s.getState().remember("u1", true);
    open();
    await reading;
    expect(s.getState().record).toEqual({ userId: "u1", hasHelmet: true });
  });

  it("写失败不抛，本次运行里记着的仍然有效", async () => {
    mockFail.set = true;
    const s = load();
    expect(() => s.getState().remember("u1", true)).not.toThrow();
    await flush();
    expect(s.getState().record).toEqual({ userId: "u1", hasHelmet: true });
  });

  it("同样的内容不重复写；忘掉之后重开也没有了", async () => {
    const s = load();
    s.getState().remember("u1", true);
    await flush();
    mockKv.set("helmet.launchMemory", "sentinel");
    s.getState().remember("u1", true);
    await flush();
    expect(mockKv.get("helmet.launchMemory")).toBe("sentinel");

    s.getState().forget();
    await flush();
    expect(s.getState().record).toBeNull();
    expect(mockKv.has("helmet.launchMemory")).toBe(false);
  });
});
