// 边界补测（2026-10-03）：落在 SecureStore 里的三份状态（会话 / 隐私同意 / 语言）在
// 存储损坏、读写抛错、存了不认识的值时的表现。此前 stores/ 下没有任何单测。
// 每个用例用 jest.isolateModules 取全新 store；SecureStore 用内存假件，可按 key 注入读写失败。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
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
const mockLogout = jest.fn(
  async (_refreshToken: string): Promise<void> => undefined,
);

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
    [
      "token 是截断的 JSON",
      () => mockKv.set(TOKEN_KEY, '{"accessToken":"acc'),
      true,
    ],
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
      expect(store.getState()).toMatchObject({
        hydrated: true,
        tokens: null,
        user: null,
      });
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
    expect(store.getState().user).toMatchObject({
      id: "u1",
      avatarUrl: AVATAR,
    });
  });

  it("/users/me 失败（离线冷启动）：保留钥匙串里的最小档案，不掉登录", async () => {
    mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
    mockKv.set(USER_KEY, JSON.stringify(user()));
    const { store } = loadAuth();
    await store.getState().hydrate();
    await flush();
    expect(mockMe).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      hydrated: true,
      tokens,
      user: { id: "u1" },
    });
  });

  it("/users/me 在途时登出并登录了另一个账号：迟到的旧档案不落到新会话上（token 是 B 的、user 也得是 B 的）", async () => {
    mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
    mockKv.set(USER_KEY, JSON.stringify(user()));
    let landMe!: (u: UserProfile) => void;
    mockMe.mockImplementation(
      () =>
        new Promise<UserProfile>((resolve) => {
          landMe = resolve;
        }),
    );
    const { store } = loadAuth();
    await store.getState().hydrate();
    await store.getState().signOut();
    const b: AuthResponse = {
      accessToken: "acc_b",
      refreshToken: "ref_b",
      user: user({ id: "u2", phone: "13900005678" }),
    };
    await store.getState().signIn(b);
    landMe(user({ avatarUrl: AVATAR }));
    await flush();
    expect(store.getState().tokens).toEqual({
      accessToken: "acc_b",
      refreshToken: "ref_b",
    });
    expect(store.getState().user).toMatchObject({
      id: "u2",
      phone: "13900005678",
    });
  });

  it("/users/me 在途时登出：迟到的档案不会给已登出的状态凭空写出一个 user", async () => {
    mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
    mockKv.set(USER_KEY, JSON.stringify(user()));
    let landMe!: (u: UserProfile) => void;
    mockMe.mockImplementation(
      () =>
        new Promise<UserProfile>((resolve) => {
          landMe = resolve;
        }),
    );
    const { store } = loadAuth();
    await store.getState().hydrate();
    await store.getState().signOut();
    landMe(user({ avatarUrl: AVATAR }));
    await flush();
    expect(store.getState()).toMatchObject({ tokens: null, user: null });
  });

  it("/users/me 在途时同一账号重新登录：档案照常补上", async () => {
    mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
    mockKv.set(USER_KEY, JSON.stringify(user()));
    let landMe!: (u: UserProfile) => void;
    mockMe.mockImplementation(
      () =>
        new Promise<UserProfile>((resolve) => {
          landMe = resolve;
        }),
    );
    const { store } = loadAuth();
    await store.getState().hydrate();
    await store.getState().signOut();
    await store
      .getState()
      .signIn({ accessToken: "acc_2", refreshToken: "ref_2", user: user() });
    landMe(user({ avatarUrl: AVATAR }));
    await flush();
    expect(store.getState().user).toMatchObject({
      id: "u1",
      avatarUrl: AVATAR,
    });
  });
});

