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
  openAppLaunchSettings(): string;
  startSosAlarm(maxMs: number): void;
  stopSosAlarm(): void;
  setSosAlarmUrgent(urgent: boolean): void;
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NativeLinkService>("HelmetLinkService")
    : null;

/**
 * 网络锁持到什么时刻。原生一次只记一把锁、再调就按新时长重新拿：周期事件的 20 s 会把保命事件刚拿的 90 s
 * 截短（10-25 审查）。这里只让它往后延，不往前缩
 */
let heldUntil = 0;
/** 上面那个时刻是什么时候算的。手机时钟往回拨过（now 比它早）heldUntil 就不可信了：不复位的话算出来一直「还持着」，高危事件的持锁被跳过 */
let heldAt = 0;

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
    const now = Date.now();
    if (now < heldAt) heldUntil = 0;
    const until = now + ms;
    if (until <= heldUntil) return;
    heldUntil = until;
    heldAt = now;
    // 原生包可能比 JS 旧（dev client 热更）：方法不存在时静默跳过，绝不让上传链路因此失败
    if (typeof native?.holdNetwork === "function") native.holdNetwork(ms);
  },
  releaseNetwork(): void {
    heldUntil = 0;
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
  /**
   * 打开系统「应用启动管理」（华为 / 荣耀）：划掉 App 不被强停只有把本应用设成手动管理、三项全开这一条路
   * （10-18 华为实测）。返回打开的是启动管理页（launch）、本应用的应用信息页（details，EMUI 里再点「电池」）
   * 还是没打开（none：iOS / 原生包比 JS 旧）
   */
  /**
   * 安卓求救倒计时警报走闹钟通道（F15）：expo-audio 是媒体用途，手机静音 / 媒体音量 0 时完全无声。
   * 原生包比 JS 旧（还没有这些方法）或 iOS 时为 false，调用方退回原来的 expo-audio + 触感
   */
  get sosAlarmAvailable(): boolean {
    return typeof native?.startSosAlarm === "function";
  },
  /** maxMs：没人叫停时原生最多响多久（App 在后台时 JS 可能停不了它） */
  startSosAlarm(maxMs: number): void {
    if (typeof native?.startSosAlarm === "function")
      native.startSosAlarm(Math.round(maxMs));
  },
  stopSosAlarm(): void {
    if (typeof native?.stopSosAlarm === "function") native.stopSosAlarm();
  },
  setSosAlarmUrgent(urgent: boolean): void {
    if (typeof native?.setSosAlarmUrgent === "function")
      native.setSosAlarmUrgent(urgent);
  },
  openAppLaunchSettings(): "launch" | "details" | "none" {
    if (typeof native?.openAppLaunchSettings !== "function") return "none";
    const r = native.openAppLaunchSettings();
    return r === "launch" || r === "details" ? r : "none";
  },
};
