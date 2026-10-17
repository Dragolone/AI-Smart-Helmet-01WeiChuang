// iOS 删 App 不删钥匙串：重装后第一次打开要把上一次安装留下的条目全部清掉，和安卓（卸载即清）一致
// （负责人 2026-10-17 定）。这里钉住：怎么认出「这次安装第一次打开」、清哪些、什么时候不清、出错不卡启动。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { accountSecureKeysOf, SECURE_KEYS } from "../secure-keys";

type FreshInstall = typeof import("../fresh-install");

const mockKv = new Map<string, string>();
const mockFiles = new Map<string, string>();
/** 按发生顺序记下写标记、删条目两类动作 */
const mockEvents: string[] = [];
const mockFail = { write: false, construct: false, deleteKey: "" };
const mockPlatform = { OS: "ios" };
const mockLogout = jest.fn<(token: string) => Promise<void>>(() =>
  Promise.resolve(),
);

jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => mockKv.get(k) ?? null,
  deleteItemAsync: async (k: string) => {
    if (k === mockFail.deleteKey) throw new Error("keychain busy");
    mockEvents.push(`delete ${k}`);
    mockKv.delete(k);
  },
}));
jest.mock("expo-file-system", () => ({
  Paths: { document: "doc" },
  File: class {
    path: string;
    constructor(dir: string, name: string) {
      if (mockFail.construct) throw new Error("no file system");
      this.path = `${dir}/${name}`;
    }
    get exists() {
      return mockFiles.has(this.path);
    }
    write(text: string) {
      if (mockFail.write) throw new Error("disk full");
      mockEvents.push("marker");
      mockFiles.set(this.path, text);
    }
  },
}));
jest.mock("react-native", () => {
  const actual = jest.requireActual<object>("react-native");
  return new Proxy(actual, {
    get: (target, prop, receiver) =>
      prop === "Platform" ? mockPlatform : Reflect.get(target, prop, receiver),
  });
});
jest.mock("@/api/auth", () => ({
  authApi: { logout: (token: string) => mockLogout(token) },
}));
jest.mock("@/services/dev-log", () => ({ devLog: () => undefined }));

/** 每个用例一个新进程：模块里「一个进程只检查一次」的记忆不能串 */
const load = (): FreshInstall => {
  let mod!: FreshInstall;
  jest.isolateModules(() => {
    mod = jest.requireActual<FreshInstall>("../fresh-install");
  });
  return mod;
};

const MARKER_PATH = "doc/install-marker";

/** 上一次安装留下的东西：不分账号的全部条目 + 给定账号的全部条目，会话 / 启动记录 / 有过头盔指向 u1 / u2 / u3 */
function seedLeftovers(extraAccounts: string[] = []): void {
  for (const key of Object.values(SECURE_KEYS)) mockKv.set(key, "x");
  for (const user of ["u1", "u2", "u3", ...extraAccounts])
    for (const key of accountSecureKeysOf(user)) mockKv.set(key, "x");
  mockKv.set(
    SECURE_KEYS.sessionTokens,
    JSON.stringify({ accessToken: "a-old", refreshToken: "r-old" }),
  );
  mockKv.set(
    SECURE_KEYS.sessionUser,
    JSON.stringify({ id: "u1", phone: "19900001234" }),
  );
  mockKv.set(
    SECURE_KEYS.launchMemory,
    JSON.stringify({ userId: "u2", hasHelmet: true }),
  );
  mockKv.set(SECURE_KEYS.everHadHelmet, JSON.stringify(["u3", "u1"]));
}

beforeEach(() => {
  mockKv.clear();
  mockFiles.clear();
  mockEvents.length = 0;
  mockFail.write = false;
  mockFail.construct = false;
  mockFail.deleteKey = "";
  mockPlatform.OS = "ios";
  mockLogout.mockReset();
  mockLogout.mockImplementation(() => Promise.resolve());
});

describe("iOS 重装后第一次打开", () => {
  it("没有安装标记：先写标记，再清掉不分账号的全部条目和上一次用过的账号的条目，并作废上一次的登录", async () => {
    // u9 只登过、没绑过头盔、又退出了：这份记录里找不到它，它的条目会留下（只影响几条提示再不再出现）
    seedLeftovers(["u9"]);
    await load().clearIfFreshInstall();

    expect(mockFiles.has(MARKER_PATH)).toBe(true);
    expect(mockEvents[0]).toBe("marker");
    expect([...mockKv.keys()].sort()).toEqual(accountSecureKeysOf("u9").sort());
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(mockLogout).toHaveBeenCalledWith("r-old");
  });

  it("清的条目包含登记表里的每一项（新加条目登记进 SECURE_KEYS 就会被清）", async () => {
    seedLeftovers();
    await load().clearIfFreshInstall();
    const deleted = new Set(
      mockEvents.filter((e) => e.startsWith("delete ")).map((e) => e.slice(7)),
    );
    for (const key of Object.values(SECURE_KEYS))
      expect(deleted.has(key)).toBe(true);
    for (const user of ["u1", "u2", "u3"])
      for (const key of accountSecureKeysOf(user))
        expect(deleted.has(key)).toBe(true);
  });

  it("钥匙串本来就是空的（第一次装）：照样写标记，不发作废请求", async () => {
    await load().clearIfFreshInstall();
    expect(mockFiles.has(MARKER_PATH)).toBe(true);
    expect(mockLogout).not.toHaveBeenCalled();
  });
});

