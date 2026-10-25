import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import { useLocaleStore } from "@/i18n";
import { installLocaleSync } from "@/services/locale-sync";

const mockSos = jest.fn(async () => undefined);
const mockBattery = jest.fn(async () => undefined);
const mockService = jest.fn();
jest.mock("@/services/sos-alert", () => ({
  refreshSosAlertTexts: () => mockSos(),
}));
jest.mock("@/services/battery-alert", () => ({
  refreshBatteryChannelName: () => mockBattery(),
}));
jest.mock("@/services/ble-link", () => ({
  refreshServiceNotification: () => mockService(),
}));

describe("切语言后同步交给系统的文字（10-25 安卓模拟器：切成简体后求救通知按钮还是英文）", () => {
  let uninstall: () => void = () => undefined;
  beforeEach(() => {
    useLocaleStore.setState({ locale: "en" });
    jest.clearAllMocks();
  });
  afterEach(() => uninstall());

  it("语言变了：求救通知按钮 / 通道名、电量通道名、蓝牙常驻通知各重写一次", () => {
    uninstall = installLocaleSync();
    useLocaleStore.setState({ locale: "zh-CN" });
    expect(mockSos).toHaveBeenCalledTimes(1);
    expect(mockBattery).toHaveBeenCalledTimes(1);
    expect(mockService).toHaveBeenCalledTimes(1);
  });

  it("语言没变（读盘完成、别的字段变化）不重写；卸下后不再跟", () => {
    uninstall = installLocaleSync();
    useLocaleStore.setState({ locale: "en" });
    useLocaleStore.setState({ hydrated: true });
    expect(mockSos).not.toHaveBeenCalled();
    expect(mockService).not.toHaveBeenCalled();
    uninstall();
    useLocaleStore.setState({ locale: "zh-TW" });
    expect(mockSos).not.toHaveBeenCalled();
    expect(mockBattery).not.toHaveBeenCalled();
  });
});
