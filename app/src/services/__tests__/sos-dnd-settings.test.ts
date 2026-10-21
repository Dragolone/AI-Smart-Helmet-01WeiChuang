// 「勿扰模式下也提醒」那一行点进去去哪（O28）：华为 / 荣耀的通道设置意图会被改道到它自己的简化页，那页没有
// 「覆盖“请勿打扰”模式」开关（2026-10-21 P30 Pro EMUI 10 实测），所以先说路径、再开应用通知页。
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { Alert, Linking, Platform } from "react-native";

import { translate } from "@/i18n";

let mockHuawei = false;
jest.mock("@/services/phone-vendor", () => ({
  isHuaweiFamily: () => mockHuawei,
}));

import { openSosDndSettings } from "../notification-settings";

afterEach(() => {
  mockHuawei = false;
  jest.restoreAllMocks();
});

describe("openSosDndSettings", () => {
  it("一般安卓：直接开求救通道的设置页（开关就在那一页）", () => {
    const os = jest.replaceProperty(Platform, "OS", "android");
    // RN 的 jest 预设里它本来就是 mock：spyOn 拿到的是同一个，调用记录跨用例累计
    const send = jest.spyOn(Linking, "sendIntent").mockResolvedValue(undefined);
    send.mockClear();
    const alert = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);
    openSosDndSettings("sos");
    expect(alert).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0]).toBe(
      "android.settings.CHANNEL_NOTIFICATION_SETTINGS",
    );
    os.restore();
  });

  it("华为 / 荣耀：先说路径（通道名、「高级」、开关名），点「确定」才开应用通知页，不开那个没有开关的简化页", async () => {
    mockHuawei = true;
    const os = jest.replaceProperty(Platform, "OS", "android");
    // RN 的 jest 预设里它本来就是 mock：spyOn 拿到的是同一个，调用记录跨用例累计
    const send = jest.spyOn(Linking, "sendIntent").mockResolvedValue(undefined);
    send.mockClear();
    const alert = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);
    openSosDndSettings("sos");
    expect(send).not.toHaveBeenCalled();
    const [title, body, buttons] = alert.mock.calls[0] as [
      string,
      string,
      { text: string; onPress?: () => void }[],
    ];
    expect(title).toBe(translate("safetySettings.dnd"));
    expect(body).toBe(
      translate("safetySettings.dnd.huaweiSteps", {
        channel: translate("sosAlert.channel"),
      }),
    );
    expect(buttons.map((b) => b.text)).toEqual([translate("common.confirm")]);
    buttons[0].onPress?.();
    await Promise.resolve();
    expect(send.mock.calls[0][0]).toBe(
      "android.settings.APP_NOTIFICATION_SETTINGS",
    );
    os.restore();
  });

  it("iOS 没有通道：不弹说明，开 App 的设置页", async () => {
    mockHuawei = true; // iOS 上判断不到华为，这里只确认不走安卓那条
    const os = jest.replaceProperty(Platform, "OS", "ios");
    const alert = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);
    const open = jest
      .spyOn(Linking, "openSettings")
      .mockResolvedValue(undefined);
    openSosDndSettings("sos");
    await Promise.resolve();
    await Promise.resolve();
    expect(alert).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    os.restore();
  });
});
