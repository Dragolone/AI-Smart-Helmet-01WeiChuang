// BLE 链路目标的来源：查询缓存「没有数据」与「一台都没绑」必须分开；上次的目标按账号落盘，
// 冷启动拉不到列表时用它把链路拉起来；拉失败退避重试到成功为止。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { QueryClient } from "@tanstack/react-query";

const mockKv = new Map<string, string>();
const mockFail = { get: false, set: false };
const mockSetCalls: [string, string, unknown][] = [];

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  getItemAsync: async (k: string) => {
    if (mockFail.get) throw new Error("keychain unavailable");
    return mockKv.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string, options?: unknown) => {
    if (mockFail.set) throw new Error("User interaction is not allowed");
    mockSetCalls.push([k, v, options]);
    mockKv.set(k, v);
  },
}));

import {
  __resetBleTargetsForTests,
  DEVICES_RETRY_DELAYS_MS,
  liveTargets,
  loadCachedTargets,
  loadWithRetry,
  saveCachedTargets,
} from "../ble-targets";

const KEY = "helmet.ble.targets.u1";

beforeEach(() => {
  mockKv.clear();
  mockFail.get = false;
  mockFail.set = false;
  mockSetCalls.length = 0;
  __resetBleTargetsForTests();
});

describe("liveTargets", () => {
  it("还没拉到 / 拉失败（缓存里没有数据）→ null，不是空数组：一次失败的拉取不能把连着的头盔当成已解绑", () => {
    const qc = new QueryClient();
    expect(liveTargets(qc)).toBeNull();
    qc.setQueryData(["devices"], []);
    expect(liveTargets(qc)).toEqual([]); // 明确一台都没绑
    qc.setQueryData(["devices"], [{ deviceId: "h1" }, { deviceId: "h2" }]);
    expect(liveTargets(qc)).toEqual(["h1", "h2"]);
    qc.clear();
  });
});

describe("目标落盘（按账号）", () => {
  it("存了能读回；写的是锁屏可读的条目（BLE 事件在锁屏下拉起进程时也要读得到）", async () => {
    await saveCachedTargets("u1", ["h1", "h2"]);
    expect(mockSetCalls).toEqual([
      [KEY, '["h1","h2"]', { keychainAccessible: "AFTER_FIRST_UNLOCK" }],
    ]);
    expect(await loadCachedTargets("u1")).toEqual(["h1", "h2"]);
  });

  it("各账号各存各的：换账号读不到上一个账号的头盔", async () => {
    await saveCachedTargets("u1", ["h1"]);
    await saveCachedTargets("u2", ["h9"]);
    expect(await loadCachedTargets("u1")).toEqual(["h1"]);
    expect(await loadCachedTargets("u2")).toEqual(["h9"]);
    expect(await loadCachedTargets("u3")).toEqual([]);
  });

  it("内容没变不重复写（设备列表 30 s 轮询一次）；变了才写；解绑到一台不剩也要写下空列表", async () => {
    await saveCachedTargets("u1", ["h1"]);
    await saveCachedTargets("u1", ["h1"]);
    expect(mockSetCalls).toHaveLength(1);
    await saveCachedTargets("u1", ["h1", "h2"]);
    await saveCachedTargets("u1", []);
    expect(mockSetCalls).toHaveLength(3);
    expect(await loadCachedTargets("u1")).toEqual([]);
  });

  it("写失败不抛，下次同样的内容还会再写", async () => {
    mockFail.set = true;
    await expect(saveCachedTargets("u1", ["h1"])).resolves.toBeUndefined();
    mockFail.set = false;
    await saveCachedTargets("u1", ["h1"]);
    expect(await loadCachedTargets("u1")).toEqual(["h1"]);
  });

  it("没有用户 ID（档案还没回来）：不读不写", async () => {
    await saveCachedTargets(undefined, ["h1"]);
    expect(mockSetCalls).toHaveLength(0);
    expect(await loadCachedTargets(undefined)).toEqual([]);
  });

  it.each([
    ["读取抛错", () => (mockFail.get = true)],
    ["截断的 JSON", () => mockKv.set(KEY, '["h1",')],
    ["不是数组", () => mockKv.set(KEY, '{"h1":true}')],
    ["空串", () => mockKv.set(KEY, "")],
  ])("存储损坏（%s）：按没有处理，不抛", async (_name, corrupt) => {
    corrupt();
    await expect(loadCachedTargets("u1")).resolves.toEqual([]);
  });

  it("数组里混进了不是字符串的东西：只留合法的 deviceId；去重；超过上限截断", async () => {
    mockKv.set(KEY, JSON.stringify(["h1", 2, null, "", "h2"]));
    expect(await loadCachedTargets("u1")).toEqual(["h1", "h2"]);
    __resetBleTargetsForTests();
    await saveCachedTargets("u1", ["a", "a", "b"]);
    expect(await loadCachedTargets("u1")).toEqual(["a", "b"]);
    await saveCachedTargets(
      "u1",
      Array.from({ length: 50 }, (_, i) => `h${i}`),
    );
    expect(await loadCachedTargets("u1")).toHaveLength(20);
  });

  it("用户 ID 里有钥匙串不允许的字符：换成下划线，不抛", async () => {
    await saveCachedTargets("u/1:x", ["h1"]);
    expect(mockSetCalls[0][0]).toBe("helmet.ble.targets.u_1_x");
    expect(await loadCachedTargets("u/1:x")).toEqual(["h1"]);
  });
});

describe("loadWithRetry（设备列表拉失败要一直重试到成功）", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("第一次就成功：不再重试；firstAttempt 兑现", async () => {
    const load = jest.fn(async () => "ok");
    const r = loadWithRetry(load);
    await expect(r.firstAttempt).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("失败：firstAttempt 照样兑现（冷启动的后续动作不能卡住）；按 5/15/30/60 s 重试，之后一直 60 s，成功即停", async () => {
    let ok = false;
    const load = jest.fn(async () => {
      if (!ok) throw new Error("offline");
      return "ok";
    });
    const r = loadWithRetry(load);
    await expect(r.firstAttempt).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
    for (const [i, delay] of DEVICES_RETRY_DELAYS_MS.entries()) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(load).toHaveBeenCalledTimes(i + 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(load).toHaveBeenCalledTimes(i + 2);
    }
    // 重试档位用完后不放弃
    await jest.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(6);
    ok = true; // 出了车库
    await jest.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(7);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(load).toHaveBeenCalledTimes(7);
  });

  it("cancel（登出）：等待中的重试作废；在途的那次失败回来后也不再排下一次", async () => {
    let rejectLoad!: (e: Error) => void;
    const load = jest.fn(
      () => new Promise<never>((_r, reject) => (rejectLoad = reject)),
    );
    const r = loadWithRetry(load);
    r.cancel();
    rejectLoad(new Error("offline"));
    await r.firstAttempt;
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(load).toHaveBeenCalledTimes(1);

    const failing = jest.fn(async () => {
      throw new Error("offline");
    });
    const r2 = loadWithRetry(failing);
    await r2.firstAttempt;
    r2.cancel(); // 5 s 的重试已排上
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
