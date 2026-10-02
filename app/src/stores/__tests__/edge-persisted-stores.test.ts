// 边界补测（2026-10-03）：落在 SecureStore 里的三份状态（会话 / 隐私同意 / 语言）在
// 存储损坏、读写抛错、存了不认识的值时的表现。此前 stores/ 下没有任何单测。
// 每个用例用 jest.isolateModules 取全新 store；SecureStore 用内存假件，可按 key 注入读写失败。
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { AuthResponse, UserProfile } from "@helmet/shared";

type AuthStore = typeof import("../auth-store");
type ConsentStore = typeof import("../consent-store");
type LocaleStore = typeof import("@/i18n/locale-store");
type Client = typeof import("@/api/client");

const mockKv = new Map<string, string>();
const mockFail = { get: false, set: false };
const mockSetOptions: unknown[] = [];
const mockMe = jest.fn(async (): Promise<UserProfile> => {
  throw new Error("offline");
});
const mockLogout = jest.fn(async (_refreshToken: string): Promise<void> => undefined);

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  getItemAsync: async (k: string) => {
    if (mockFail.get) throw new Error("keychain unavailable");
    return mockKv.get(k) ?? null;
  },
  setItemAsync: async (k: string, v: string, options?: unknown) => {
    if (mockFail.set) throw new Error("User interaction is not allowed");
    mockSetOptions.push(options);
    mockKv.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    mockKv.delete(k);
  },
}));
jest.mock("@/api/auth", () => ({
  authApi: {
    me: () => mockMe(),
    logout: (refreshToken: string) => mockLogout(refreshToken),
  },
}));

const TOKEN_KEY = "helmet.session.tokens";
const USER_KEY = "helmet.session.user";
const tokens = { accessToken: "acc", refreshToken: "ref" };
const user = (over: Partial<UserProfile> = {}): UserProfile =>
  ({
    id: "u1",
    phone: "13800001234",
    nickname: "骑手",
    avatarUrl: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...over,
  }) as UserProfile;
const AVATAR = `data:image/jpeg;base64,${"A".repeat(20_000)}`;

const loadAuth = (): { store: AuthStore["useAuthStore"]; client: Client } => {
  let mod!: AuthStore;
  let client!: Client;
  jest.isolateModules(() => {
    mod = require("../auth-store") as AuthStore;
    client = require("@/api/client") as Client;
  });
  return { store: mod.useAuthStore, client };
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  mockKv.clear();
  mockFail.get = false;
  mockFail.set = false;
  mockSetOptions.length = 0;
  mockMe.mockReset();
  mockMe.mockRejectedValue(new Error("offline"));
  mockLogout.mockReset();
  mockLogout.mockResolvedValue(undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("auth-store.hydrate：存储损坏", () => {
  it.each([
    ["token 是截断的 JSON", () => mockKv.set(TOKEN_KEY, '{"accessToken":"acc'), true],
    [
      "token 正常但用户档案是坏 JSON",
      () => {
        mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
        mockKv.set(USER_KEY, "{oops");
      },
      true,
    ],
    [
      "钥匙串读取直接抛错",
      () => {
        mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
        mockFail.get = true;
      },
      true,
    ],
    ["什么都没存（首次安装）", () => undefined, false],
  ] as [string, () => void, boolean][])(
    "%s → 按未登录处理且 hydrated=true（路由门控不卡死），不去拉 /users/me",
    async (_label, arrange) => {
      arrange();
      const { store } = loadAuth();
      await store.getState().hydrate();
      await flush();
      expect(store.getState()).toMatchObject({ hydrated: true, tokens: null, user: null });
      expect(mockMe).not.toHaveBeenCalled();
    },
  );

  it("只有 token、没有用户档案（上次档案落盘失败）：登录态成立，/users/me 回来后补上档案", async () => {
    mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
    mockMe.mockResolvedValue(user({ avatarUrl: AVATAR }));
    const { store } = loadAuth();
    await store.getState().hydrate();
    expect(store.getState().tokens).toEqual(tokens);
    await flush();
    expect(store.getState().user).toMatchObject({ id: "u1", avatarUrl: AVATAR });
  });

  it("/users/me 失败（离线冷启动）：保留钥匙串里的最小档案，不掉登录", async () => {
    mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
    mockKv.set(USER_KEY, JSON.stringify(user()));
    const { store } = loadAuth();
    await store.getState().hydrate();
    await flush();
    expect(mockMe).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ hydrated: true, tokens, user: { id: "u1" } });
  });
});

