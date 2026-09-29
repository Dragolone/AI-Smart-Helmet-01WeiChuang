// 头盔 SoftAP 近场 Wi-Fi（DEVICE_PROTOCOL §1.3、决策 #37/#49）。
// Android：程序化连热点并把本进程绑到该网络（否则 RTSP 走 4G 黑屏）；绑定期间 App 连不上云端。
// iOS：NEHotspotConfiguration joinOnce，退后台 / 锁屏由系统自动断开。
import { requireOptionalNativeModule } from "expo-modules-core";

/** 原生侧 reject 的错误码 */
export type HelmetWifiErrorCode =
  | "MANUAL_REQUIRED"
  | "UNAVAILABLE"
  | "USER_DENIED"
  | "BIND_FAILED"
  | "UNSUPPORTED"
  | "PERMISSION_DENIED"
  | "SAVE_FAILED";

interface Subscription {
  remove(): void;
}

interface NativeHelmetWifi {
  canConnectProgrammatically(): boolean;
  connect(ssid: string, passphrase: string, timeoutMs: number): Promise<void>;
  bindToWifi(): boolean;
  release(): void;
  openWifiSettings(): void;
  saveImage(path: string): Promise<void>;
  addListener(event: "onWifiLost", listener: () => void): Subscription;
}

const native = requireOptionalNativeModule<NativeHelmetWifi>("HelmetWifi");

export const HelmetWifi = {
  /** 原生已链接（模拟器 / 未 prebuild / jest 时为 false） */
  available: native !== null,
  canConnectProgrammatically(): boolean {
    return native?.canConnectProgrammatically() ?? false;
  },
  connect(ssid: string, passphrase: string, timeoutMs = 30_000): Promise<void> {
    if (!native)
      return Promise.reject(
        Object.assign(new Error("unavailable"), { code: "UNAVAILABLE" }),
      );
    return native.connect(ssid, passphrase, timeoutMs);
  },
  bindToWifi(): boolean {
    return native?.bindToWifi() ?? false;
  },
  release(): void {
    native?.release();
  },
  openWifiSettings(): void {
    native?.openWifiSettings();
  },
  saveImage(path: string): Promise<void> {
    if (!native)
      return Promise.reject(
        Object.assign(new Error("unavailable"), { code: "UNSUPPORTED" }),
      );
    return native.saveImage(path);
  },
  onWifiLost(listener: () => void): Subscription {
    return native?.addListener("onWifiLost", listener) ?? { remove() {} };
  },
};