describe("不清的情况", () => {
  it("标记已在（这次安装开过）：什么都不动", async () => {
    seedLeftovers();
    mockFiles.set(MARKER_PATH, "2026-10-17T00:00:00.000Z");
    const before = new Map(mockKv);
    await load().clearIfFreshInstall();
    expect(mockKv).toEqual(before);
    expect(mockEvents).toEqual([]);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("安卓：不检查也不清（卸载即清，钥匙串条目不进系统备份）", async () => {
    mockPlatform.OS = "android";
    seedLeftovers();
    const before = new Map(mockKv);
    await load().clearIfFreshInstall();
    expect(mockKv).toEqual(before);
    expect(mockFiles.size).toBe(0);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("标记写不进去（存储满了）：这次不清——宁可留着，也不能每次打开都把人登出", async () => {
    seedLeftovers();
    mockFail.write = true;
    const before = new Map(mockKv);
    await load().clearIfFreshInstall();
    expect(mockKv).toEqual(before);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("文件接口不可用：不清，也不让启动卡住", async () => {
    seedLeftovers();
    mockFail.construct = true;
    const before = new Map(mockKv);
    await expect(load().clearIfFreshInstall()).resolves.toBeUndefined();
    expect(mockKv).toEqual(before);
  });
});

describe("一个进程只检查一次", () => {
  it("重复调用拿同一个结果；清完之后再写进去的条目不会被第二次调用删掉", async () => {
    seedLeftovers();
    const mod = load();
    const first = mod.clearIfFreshInstall();
    expect(mod.clearIfFreshInstall()).toBe(first);
    await first;
    // 刚登录写下的新会话
    mockKv.set(SECURE_KEYS.sessionTokens, "new");
    await mod.clearIfFreshInstall();
    expect(mockKv.get(SECURE_KEYS.sessionTokens)).toBe("new");
  });

  it("下一次冷启动（新进程）看到标记就不再清", async () => {
    seedLeftovers();
    await load().clearIfFreshInstall();
    mockKv.set(SECURE_KEYS.sessionTokens, "new");
    await load().clearIfFreshInstall();
    expect(mockKv.get(SECURE_KEYS.sessionTokens)).toBe("new");
  });
});

describe("出错时", () => {
  it("档案 / 凭证不是 JSON：不分账号的条目照清，认不出的账号跳过，不发作废请求", async () => {
    seedLeftovers();
    mockKv.set(SECURE_KEYS.sessionTokens, "{broken");
    mockKv.set(SECURE_KEYS.sessionUser, "not json");
    await load().clearIfFreshInstall();
    for (const key of Object.values(SECURE_KEYS))
      expect(mockKv.has(key)).toBe(false);
    // u1 只在会话档案和有过头盔记录里出现：后者还认得出，照样清
    for (const user of ["u1", "u2", "u3"])
      for (const key of accountSecureKeysOf(user))
        expect(mockKv.has(key)).toBe(false);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("作废请求失败、甚至同步抛错，都不影响清本机", async () => {
    seedLeftovers();
    mockLogout.mockImplementation(() => {
      throw new Error("offline");
    });
    await load().clearIfFreshInstall();
    expect(mockKv.size).toBe(0);

    mockKv.clear();
    mockFiles.clear();
    seedLeftovers();
    mockLogout.mockImplementation(() => Promise.reject(new Error("timeout")));
    await load().clearIfFreshInstall();
    expect(mockKv.size).toBe(0);
  });

  it("某一条删不掉：不挡其余条目，也不让启动卡住", async () => {
    seedLeftovers();
    mockFail.deleteKey = SECURE_KEYS.theme;
    await expect(load().clearIfFreshInstall()).resolves.toBeUndefined();
    expect([...mockKv.keys()]).toEqual([SECURE_KEYS.theme]);
  });
});

describe("上一次安装用过的账号", () => {
  it("当时登录着的、最后一次启动的、有过头盔的，去重；不是字符串的、空的跳过", () => {
    const { accountsIn } = load();
    expect(
      accountsIn(
        JSON.stringify({ id: "u1" }),
        JSON.stringify({ userId: "u1", hasHelmet: false }),
        JSON.stringify(["u2", 3, "", null, "u1"]),
      ),
    ).toEqual(["u1", "u2"]);
    expect(accountsIn(null, null, null)).toEqual([]);
    expect(accountsIn("[]", "7", '{"a":1}')).toEqual([]);
  });
});
