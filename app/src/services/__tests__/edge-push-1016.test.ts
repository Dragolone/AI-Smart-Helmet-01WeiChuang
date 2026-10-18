// 远程推送载荷与落地的边界补测（2026-10-16）。保命链路：只断言现状，不改行为。
// 发现的问题记在 src/__tests__/EDGE_FINDINGS_1016.md（A4：落地路径没做 URL 编码）。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import { presentedSos } from "@/services/sos-sync";
import {
  __resetPushForTests,
  extrasFromLaunchResponse,
  isDefaultTap,
  landFromPush,
  readPushConfig,
} from "../push";

const mockNavigate = jest.fn();
const mockActive = jest.fn(
  async (_deviceId: string): Promise<{ sos: unknown }> => ({ sos: null }),
);

jest.mock("jpush-react-native", () => ({ __esModule: true, default: {} }));
jest.mock("expo-router", () => ({
  router: { navigate: (h: string) => mockNavigate(h) },
}));
jest.mock("@/api/sos", () => ({
  sosApi: {
    active: (d: string) => mockActive(d),
    // 10-17 起这顶头盔没有在倒数的单时会再查账号级列表；这里一律没有
    activeForAccount: async () => ({ items: [] }),
  },
}));
jest.mock("@/services/dev-log", () => ({ devLog: jest.fn() }));
jest.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  getLastNotificationResponse: () => null,
  clearLastNotificationResponse: () => undefined,
}));
jest.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

const pending = (sosId: string, deviceId = "helmet_1") => ({
  sos: { sosId, deviceId, status: "pending" },
});

beforeEach(() => {
  __resetPushForTests();
  presentedSos.current.clear();
});
afterEach(() => {
  jest.clearAllMocks();
});

describe("landFromPush：extras 的形态", () => {
  it.each([
    [{}],
    [{ sosId: "" }],
    [{ sosId: 123 as unknown as string }],
    [{ sosId: null as unknown as string, deviceId: "helmet_1" }],
  ])("没有可用的 sosId（%j）：不跳转、不查接口", async (extras) => {
    expect(await landFromPush(extras)).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockActive).not.toHaveBeenCalled();
  });

  it("deviceId 是空串 / 数字：不查进行中状态，直接进事故详情", async () => {
    expect(await landFromPush({ sosId: "s1", deviceId: "" })).toBe(
      "/accident/s1",
    );
    expect(
      await landFromPush({ sosId: "s1", deviceId: 7 as unknown as string }),
    ).toBe("/accident/s1");
    expect(mockActive).not.toHaveBeenCalled();
  });

  // 10-17 起改了行为（REGRESSION 4.27 加测，华为实测旧单记录页压在新单的倒计时上）：去正在倒数的那一单
  it("这台头盔进行中的是另一单：去那一单的倒计时并登记它，不进被点那一单的事故详情", async () => {
    mockActive.mockResolvedValueOnce(pending("s-new"));
    expect(await landFromPush({ sosId: "s-old", deviceId: "helmet_1" })).toBe(
      "/sos-active?sosId=s-new&deviceId=helmet_1",
    );
    expect(presentedSos.current.has("s-old")).toBe(false);
    expect(presentedSos.current.has("s-new")).toBe(true);
  });

  it("查进行中状态失败（刚唤醒的网络）：进倒计时页并登记，之后 WS / 补拉不再重复拉起", async () => {
    mockActive.mockRejectedValueOnce(new Error("network"));
    expect(await landFromPush({ sosId: "s1", deviceId: "helmet_1" })).toBe(
      "/sos-active?sosId=s1&deviceId=helmet_1",
    );
    expect(presentedSos.current.has("s1")).toBe(true);
  });

  it("接口回来的 sos 是 undefined（畸形响应）：按没有进行中处理，进事故详情", async () => {
    mockActive.mockResolvedValueOnce({ sos: undefined });
    expect(await landFromPush({ sosId: "s1", deviceId: "helmet_1" })).toBe(
      "/accident/s1",
    );
  });

  it("进行中、同一单：进倒计时页", async () => {
    mockActive.mockResolvedValueOnce(pending("s1"));
    expect(await landFromPush({ sosId: "s1", deviceId: "helmet_1" })).toBe(
      "/sos-active?sosId=s1&deviceId=helmet_1",
    );
  });

  it("改后（10-16 A4）：编号经 URL 编码再拼进路径——编号里有 & / ? / 斜杠也落不到别的参数或别的页面", async () => {
    mockActive.mockRejectedValueOnce(new Error("network"));
    expect(
      await landFromPush({ sosId: "a&deviceId=x", deviceId: "helmet_1" }),
    ).toBe("/sos-active?sosId=a%26deviceId%3Dx&deviceId=helmet_1");
    expect(await landFromPush({ sosId: "../device/helmet_1" })).toBe(
      "/accident/..%2Fdevice%2Fhelmet_1",
    );
  });
});

describe("extrasFromLaunchResponse：冷启动那次点击", () => {
  const launch = (trigger: unknown) => ({
    notification: { request: { trigger } },
  });

  it("本地通知（trigger 不是 push）、trigger 为空：不当推送处理", () => {
    expect(
      extrasFromLaunchResponse(
        launch({ type: "timeInterval", payload: { sosId: "s1" } }) as never,
      ),
    ).toBeNull();
    expect(extrasFromLaunchResponse(launch(null) as never)).toBeNull();
    expect(extrasFromLaunchResponse({} as never)).toBeNull();
  });

  it("payload 缺失 / sosId 不是字符串：null", () => {
    expect(
      extrasFromLaunchResponse(launch({ type: "push" }) as never),
    ).toBeNull();
    expect(
      extrasFromLaunchResponse(
        launch({ type: "push", payload: { sosId: 1 } }) as never,
      ),
    ).toBeNull();
  });

  it("deviceId 不是字符串：丢掉 deviceId，sosId 照用", () => {
    expect(
      extrasFromLaunchResponse(
        launch({
          type: "push",
          payload: { sosId: "s1", deviceId: 5 },
        }) as never,
      ),
    ).toEqual({ sosId: "s1", deviceId: undefined });
  });

  it("payload 里多余的字段不带出来", () => {
    expect(
      extrasFromLaunchResponse(
        launch({
          type: "push",
          payload: { sosId: "s1", deviceId: "d", evil: "x" },
        }) as never,
      ),
    ).toEqual({ sosId: "s1", deviceId: "d" });
  });
});

describe("isDefaultTap / readPushConfig", () => {
  it("没有 actionIdentifier、空串、默认动作都算点横幅；按钮动作不算", () => {
    expect(isDefaultTap(null)).toBe(true);
    expect(isDefaultTap({})).toBe(true);
    expect(isDefaultTap({ actionIdentifier: "" })).toBe(true);
    expect(
      isDefaultTap({
        actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
      }),
    ).toBe(true);
    expect(isDefaultTap({ actionIdentifier: "cancel-sos" })).toBe(false);
  });

  it("appKey 为空串 / 缺失：不配置；channel 缺省为 official，写了空串则原样（现状）", () => {
    expect(readPushConfig({ jpush: { appKey: "" } })).toBeNull();
    expect(readPushConfig({})).toBeNull();
    expect(readPushConfig(undefined)).toEqual(readPushConfig());
    expect(readPushConfig({ jpush: { appKey: "k" } })).toEqual({
      appKey: "k",
      channel: "official",
    });
    expect(readPushConfig({ jpush: { appKey: "k", channel: "" } })).toEqual({
      appKey: "k",
      channel: "",
    });
  });
});
