import ExpoModulesCore
import NetworkExtension
import Photos
import UIKit

/// 头盔 SoftAP 近场通道（DEVICE_PROTOCOL §1.3）。
///
/// iOS 不需要（也不允许）绑进程：连上热点后发往 192.168.176.x 的流量天然走 Wi-Fi。
/// joinOnce = true：App 退后台约 15 s、锁屏或 App 退出时系统自动断开并删除该配置，
/// 手机回到原来的网络——正好是「只在预览页前台期间连头盔」的口径。
/// 需要 entitlement com.apple.developer.networking.HotspotConfiguration（App ID 勾 Hotspot）。
public final class HelmetWifiModule: Module {
  private var joinedSsid: String?

  public func definition() -> ModuleDefinition {
    Name("HelmetWifi")

    // 与 Android 同名；iOS 由 joinOnce 语义兜底，不主动发
    Events("onWifiLost")

    Function("canConnectProgrammatically") { () -> Bool in
      true
    }

    AsyncFunction("connect") { (ssid: String, passphrase: String, _: Int, promise: Promise) in
      let config = NEHotspotConfiguration(ssid: ssid, passphrase: passphrase, isWEP: false)
      config.joinOnce = true
      NEHotspotConfigurationManager.shared.apply(config) { error in
        guard let error = error as NSError? else {
          self.joinedSsid = ssid
          promise.resolve(nil)
          return
        }
        if error.domain == NEHotspotConfigurationErrorDomain {
          switch error.code {
          case NEHotspotConfigurationError.alreadyAssociated.rawValue:
            self.joinedSsid = ssid
            promise.resolve(nil)
          case NEHotspotConfigurationError.userDenied.rawValue:
            promise.reject("USER_DENIED", error.localizedDescription)
          default:
            promise.reject("UNAVAILABLE", error.localizedDescription)
          }
          return
        }
        promise.reject("UNAVAILABLE", error.localizedDescription)
      }
    }

    Function("bindToWifi") { () -> Bool in
      true
    }

    Function("release") {
      if let ssid = self.joinedSsid {
        NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
        self.joinedSsid = nil
      }
    }

    Function("openWifiSettings") {
      DispatchQueue.main.async {
        if let url = URL(string: UIApplication.openSettingsURLString) {
          UIApplication.shared.open(url)
        }
      }
    }

    /// 截图存入系统相册（仅「添加照片」权限，不读用户相册）
    AsyncFunction("saveImage") { (path: String, promise: Promise) in
      let url = path.hasPrefix("file://") ? URL(string: path) : URL(fileURLWithPath: path)
      guard let fileUrl = url, FileManager.default.fileExists(atPath: fileUrl.path) else {
        promise.reject("SAVE_FAILED", "截图文件不存在")
        return
      }
      PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
        guard status == .authorized || status == .limited else {
          promise.reject("PERMISSION_DENIED", "未允许添加照片")
          return
        }
        PHPhotoLibrary.shared().performChanges({
          PHAssetCreationRequest.creationRequestForAssetFromImage(atFileURL: fileUrl)
        }) { ok, err in
          if ok {
            promise.resolve(nil)
          } else {
            promise.reject("SAVE_FAILED", err?.localizedDescription ?? "保存失败")
          }
        }
      }
    }

    OnDestroy {
      if let ssid = self.joinedSsid {
        NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
      }
    }
  }
}
