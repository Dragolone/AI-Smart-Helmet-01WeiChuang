// 锁屏下被 BLE 状态恢复拉起的进程（2026-10-17 评审）：语言 / 外观 / 当前头盔三份设置原来用钥匙串默认的
// WHEN_UNLOCKED，锁屏时读不出，落回默认值后整个进程不再读——语言变系统语言、外观变深色、当前头盔变「没选过」
// （App 内求救可能记到另一顶名下）。这里钉住：新写入用 AFTER_FIRST_UNLOCK 的新条目、旧条目搬一次、
// 读失败不定死（回到前台再读）、重读回来时用户已经改过就以用户的为准。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type ThemeStore = typeof import("../theme-store");
type LocaleStore = typeof import("@/i18n/locale-store");
type HelmetStore = typeof import("../current-helmet-store");

const mockKv = new Map<string, string>();
const mockFail = { get: false };
const mockWrites: { key: string; value: string; options: unknown }[] = [];
/** 「回到前台再读」登记的回调：用例里调它 = 用户解锁打开了 App */
const mockRetries = new Map<string, () => void>();
const mockRetryCalls: string[] = [];

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  getItemAsync: async (k: string) => {
    if (mockFail.get) throw new Error("User interaction is not allowed");
    return mockKv.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string, options?: unknown) => {
    mockWrites.push({ key: k, value: v, options });
    mockKv.set(k, v);
  },
}));
jest.mock("@/services/retry-when-active", () => ({
  retryWhenActive: (key: string, retry: () => void) => {
    mockRetryCalls.push(key);
    mockRetries.set(key, retry);
  },
}));
jest.mock("react-native", () => {
  const actual = jest.requireActual<object>("react-native");
  const appearance = { setColorScheme: () => undefined };
  return new Proxy(actual, {
    get: (target, prop, receiver) =>
      prop === "Appearance" ? appearance : Reflect.get(target, prop, receiver),
  });
});

const fresh = <T>(path: string): T => {
  let mod!: T;
  jest.isolateModules(() => {
    mod = jest.requireActual<T>(path);
  });
  return mod;
};
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
/** 用户解锁、打开 App */
const foreground = async (key: string) => {
  const retry = mockRetries.get(key);
  mockRetries.delete(key);
  retry?.();
  await flush();
};
const AFU = { keychainAccessible: "AFTER_FIRST_UNLOCK" };

beforeEach(() => {
  mockKv.clear();
  mockFail.get = false;
  mockWrites.length = 0;
  mockRetries.clear();
  mockRetryCalls.length = 0;
});

describe("外观", () => {
  const load = () => fresh<ThemeStore>("../theme-store").useThemeStore;

  it("改外观写的是锁屏可读的新条目", async () => {
    const store = load();
    await store.getState().setMode("light");
    expect(mockWrites).toEqual([
      { key: "helmet.theme.v2", value: "light", options: AFU },
    ]);
  });

  it("升级前存的旧条目：读出来用，并搬一份到新条目；之后读新条目", async () => {
    mockKv.set("helmet.theme", "light");
    const store = load();
    await store.getState().hydrate();
    await flush();
    expect(store.getState()).toMatchObject({ mode: "light", hydrated: true });
    expect(mockWrites).toEqual([
      { key: "helmet.theme.v2", value: "light", options: AFU },
    ]);
    mockKv.set("helmet.theme", "system"); // 旧条目不再被看
    const next = load();
    await next.getState().hydrate();
    expect(next.getState().mode).toBe("light");
  });

  it("锁屏下读不出来：先按默认挂上界面（hydrated 为真），回到前台再读就换成存的", async () => {
    mockKv.set("helmet.theme.v2", "light");
    mockFail.get = true;
    const store = load();
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ mode: "dark", hydrated: true });
    expect(mockRetryCalls).toEqual(["theme"]);
    mockFail.get = false;
    await foreground("theme");
    expect(store.getState().mode).toBe("light");
  });

  it("重读回来之前用户已经改过：不拿存的旧值盖回去", async () => {
    mockKv.set("helmet.theme.v2", "light");
    mockFail.get = true;
    const store = load();
    await store.getState().hydrate();
    mockFail.get = false;
    await store.getState().setMode("system");
    mockKv.set("helmet.theme.v2", "light"); // 假装写盘慢了一步
    await foreground("theme");
    expect(store.getState().mode).toBe("system");
  });
});