describe("auth-store.refreshUser：别处改过的档案要能拉回来（10-16）", () => {
  it("已登录：拉回新档案并落盘", async () => {
    mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
    mockKv.set(USER_KEY, JSON.stringify(user({ nickname: "   " })));
    const { store } = loadAuth();
    await store.getState().hydrate();
    await flush();
    mockMe.mockResolvedValue(user({ nickname: "新名字" }));
    await store.getState().refreshUser();
    expect(store.getState().user?.nickname).toBe("新名字");
    expect(JSON.parse(mockKv.get(USER_KEY) ?? "{}").nickname).toBe("新名字");
  });

  it("没登录：不发请求", async () => {
    const { store } = loadAuth();
    await store.getState().hydrate();
    mockMe.mockClear();
    await store.getState().refreshUser();
    expect(mockMe).not.toHaveBeenCalled();
  });

  it("拉取失败：静默，保留原档案", async () => {
    mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
    mockKv.set(USER_KEY, JSON.stringify(user()));
    const { store } = loadAuth();
    await store.getState().hydrate();
    await flush();
    mockMe.mockRejectedValue(new Error("offline"));
    await expect(store.getState().refreshUser()).resolves.toBeUndefined();
    expect(store.getState().user?.nickname).toBe("骑手");
  });

  it("请求在途时换成另一个账号：迟到的旧账号档案不落", async () => {
    mockKv.set(TOKEN_KEY, JSON.stringify(tokens));
    mockKv.set(USER_KEY, JSON.stringify(user()));
    const { store } = loadAuth();
    await store.getState().hydrate();
    await flush();
    let landMe!: (u: UserProfile) => void;
    mockMe.mockImplementation(
      () =>
        new Promise<UserProfile>((resolve) => {
          landMe = resolve;
        }),
    );
    const pending = store.getState().refreshUser();
    await store.getState().signIn({
      accessToken: "acc_b",
      refreshToken: "ref_b",
      user: user({ id: "u2", nickname: "另一个" }),
    } as AuthResponse);
    landMe(user({ nickname: "旧账号" }));
    await pending;
    expect(store.getState().user).toMatchObject({
      id: "u2",
      nickname: "另一个",
    });
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
    await store
      .getState()
      .setUser(user({ nickname: "新名字", avatarUrl: AVATAR }));
    expect(store.getState().user).toMatchObject({
      nickname: "新名字",
      avatarUrl: AVATAR,
    });
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

  it("作废请求挂起（服务端连不上、要等超时）时 signOut 也立刻完成、本地已清空（10-16 第二轮：原来要等约 19 秒）", async () => {
    mockLogout.mockImplementation(() => new Promise<void>(() => undefined));
    const { store } = loadAuth();
    await store.getState().signIn({ ...tokens, user: user() });
    await expect(store.getState().signOut()).resolves.toBeUndefined();
    expect(mockLogout).toHaveBeenCalledWith("ref");
    expect(store.getState()).toMatchObject({ tokens: null, user: null });
    expect(mockKv.has(TOKEN_KEY)).toBe(false);
    expect(mockKv.has(USER_KEY)).toBe(false);
  });

  it("作废请求同步抛错也不拦住本地登出", async () => {
    mockLogout.mockImplementation(() => {
      throw new Error("boom");
    });
    const { store } = loadAuth();
    await store.getState().signIn({ ...tokens, user: user() });
    await expect(store.getState().signOut()).resolves.toBeUndefined();
    expect(store.getState().tokens).toBeNull();
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

describe("auth-store：被动登出要留下原因（BLE 中转随登录态停掉，不能静默）", () => {
  const res = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const originalFetch = (globalThis as { fetch: unknown }).fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
  });

  it("refresh 被服务端否定 → sessionExpired；重新登录即清", async () => {
    const { store, client } = loadAuth();
    await store.getState().signIn({ ...tokens, user: user() });
    expect(store.getState().sessionExpired).toBe(false);
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () =>
      res(401, { code: "UNAUTHORIZED" }),
    );
    await expect(client.api("/devices")).rejects.toMatchObject({ status: 401 });
    expect(store.getState()).toMatchObject({
      tokens: null,
      sessionExpired: true,
    });
    await store.getState().signIn({ ...tokens, user: user() });
    expect(store.getState().sessionExpired).toBe(false);
  });

  it("用户自己退出 / 注销账号不算；本来就没登录时收到 401 也不算", async () => {
    const { store, client } = loadAuth();
    await store.getState().signIn({ ...tokens, user: user() });
    await store.getState().signOut();
    expect(store.getState().sessionExpired).toBe(false);
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () =>
      res(401, { code: "UNAUTHORIZED" }),
    );
    await expect(client.api("/devices")).rejects.toMatchObject({ status: 401 });
    expect(store.getState().sessionExpired).toBe(false);
  });

  it("被动登出后用户又点了一次退出（dropSession）：标记清掉", async () => {
    const { store, client } = loadAuth();
    await store.getState().signIn({ ...tokens, user: user() });
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () =>
      res(401, { code: "UNAUTHORIZED" }),
    );
    await expect(client.api("/devices")).rejects.toMatchObject({ status: 401 });
    await store.getState().dropSession();
    expect(store.getState().sessionExpired).toBe(false);
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
  /** 现行条目（首次解锁后可读）；旧条目没带可访问性选项，锁屏下读不到 */
  const KEY = "helmet.privacy.accepted.v2";
  const LEGACY_KEY = "helmet.privacy.accepted";
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
      expect(useConsentStore.getState()).toMatchObject({
        hydrated: true,
        privacyAccepted: false,
      });
    }
  });

  it("存的正是当前版本号：已同意", async () => {
    const mod = loadConsent();
    mockKv.set(KEY, mod.PRIVACY_VERSION);
    await mod.useConsentStore.getState().hydrate();
    expect(mod.useConsentStore.getState().privacyAccepted).toBe(true);
  });

  it("accept 落盘失败不抛，本次会话内视为已同意", async () => {
    mockFail.set = true;
    const { useConsentStore } = loadConsent();
    await useConsentStore.getState().hydrate();
    await expect(useConsentStore.getState().accept()).resolves.toBeUndefined();
    expect(useConsentStore.getState()).toMatchObject({
      hydrated: true,
      privacyAccepted: true,
    });
    expect(mockKv.has(KEY)).toBe(false);
  });

  it("accept 写的是锁屏可读的新条目（AFTER_FIRST_UNLOCK）：BLE 事件在锁屏下拉起进程时也读得到", async () => {
    const mod = loadConsent();
    await mod.useConsentStore.getState().accept();
    expect(mockKv.get(KEY)).toBe(mod.PRIVACY_VERSION);
    expect(mockSetOptions).toEqual([
      { keychainAccessible: "AFTER_FIRST_UNLOCK" },
    ]);
  });

  it("升级前同意过的（只有旧条目）：仍算已同意，并搬一份到新条目；旧版本号的旧条目不搬", async () => {
    const mod = loadConsent();
    mockKv.set(LEGACY_KEY, mod.PRIVACY_VERSION);
    await mod.useConsentStore.getState().hydrate();
    await flush();
    expect(mod.useConsentStore.getState()).toMatchObject({
      hydrated: true,
      privacyAccepted: true,
    });
    expect(mockKv.get(KEY)).toBe(mod.PRIVACY_VERSION);
    expect(mockSetOptions).toEqual([
      { keychainAccessible: "AFTER_FIRST_UNLOCK" },
    ]);

    mockKv.clear();
    mockKv.set(LEGACY_KEY, "2026-09-11");
    const again = loadConsent();
    await again.useConsentStore.getState().hydrate();
    await flush();
    expect(again.useConsentStore.getState().privacyAccepted).toBe(false);
    expect(mockKv.has(KEY)).toBe(false);
  });

  it("读取抛错（锁屏下被 BLE 拉起）≠ 没同意：保持「还没读完」，不弹「请同意否则退出登录」；回到前台重读", async () => {
    const listeners: ((s: string) => void)[] = [];
    const removed: boolean[] = [];
    const { AppState } =
      require("react-native") as typeof import("react-native");
    jest.spyOn(AppState, "addEventListener").mockImplementation(((
      _: string,
      cb: (s: string) => void,
    ) => {
      listeners.push(cb);
      return { remove: () => removed.push(true) };
    }) as never);
    const mod = loadConsent();
    mockKv.set(KEY, mod.PRIVACY_VERSION);
    mockFail.get = true;
    await mod.useConsentStore.getState().hydrate();
    // 原来这里是 hydrated: true + 未同意 → 已同意的用户被要求重新勾选，极光本进程不初始化
    expect(mod.useConsentStore.getState()).toMatchObject({
      hydrated: false,
      privacyAccepted: false,
    });
    expect(listeners).toHaveLength(1);
    // 再失败一次不重复挂监听
    await mod.useConsentStore.getState().hydrate();
    expect(listeners).toHaveLength(1);
    // 仍在后台：不重读
    listeners[0]("background");
    await flush();
    expect(mod.useConsentStore.getState().hydrated).toBe(false);
    // 用户解锁打开 App
    mockFail.get = false;
    listeners[0]("active");
    await flush();
    expect(mod.useConsentStore.getState()).toMatchObject({
      hydrated: true,
      privacyAccepted: true,
    });
    expect(removed).toEqual([true]);
  });

  it("读取抛错期间用户在登录页勾选并同意了：迟到的重读失败不把它翻回去", async () => {
    const { AppState } =
      require("react-native") as typeof import("react-native");
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((() => ({ remove: () => undefined })) as never);
    mockFail.get = true;
    const { useConsentStore } = loadConsent();
    await useConsentStore.getState().accept();
    await useConsentStore.getState().hydrate();
    expect(useConsentStore.getState()).toMatchObject({
      hydrated: true,
      privacyAccepted: true,
    });
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
    expect(useLocaleStore.getState()).toMatchObject({
      locale: "zh-TW",
      hydrated: true,
    });
  });
});

describe("accountSwitched（F-7：档案从无到有不算换人）", () => {
  it("两边都有 id 且不同才算；null → 有值不算；同 id 不算；有值 → null（登出）不算，登出另有判定", async () => {
    const { store } = loadAuth();
    void store;
    const { accountSwitched } = require("../auth-store") as AuthStore;
    expect(accountSwitched("u1", "u2")).toBe(true);
    expect(accountSwitched(undefined, "u1")).toBe(false);
    expect(accountSwitched("u1", "u1")).toBe(false);
    expect(accountSwitched("u1", undefined)).toBe(false);
    expect(accountSwitched(undefined, undefined)).toBe(false);
  });
});