describe("auth-store：落盘内容", () => {
  it("signIn：内存里保留头像，钥匙串只存去掉头像的最小档案（iOS 单值 2KB 上限）且可在锁屏后读写", async () => {
    const { store } = loadAuth();
    const auth: AuthResponse = { ...tokens, user: user({ avatarUrl: AVATAR }) };
    await store.getState().signIn(auth);
    expect(store.getState().user?.avatarUrl).toBe(AVATAR);
    const saved = JSON.parse(mockKv.get(USER_KEY) ?? "{}") as UserProfile;
    expect(saved).toMatchObject({ id: "u1", avatarUrl: null });
    expect((mockKv.get(USER_KEY) ?? "").length).toBeLessThan(2048);
    expect(JSON.parse(mockKv.get(TOKEN_KEY) ?? "{}")).toEqual(tokens);
    expect(mockSetOptions).toEqual([
      { keychainAccessible: "AFTER_FIRST_UNLOCK" },
      { keychainAccessible: "AFTER_FIRST_UNLOCK" },
    ]);
  });

  it("setUser（改昵称 / 换头像）同样不把头像写进钥匙串，也不动 token", async () => {
    const { store } = loadAuth();
    await store.getState().signIn({ ...tokens, user: user() });
    await store.getState().setUser(user({ nickname: "新名字", avatarUrl: AVATAR }));
    expect(store.getState().user).toMatchObject({ nickname: "新名字", avatarUrl: AVATAR });
    expect(JSON.parse(mockKv.get(USER_KEY) ?? "{}")).toMatchObject({
      nickname: "新名字",
      avatarUrl: null,
    });
    expect(JSON.parse(mockKv.get(TOKEN_KEY) ?? "{}")).toEqual(tokens);
  });
});

describe("auth-store：登出", () => {
  it("signOut 时服务端作废失败（离线）：本地照样清干净；作废请求带的是当时的 refresh token", async () => {
    mockLogout.mockRejectedValue(new Error("offline"));
    const { store } = loadAuth();
    await store.getState().signIn({ ...tokens, user: user() });
    await expect(store.getState().signOut()).resolves.toBeUndefined();
    expect(mockLogout).toHaveBeenCalledWith("ref");
    expect(store.getState()).toMatchObject({ tokens: null, user: null });
    expect(mockKv.has(TOKEN_KEY)).toBe(false);
    expect(mockKv.has(USER_KEY)).toBe(false);
  });

  it("本来就没登录时 signOut：不调服务端；dropSession（账号已注销）也不调", async () => {
    const { store } = loadAuth();
    await store.getState().signOut();
    await store.getState().signIn({ ...tokens, user: user() });
    await store.getState().dropSession();
    expect(mockLogout).not.toHaveBeenCalled();
    expect(store.getState().tokens).toBeNull();
  });
});

describe("auth-store 与 api 客户端的接线", () => {
  const res = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const originalFetch = (globalThis as { fetch: unknown }).fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  it("401 静默刷新后，新 token 同时进内存与钥匙串（冷启动不会拿旧 refresh token 被判盗用）", async () => {
    const { store, client } = loadAuth();
    await store.getState().signIn({ ...tokens, user: user() });
    (globalThis as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url.endsWith("/auth/refresh"))
          return res(200, { accessToken: "acc2", refreshToken: "ref2" });
        return init?.headers?.Authorization === "Bearer acc2"
          ? res(200, { ok: true })
          : res(401, { code: "UNAUTHORIZED" });
      },
    );
    await expect(client.api("/devices")).resolves.toEqual({ ok: true });
    const next = { accessToken: "acc2", refreshToken: "ref2" };
    expect(store.getState().tokens).toEqual(next);
    expect(JSON.parse(mockKv.get(TOKEN_KEY) ?? "{}")).toEqual(next);
    expect(store.getState().user?.id).toBe("u1");
  });

  it("refresh token 被服务端否定：内存与钥匙串里的会话一并清掉", async () => {
    const { store, client } = loadAuth();
    await store.getState().signIn({ ...tokens, user: user() });
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () =>
      res(401, { code: "UNAUTHORIZED" }),
    );
    await expect(client.api("/devices")).rejects.toMatchObject({ status: 401 });
    expect(store.getState()).toMatchObject({ tokens: null, user: null });
    expect(mockKv.size).toBe(0);
  });
});

