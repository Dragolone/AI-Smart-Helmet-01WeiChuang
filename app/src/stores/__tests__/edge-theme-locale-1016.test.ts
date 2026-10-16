// 外观 / 语言两份设置的落盘边界（2026-10-16）：写失败不抛（调用方是 `void setMode(m)`，抛出去就是没人接的
// Promise 拒绝）、读盘期间用户已经改过时迟到的旧值不盖回去、存了不认识的值按默认。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

type ThemeStore = typeof import("../theme-store");
type LocaleStore = typeof import("@/i18n/locale-store");

const mockKv = new Map<string, string>();
const mockFail = { get: false, set: false };
const mockGate: { release: (() => void) | null } = { release: null };
const mockSetScheme = jest.fn((_s: string) => undefined);

jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => {
    if (mockFail.get) throw new Error("keychain");
    // 先取值再等：模拟「读到的是旧值，只是回来得晚」
    const value = mockKv.get(k) ?? null;
    if (mockGate.release !== null) {
      await new Promise<void>((r) => {
        const prev = mockGate.release!;
        mockGate.release = () => {
          prev();
          r();
        };
      });
    }
    return value;
  },
  setItemAsync: async (k: string, v: string) => {
    if (mockFail.set) throw new Error("User interaction is not allowed");
    mockKv.set(k, v);
  },
}));
// 只换掉 Appearance，其余照用真的 react-native（jest-expo 的初始化要用到 Platform 等）
jest.mock("react-native", () => {
  const actual = jest.requireActual<object>("react-native");
  const appearance = { setColorScheme: (s: string) => mockSetScheme(s) };
  return new Proxy(actual, {
    get: (target, prop, receiver) =>
      prop === "Appearance" ? appearance : Reflect.get(target, prop, receiver),
  });
});

const loadTheme = () => {
  let mod!: ThemeStore;
  jest.isolateModules(() => {
    mod = jest.requireActual<ThemeStore>("../theme-store");
  });
  return mod.useThemeStore;
};
const loadLocale = () => {
  let mod!: LocaleStore;
  jest.isolateModules(() => {
    mod = jest.requireActual<LocaleStore>("@/i18n/locale-store");
  });
  return mod.useLocaleStore;
};
/** 让 getItemAsync 挂住，直到调用返回的函数 */
const holdReads = (): (() => void) => {
  mockGate.release = () => undefined;
  return () => {
    const r = mockGate.release!;
    mockGate.release = null;
    r();
  };
};
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  mockKv.clear();
  mockFail.get = false;
  mockFail.set = false;
  mockGate.release = null;
  mockSetScheme.mockClear();
});

describe("外观设置", () => {
  it("默认深色；没存过时读完仍是深色，并把原生界面也设成深色", async () => {
    const store = loadTheme();
    expect(store.getState().mode).toBe("dark");
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ mode: "dark", hydrated: true });
    expect(mockSetScheme).toHaveBeenLastCalledWith("dark");
  });

  it("跟随系统：原生界面设成 unspecified", async () => {
    const store = loadTheme();
    await store.getState().setMode("system");
    expect(mockSetScheme).toHaveBeenLastCalledWith("unspecified");
    // 写的是锁屏可读的新条目（2026-10-17），旧条目不再写
    expect(mockKv.get("helmet.theme.v2")).toBe("system");
    expect(mockKv.has("helmet.theme")).toBe(false);
  });

  it("存了不认识的值 / 空串 / 读失败：按默认深色，hydrated 照样为真", async () => {
    for (const bad of ["purple", "", "DARK"]) {
      mockKv.set("helmet.theme", bad);
      const store = loadTheme();
      await store.getState().hydrate();
      expect(store.getState()).toMatchObject({ mode: "dark", hydrated: true });
    }
    mockFail.get = true;
    const store = loadTheme();
    await store.getState().hydrate();
    expect(store.getState()).toMatchObject({ mode: "dark", hydrated: true });
  });

  // 原来 setItemAsync 抛错会让 setMode 拒绝，页面上 `void setThemeMode(m)` 没人接
  it("落盘失败：不抛，本次运行照样换过去", async () => {
    mockFail.set = true;
    const store = loadTheme();
    await expect(store.getState().setMode("light")).resolves.toBeUndefined();
    expect(store.getState().mode).toBe("light");
    expect(mockSetScheme).toHaveBeenLastCalledWith("light");
  });

  it("读盘还没回来用户就改了：迟到的旧值不把它盖回去", async () => {
    mockKv.set("helmet.theme", "light");
    const release = holdReads();
    const store = loadTheme();
    const hydrating = store.getState().hydrate();
    await flush();
    await store.getState().setMode("system");
    release();
    await hydrating;
    expect(store.getState()).toMatchObject({ mode: "system", hydrated: true });
  });
});

describe("语言设置", () => {
  it("落盘失败：不抛，本次运行照样换过去", async () => {
    mockFail.set = true;
    const store = loadLocale();
    await expect(store.getState().setLocale("en")).resolves.toBeUndefined();
    expect(store.getState().locale).toBe("en");
  });

  it("读盘还没回来用户就改了：迟到的旧值不把它盖回去", async () => {
    mockKv.set("helmet.locale", "zh-TW");
    const release = holdReads();
    const store = loadLocale();
    const hydrating = store.getState().hydrate();
    await flush();
    await store.getState().setLocale("en");
    release();
    await hydrating;
    expect(store.getState()).toMatchObject({ locale: "en", hydrated: true });
  });

  it("存的是合法值：读出来就用；存了大小写不对的写法不认", async () => {
    mockKv.set("helmet.locale", "zh-TW");
    const a = loadLocale();
    await a.getState().hydrate();
    expect(a.getState().locale).toBe("zh-TW");
    // 上面那次读顺手搬到了新条目：清掉再试一遍不认的写法
    mockKv.clear();
    mockKv.set("helmet.locale", "ZH-tw");
    const b = loadLocale();
    const before = b.getState().locale;
    await b.getState().hydrate();
    expect(b.getState().locale).toBe(before);
  });
});
