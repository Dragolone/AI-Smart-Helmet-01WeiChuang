// O37（10-31 安卓模拟器把存储填满实测）：钥匙串写不进 / 删不掉时，登录、退出、改设置都不能失败也不能静默——
// 内存态照常改、Promise 照常 resolve，另外说一声（services/persist-notice）。
// 安卓的写失败不抛，所以写成功返回后还要看一眼剩余空间（warnIfDiskLow）。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { UserProfile } from "@helmet/shared";

const mockFail = { set: false, del: false };
const mockKv = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  getItemAsync: async (k: string) => mockKv.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    if (mockFail.set) throw new Error("No space left on device");
    mockKv.set(k, v);
  },
  deleteItemAsync: async (k: string) => {
    if (mockFail.del)
      throw new Error("Could not delete the item from SecureStore");
    mockKv.delete(k);
  },
}));
const mockNote = jest.fn((_kind: string, _err: unknown) => undefined);
const mockWarn = jest.fn((_kind: string) => undefined);
jest.mock("@/services/persist-notice", () => ({
  notePersistFailure: (kind: string, err: unknown) => mockNote(kind, err),
  warnIfDiskLow: (kind: string) => mockWarn(kind),
}));
jest.mock("@/api/auth", () => ({
  authApi: {
    me: async () => {
      throw new Error("offline");
    },
    logout: async () => undefined,
  },
}));

import { useLocaleStore } from "@/i18n/locale-store";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";

const user: UserProfile = {
  id: "u1",
  phone: "13800001234",
  nickname: "骑手",
  avatarUrl: null,
  createdAt: "2026-09-01T00:00:00.000Z",
} as UserProfile;
const auth = { accessToken: "acc", refreshToken: "ref", user };

beforeEach(() => {
  mockFail.set = false;
  mockFail.del = false;
  mockKv.clear();
  mockNote.mockClear();
  mockWarn.mockClear();
});

describe("登录：钥匙串写不进", () => {
  it("signIn 不抛、内存里已登录，提示一次「登录没存上」；写得进时不提示、但要看一眼剩余空间", async () => {
    mockFail.set = true;
    await expect(useAuthStore.getState().signIn(auth)).resolves.toBeUndefined();
    expect(useAuthStore.getState().tokens).toEqual({
      accessToken: "acc",
      refreshToken: "ref",
    });
    expect(mockNote).toHaveBeenCalledTimes(1);
    expect(mockNote.mock.calls[0][0]).toBe("login");
    expect(mockKv.has("helmet.session.tokens")).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();

    mockFail.set = false;
    await useAuthStore.getState().signIn(auth);
    expect(mockNote).toHaveBeenCalledTimes(1);
    expect(mockKv.has("helmet.session.tokens")).toBe(true);
    expect(mockWarn.mock.calls.map((c) => c[0])).toEqual(["login"]);
  });
});

describe("退出：钥匙串删不掉", () => {
  it("dropSession / signOut 不抛、内存里已登出，提示一次「退出没清掉」", async () => {
    await useAuthStore.getState().signIn(auth);
    mockNote.mockClear();
    mockFail.del = true;
    await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();
    expect(useAuthStore.getState().tokens).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(mockNote).toHaveBeenCalledTimes(1);
    expect(mockNote.mock.calls[0][0]).toBe("logout");
    // 钥匙串里的 token 还在：下次冷启动会登回去，所以才要提示
    expect(mockKv.has("helmet.session.tokens")).toBe(true);
  });
});

describe("设置：外观 / 语言写不进", () => {
  it("当次生效、不抛，各提示一次「设置没存上」；写得进时看一眼剩余空间", async () => {
    mockFail.set = true;
    await expect(
      useThemeStore.getState().setMode("light"),
    ).resolves.toBeUndefined();
    expect(useThemeStore.getState().mode).toBe("light");
    await expect(
      useLocaleStore.getState().setLocale("zh-TW"),
    ).resolves.toBeUndefined();
    expect(useLocaleStore.getState().locale).toBe("zh-TW");
    expect(mockNote.mock.calls.map((c) => c[0])).toEqual([
      "setting",
      "setting",
    ]);
    expect(mockWarn).not.toHaveBeenCalled();

    mockFail.set = false;
    await useThemeStore.getState().setMode("dark");
    await useLocaleStore.getState().setLocale("en");
    expect(mockWarn.mock.calls.map((c) => c[0])).toEqual([
      "setting",
      "setting",
    ]);
  });
});
