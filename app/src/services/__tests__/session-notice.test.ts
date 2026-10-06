// 会话被动结束的提醒：不在前台才发本地通知（前台时登录页顶部有同样的说明），重新登录后撤掉。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppState, Platform } from "react-native";

const mockSchedule = jest.fn(async (_req: unknown) => "id");
const mockDismiss = jest.fn(async (_id: string) => undefined);

jest.mock("expo-notifications", () => ({
  scheduleNotificationAsync: (req: unknown) => mockSchedule(req),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
  AndroidNotificationPriority: { MAX: "max" },
}));
jest.mock("@/i18n", () => ({ translate: (k: string) => k }));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));

import {
  clearSessionExpiredNotice,
  notifySessionExpired,
  SESSION_EXPIRED_NOTIFICATION_ID,
} from "../session-notice";

const originalOS = Platform.OS;
const originalState = AppState.currentState;
const override = (obj: object, key: string, value: unknown): void => {
  Object.defineProperty(obj, key, {
    value,
    configurable: true,
    writable: true,
  });
};
type Req = {
  identifier: string;
  content: Record<string, unknown>;
  trigger: unknown;
};

beforeEach(() => {
  mockSchedule.mockClear();
  mockSchedule.mockImplementation(async () => "id");
  mockDismiss.mockClear();
  override(Platform, "OS", "ios");
  override(AppState, "currentState", "background");
});
afterEach(() => {
  override(Platform, "OS", originalOS);
  override(AppState, "currentState", originalState);
});

describe("notifySessionExpired", () => {
  it("手机在口袋里（后台）：发一条带声的本地通知，说清「头盔保护已暂停」", () => {
    notifySessionExpired();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const req = mockSchedule.mock.calls[0][0] as Req;
    expect(req.identifier).toBe(SESSION_EXPIRED_NOTIFICATION_ID);
    expect(req.content.title).toBe("auth.sessionExpiredTitle");
    expect(req.content.body).toBe("auth.sessionExpiredBody");
    expect(req.content.sound).toBe("default");
    expect(req.trigger).toBeNull();
  });

  it("锁屏瞬间（inactive）同样发；在前台不发（登录页顶部的说明就在眼前）", () => {
    override(AppState, "currentState", "inactive");
    notifySessionExpired();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    override(AppState, "currentState", "active");
    notifySessionExpired();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it("Android：走 SOS 通道（写在 trigger 里），声音用 true", () => {
    override(Platform, "OS", "android");
    notifySessionExpired();
    const req = mockSchedule.mock.calls[0][0] as Req;
    expect(req.trigger).toEqual({ channelId: "sos" });
    expect(req.content.sound).toBe(true);
  });

  it("通知发不出去（权限被拒等）不抛", async () => {
    mockSchedule.mockRejectedValueOnce(new Error("denied"));
    expect(() => notifySessionExpired()).not.toThrow();
    await Promise.resolve();
  });
});

describe("clearSessionExpiredNotice", () => {
  it("重新登录后撤掉那条提醒；撤不掉（已被划走）不抛", async () => {
    clearSessionExpiredNotice();
    expect(mockDismiss).toHaveBeenCalledWith(SESSION_EXPIRED_NOTIFICATION_ID);
    mockDismiss.mockRejectedValueOnce(new Error("gone"));
    expect(() => clearSessionExpiredNotice()).not.toThrow();
    await Promise.resolve();
  });
});

// 接线在带 hooks 的组件里，本仓库的 jest 渲染不了，用源码断言兜住「被误删」（同 audit-legal-consent 的做法）
describe("接线（源码不变式）", () => {
  const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");

  it("根布局：sessionExpired 由假变真时发通知，重新登录时撤", () => {
    const layout = read("app/_layout.tsx");
    expect(layout).toMatch(
      /state\.sessionExpired && !prev\.sessionExpired\)\s*notifySessionExpired\(\)/,
    );
    expect(layout).toMatch(
      /state\.tokens !== null && prev\.tokens === null\)\s*clearSessionExpiredNotice\(\)/,
    );
  });

  it("登录页：被动登出时顶部说明后果", () => {
    const login = read("app/(auth)/login.tsx");
    expect(login).toContain("useAuthStore((s) => s.sessionExpired)");
    expect(login).toContain('t("auth.sessionExpiredNotice")');
  });

  it("注销账号：不再保留上次登录的手机号（登出保留，注销不留）", () => {
    const del = read("app/account/delete.tsx");
    const done = del.indexOf("authApi.deleteMe");
    const wipe = del.indexOf('deleteItemAsync("last_login_phone")');
    expect(wipe).toBeGreaterThan(done);
    expect(read("stores/auth-store.ts")).not.toContain("last_login_phone");
  });
});