describe("语言", () => {
  const load = () =>
    fresh<LocaleStore>("@/i18n/locale-store").useLocaleStore;

  it("改语言写的是锁屏可读的新条目；旧条目读出来用并搬过去", async () => {
    mockKv.set("helmet.locale", "zh-TW");
    const store = load();
    await store.getState().hydrate();
    await flush();
    expect(store.getState().locale).toBe("zh-TW");
    expect(mockWrites).toEqual([
      { key: "helmet.locale.v2", value: "zh-TW", options: AFU },
    ]);
    await store.getState().setLocale("en");
    expect(mockWrites.at(-1)).toEqual({
      key: "helmet.locale.v2",
      value: "en",
      options: AFU,
    });
  });

  it("锁屏下读不出来：先按系统语言挂上，回到前台读到存的就换过去；还读不出就再等下一次", async () => {
    mockKv.set("helmet.locale.v2", "en");
    mockFail.get = true;
    const store = load();
    const system = store.getState().locale;
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ locale: system, hydrated: true });
    // 还锁着：又失败一次，再登记一次重读
    await foreground("locale");
    expect(store.getState().locale).toBe(system);
    expect(mockRetryCalls).toEqual(["locale", "locale"]);
    mockFail.get = false;
    await foreground("locale");
    expect(store.getState().locale).toBe("en");
  });
});

describe("当前头盔", () => {
  const load = () =>
    fresh<HelmetStore>("../current-helmet-store").useCurrentHelmetStore;

  it("设为当前写的是锁屏可读的新条目；旧条目读出来用并搬过去", async () => {
    mockKv.set("helmet.currentHelmet.u1", "helmet_a");
    const store = load();
    await store.getState().load("u1");
    await flush();
    expect(store.getState().chosen.u1).toBe("helmet_a");
    expect(mockWrites).toEqual([
      { key: "helmet.currentHelmet.v2.u1", value: "helmet_a", options: AFU },
    ]);
    store.getState().choose("u1", "helmet_b");
    await flush();
    expect(mockWrites.at(-1)).toEqual({
      key: "helmet.currentHelmet.v2.u1",
      value: "helmet_b",
      options: AFU,
    });
  });

  it("锁屏下读不出来：先按没选过（页面不干等），回到前台读到存的那顶就换过去", async () => {
    mockKv.set("helmet.currentHelmet.v2.u1", "helmet_b");
    mockFail.get = true;
    const store = load();
    await store.getState().load("u1");
    expect(store.getState().chosen.u1).toBeNull();
    mockFail.get = false;
    await foreground("currentHelmet");
    expect(store.getState().chosen.u1).toBe("helmet_b");
  });

  it("读失败期间用户点了设为当前：回到前台的重读不把它盖回去", async () => {
    mockKv.set("helmet.currentHelmet.v2.u1", "helmet_b");
    mockFail.get = true;
    const store = load();
    await store.getState().load("u1");
    store.getState().choose("u1", "helmet_c");
    mockFail.get = false;
    mockKv.set("helmet.currentHelmet.v2.u1", "helmet_b");
    await foreground("currentHelmet");
    expect(store.getState().chosen.u1).toBe("helmet_c");
  });

  it("注销账号要删的条目：新旧两条都在里面", () => {
    const { currentHelmetKeysOf } = fresh<HelmetStore>(
      "../current-helmet-store",
    );
    expect(currentHelmetKeysOf("u1")).toEqual([
      "helmet.currentHelmet.v2.u1",
      "helmet.currentHelmet.u1",
    ]);
  });
});
