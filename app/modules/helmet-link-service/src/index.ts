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
  setPrivacyAccepted(accepted: boolean): void;
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
   * 用户同意过隐私政策：写进原生偏好，Android 下次进程一起来就提前初始化极光（HelmetPushBoot）。
   * 划掉 App 后 HMS 刷新令牌时 JS 没跑，不提前初始化新令牌报不上去，推送就到不了（10-18 华为，REGRESSION 4.8）。
   * iOS、原生包比 JS 旧（还没有这个方法）时什么都不做
   */
  setPrivacyAccepted(accepted: boolean): void {
    if (typeof native?.setPrivacyAccepted === "function")
      native.setPrivacyAccepted(accepted);
  },
};
