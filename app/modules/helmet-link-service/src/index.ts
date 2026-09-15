// Android 前台服务（决策 #41 低成本档）：让 BLE 头盔链路在退后台/锁屏后不被系统回收。
// iOS 走 bluetooth-central 后台模式（真机实测通过），本模块在 iOS 上全部为空操作。
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

interface NativeLinkService {
  start(title: string, text: string): void;
  stop(): void;
  isRunning(): boolean;
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NativeLinkService>("HelmetLinkService")
    : null;

export const HelmetLinkService = {
  /** 模块是否可用（Android 且原生已链接；模拟器/未 prebuild 时为 false） */
  available: native !== null,
  start(title: string, text: string): void {
    native?.start(title, text);
  },
  stop(): void {
    native?.stop();
  },
  isRunning(): boolean {
    return native?.isRunning() ?? false;
  },
  /** iOS / 不可用时返回 true（不显示引导） */
  isIgnoringBatteryOptimizations(): boolean {
    return native?.isIgnoringBatteryOptimizations() ?? true;
  },
  requestIgnoreBatteryOptimizations(): void {
    native?.requestIgnoreBatteryOptimizations();
  },
};
