// 边界补测（2026-10-03）：绑定二维码解析的长度/编码临界，以及推送 alias 在「同意隐私政策之前」
// 发生换账号、登出时的归属（push.test.ts 只测了同意之后的换账号）。
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockInit = jest.fn();
const mockSetAlias = jest.fn();
const mockDeleteAlias = jest.fn();
const mockNavigate = jest.fn();
const mockActive = jest.fn(async (_deviceId: string) => ({ sos: null as unknown }));
type OpenedListener = (r: { notificationEventType: string; extras?: unknown }) => void;
const mockListeners: OpenedListener[] = [];

jest.mock("jpush-react-native", () => ({
  __esModule: true,
  default: {
    init: (p: unknown) => mockInit(p),
    setAlias: (p: unknown) => mockSetAlias(p),
    deleteAlias: (p: unknown) => mockDeleteAlias(p),
    addNotificationListener: (cb: OpenedListener) => {
      mockListeners.push(cb);
    },
    addConnectEventListener: () => undefined,
    setLoggerEnable: () => undefined,
    getRegistrationID: () => undefined,
  },
}));
jest.mock("expo-router", () => ({
  router: { navigate: (h: string) => mockNavigate(h) },
}));
jest.mock("@/api/sos", () => ({ sosApi: { active: (d: string) => mockActive(d) } }));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

import { useConsentStore } from "@/stores/consent-store";

import { parseBindQr } from "../bind-qr";
import { __resetPushForTests, landFromPush, startPush, stopPush } from "../push";

const cfg = { appKey: "k", channel: "official" };
const aliases = () => mockSetAlias.mock.calls.map((c) => (c[0] as { alias: string }).alias);

beforeEach(() => {
  __resetPushForTests();
  mockListeners.length = 0;
  useConsentStore.setState({ privacyAccepted: false, hydrated: true });
});
afterEach(() => {
  jest.clearAllMocks();
});

describe("parseBindQr 边界", () => {
  it("deviceId 长度：3 位拒绝、4 位与 64 位接受、65 位拒绝（裸码与链接同口径）", () => {
    const id = (n: number) => "a".repeat(n);
    expect(parseBindQr(id(3))).toBeNull();
    expect(parseBindQr(id(4))).toEqual({ deviceId: id(4), bindCode: null });
    expect(parseBindQr(id(64))?.deviceId).toHaveLength(64);
    expect(parseBindQr(id(65))).toBeNull();
    expect(parseBindQr(`helmet://bind?d=${id(3)}&c=12345678`)).toBeNull();
    expect(parseBindQr(`helmet://bind?d=${id(64)}&c=12345678`)?.bindCode).toBe("12345678");
    expect(parseBindQr(`helmet://bind?d=${id(65)}&c=12345678`)).toBeNull();
  });

  it("绑定码必须恰好 8 位半角数字：7 位、9 位、全角数字、带字母都只丢码不丢设备号", () => {
    for (const code of ["1234567", "123456789", "１２３４５６７８", "1234567a", "-1234567"]) {
      expect(parseBindQr(`https://01weichuang.com/bind?d=helmet_1&c=${code}`)).toEqual({
        deviceId: "helmet_1",
        bindCode: null,
      });
    }
  });

  it("扫码器附带的首尾空白 / 换行 / BOM 不影响解析", () => {
    expect(parseBindQr("﻿ https://01weichuang.com/bind?d=helmet_1&c=12345678\r\n")).toEqual({
      deviceId: "helmet_1",
      bindCode: "12345678",
    });
    expect(parseBindQr("\n\t ")).toBeNull();
  });

  it("参数做了百分号编码、子域名、大写协议头都认；短参数名优先于长参数名", () => {
    expect(parseBindQr("https://01weichuang.com/bind?d=helmet%5F1&c=12345678")?.deviceId).toBe(
      "helmet_1",
    );
    expect(parseBindQr("HTTPS://dev.01weichuang.com/bind?d=helmet_1")?.deviceId).toBe("helmet_1");
    expect(
      parseBindQr("helmet://bind?deviceId=helmet_long&d=helmet_short&code=11111111&c=22222222"),
    ).toEqual({ deviceId: "helmet_short", bindCode: "22222222" });
  });

  it("裸码里混了路径 / 空格 / 中文 / 注入字符：一律拒绝", () => {
    for (const raw of ["helmet 001", "helmet/001", "头盔001号", "helmet_1;drop", "../etc", "a.b.c.d"]) {
      expect(parseBindQr(raw)).toBeNull();
    }
  });
});

describe("推送 alias：同意隐私政策之前的账号变动", () => {
  it("A 登录未同意 → 换成 B 登录 → 此时才同意：只给 B 设 alias，SDK 只初始化一次", async () => {
    startPush("user_A", cfg);
    startPush("user_B", cfg);
    await useConsentStore.getState().accept();
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(aliases()).toEqual(["user_B"]);
  });

  it("登录未同意 → 登出 → 之后在登录页勾了同意：没有登录用户，不初始化也不设 alias", async () => {
    startPush("user_A", cfg);
    stopPush();
    await useConsentStore.getState().accept();
    expect(mockInit).not.toHaveBeenCalled();
    expect(mockSetAlias).not.toHaveBeenCalled();
    expect(mockDeleteAlias).not.toHaveBeenCalled();
  });

  it("同一用户登出再登录：alias 要重新设；重复登出只解绑一次；sequence 单调递增", () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("user_A", cfg);
    stopPush();
    stopPush();
    startPush("user_A", cfg);
    expect(aliases()).toEqual(["user_A", "user_A"]);
    expect(mockDeleteAlias).toHaveBeenCalledTimes(1);
    const seqs = [
      (mockSetAlias.mock.calls[0][0] as { sequence: number }).sequence,
      (mockDeleteAlias.mock.calls[0][0] as { sequence: number }).sequence,
      (mockSetAlias.mock.calls[1][0] as { sequence: number }).sequence,
    ];
    expect(seqs).toEqual([1, 2, 3]);
    expect(mockInit).toHaveBeenCalledTimes(1);
  });
});

describe("点通知落地的边界", () => {
  it("extras 里没有 deviceId（老版本服务端 / 厂商通道丢字段）：不查进行中状态，直接进事故详情", async () => {
    expect(await landFromPush({ sosId: "s1" })).toBe("/accident/s1");
    expect(mockActive).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/accident/s1");
  });

  it("这台设备进行中的单已是终态快照（status 不是 pending）：进事故详情而不是倒计时页", async () => {
    mockActive.mockResolvedValueOnce({ sos: { sosId: "s1", status: "notified" } });
    expect(await landFromPush({ sosId: "s1", deviceId: "d1" })).toBe("/accident/s1");
  });

  it("通知被点开但完全没有 extras：不跳转、不抛", async () => {
    useConsentStore.setState({ privacyAccepted: true });
    startPush("user_A", cfg);
    expect(mockListeners).toHaveLength(1);
    expect(() => mockListeners[0]({ notificationEventType: "notificationOpened" })).not.toThrow();
    await Promise.resolve();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
