// 对讲的跨页面状态：「对讲中」小条看的 session，以及「一直开麦」的说明看过没有（按账号存）。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type Store = typeof import("../intercom-store");

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

const load = (): Store["useIntercomStore"] => {
  let mod!: Store;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../intercom-store") as Store;
  });
  return mod.useIntercomStore;
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

describe("session：别的标签页上的「对讲中」小条", () => {
  it("不在房间里时没有 session；进房后有，离开后清掉", () => {
    const store = load();
    expect(store.getState().session).toBeNull();
    store.getState().setSession({
      channelId: "c1",
      channelName: "周末骑行队",
      micOpen: true,
      reconnecting: false,
    });
    expect(store.getState().session?.channelName).toBe("周末骑行队");
    store.getState().setSession(null);
    expect(store.getState().session).toBeNull();
  });
});

describe("「一直开麦」的说明看过没有", () => {
  it("没读到之前没有结论；没存过 = 没看过", async () => {
    const store = load();
    expect(store.getState().openMicSeen.u1).toBeUndefined();
    await store.getState().loadOpenMicSeen("u1");
    expect(store.getState().openMicSeen.u1).toBe(false);
  });

  it("确认过一次：立刻生效并落盘，重开 App 不再问；按账号分开", async () => {
    const store = load();
    await store.getState().loadOpenMicSeen("u1");
    store.getState().markOpenMicSeen("u1");
    expect(store.getState().openMicSeen.u1).toBe(true);
    await flush();

    const next = load();
    await next.getState().loadOpenMicSeen("u1");
    await next.getState().loadOpenMicSeen("u2");
    expect(next.getState().openMicSeen.u1).toBe(true);
    expect(next.getState().openMicSeen.u2).toBe(false);
  });

  it("读盘还没回来用户就确认了：迟到的「没看过」不把它改回去", async () => {
    let release!: () => void;
    mockGetGate = new Promise<void>((r) => {
      release = r;
    });
    const store = load();
    const loading = store.getState().loadOpenMicSeen("u1");
    store.getState().markOpenMicSeen("u1");
    release();
    await loading;
    expect(store.getState().openMicSeen.u1).toBe(true);
  });

  it("读不出来按没看过处理、落盘失败不抛", async () => {
    mockFail.get = true;
    mockFail.set = true;
    const store = load();
    await expect(
      store.getState().loadOpenMicSeen("u1"),
    ).resolves.toBeUndefined();
    expect(store.getState().openMicSeen.u1).toBe(false);
    expect(() => store.getState().markOpenMicSeen("u1")).not.toThrow();
    await flush();
    expect(store.getState().openMicSeen.u1).toBe(true);
  });
});
