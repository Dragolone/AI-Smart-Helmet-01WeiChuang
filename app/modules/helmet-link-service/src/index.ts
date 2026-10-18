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
  holdNetwork(ms: number): void;
  releaseNetwork(): void;
  openAppLaunchSettings(): string;
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
  /** 高危事件待上传：短暂持 CPU/Wi-Fi 锁（最多 ms 毫秒），上传完成后 releaseNetwork */
  holdNetwork(ms: number): void {
    // 原生包可能比 JS 旧（dev client 热更）：方法不存在时静默跳过，绝不让上传链路因此失败
    if (typeof native?.holdNetwork === "function") native.holdNetwork(ms);
  },
  releaseNetwork(): void {
    if (typeof native?.releaseNetwork === "function") native.releaseNetwork();
  },
  /**
   * 打开系统「应用启动管理」（华为 / 荣耀）：划掉 App 不被强停只有把本应用设成手动管理、三项全开这一条路
   * （10-18 华为实测）。返回打开的是启动管理页（launch）、本应用的应用信息页（details，EMUI 里再点「电池」）
   * 还是没打开（none：iOS / 原生包比 JS 旧）
   */
  openAppLaunchSettings(): "launch" | "details" | "none" {
    if (typeof native?.openAppLaunchSettings !== "function") return "none";
    const r = native.openAppLaunchSettings();
    return r === "launch" || r === "details" ? r : "none";
  },
};
