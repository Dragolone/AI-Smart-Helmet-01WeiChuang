// Android 前台服务（决策 #41 低成本档）：让 BLE 头盔链路在退后台/锁屏后不被系统回收；
// 对讲在房期间再加上麦克风类型（Android 11 起锁屏后没有这一类的 App 麦克风被静音）。
// iOS 走 bluetooth-central / 后台音频模式（真机实测通过），本模块在 iOS 上全部为空操作。
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
  setMicrophone(on: boolean, title: string, text: string): boolean;
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
   * 对讲在房：给前台服务加上 / 撤掉麦克风类型，通知写 title / text。加只能在 App 在前台、已有录音权限时
   * （Android 14），否则返回 false；iOS、原生包比 JS 旧（还没有这个方法）时什么都不做
   */
  setMicrophone(on: boolean, title = "", text = ""): boolean {
    if (typeof native?.setMicrophone !== "function") return false;
    return native.setMicrophone(on, title, text);
  },
};