describe("consent-store：同意标记带版本", () => {
  const KEY = "helmet.privacy.accepted";
  const loadConsent = (): ConsentStore => {
    let mod!: ConsentStore;
    jest.isolateModules(() => {
      mod = require("../consent-store") as ConsentStore;
    });
    return mod;
  };

  it("存的是旧版政策的版本号 / 空串 / 随便什么值：都算未同意，要重新征求", async () => {
    for (const saved of ["2026-09-11", "", "true", "1"]) {
      mockKv.set(KEY, saved);
      const { useConsentStore } = loadConsent();
      await useConsentStore.getState().hydrate();
      expect(useConsentStore.getState()).toMatchObject({ hydrated: true, privacyAccepted: false });
    }
  });

  it("存的正是当前版本号：已同意", async () => {
    const mod = loadConsent();
    mockKv.set(KEY, mod.PRIVACY_VERSION);
    await mod.useConsentStore.getState().hydrate();
    expect(mod.useConsentStore.getState().privacyAccepted).toBe(true);
  });

  it("读取抛错按未同意（宁可多问一次）；accept 落盘失败不抛，本次会话内视为已同意", async () => {
    mockFail.get = true;
    mockFail.set = true;
    const { useConsentStore } = loadConsent();
    await useConsentStore.getState().hydrate();
    expect(useConsentStore.getState()).toMatchObject({ hydrated: true, privacyAccepted: false });
    await expect(useConsentStore.getState().accept()).resolves.toBeUndefined();
    expect(useConsentStore.getState().privacyAccepted).toBe(true);
    expect(mockKv.has(KEY)).toBe(false);
  });
});

describe("locale-store", () => {
  const KEY = "helmet.locale";
  const loadLocale = (): LocaleStore => {
    let mod!: LocaleStore;
    jest.isolateModules(() => {
      mod = require("@/i18n/locale-store") as LocaleStore;
    });
    return mod;
  };
  const withSystemLocale = (tag: string | undefined): void => {
    jest.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () =>
        ({
          resolvedOptions: () => ({ locale: tag }),
        }) as unknown as Intl.DateTimeFormat,
    );
  };

  it.each([
    ["en-US", "en"],
    ["en-GB", "en"],
    ["EN", "en"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-CN", "zh-TW"],
    ["zh-CN", "zh-CN"],
    ["zh-Hans-HK", "zh-CN"],
    ["zh", "zh-CN"],
    ["ja-JP", "zh-CN"],
    [undefined, "zh-CN"],
  ])("系统语言 %s → %s", (tag, expected) => {
    withSystemLocale(tag);
    expect(loadLocale().detectLocale()).toBe(expected);
  });

  it("Intl 不可用（抛错）时按简体，不让 App 崩在启动路径上", () => {
    jest.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("Intl unavailable");
    });
    expect(loadLocale().detectLocale()).toBe("zh-CN");
  });

  it("钥匙串里存的是不支持的语言（降级安装 / 被改坏）：忽略，保持系统语言；合法值才采用", async () => {
    withSystemLocale("en-US");
    mockKv.set(KEY, "fr");
    const a = loadLocale().useLocaleStore;
    await a.getState().hydrate();
    expect(a.getState()).toMatchObject({ locale: "en", hydrated: true });
    mockKv.set(KEY, "zh-TW");
    const b = loadLocale().useLocaleStore;
    await b.getState().hydrate();
    expect(b.getState()).toMatchObject({ locale: "zh-TW", hydrated: true });
  });

  it("钥匙串读取抛错：仍然 hydrated=true，语言跟系统走", async () => {
    withSystemLocale("zh-HK");
    mockFail.get = true;
    const { useLocaleStore } = loadLocale();
    await useLocaleStore.getState().hydrate();
    expect(useLocaleStore.getState()).toMatchObject({ locale: "zh-TW", hydrated: true });
  });
});
