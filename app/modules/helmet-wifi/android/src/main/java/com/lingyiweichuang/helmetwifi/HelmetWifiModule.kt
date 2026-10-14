package com.lingyiweichuang.helmetwifi

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * 头盔 SoftAP 近场通道（DEVICE_PROTOCOL §1.3）。
 *
 * 为什么要绑进程：头盔热点没有互联网，Android 会继续把默认路由留在蜂窝网络上，
 * 不绑的话 RTSP 连接走 4G，表现为「已连上热点但黑屏超时」。bindProcessToNetwork
 * 对本进程所有 socket 生效（含 libVLC 的原生 socket），代价是绑定期间 App 连不上云端，
 * 所以只在预览页前台期间持有，离开 / 退后台 / 收到求救事件立即 release。
 */
class HelmetWifiModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

  private val connectivity: ConnectivityManager
    get() = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  private var callback: ConnectivityManager.NetworkCallback? = null

  override fun definition() = ModuleDefinition {
    Name("HelmetWifi")

    Events("onWifiLost")

    /** Android 10+ 才能由 App 发起连接（WifiNetworkSpecifier）；8/9 只能引导用户去系统设置手动连 */
    Function("canConnectProgrammatically") { ->
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
    }

    /**
     * 系统弹窗让用户确认连接头盔热点，连上后把本进程绑到该网络。
     * 用户拒绝 / 附近找不到 / 超时 → UNAVAILABLE。
     */
    AsyncFunction("connect") { ssid: String, passphrase: String, timeoutMs: Int, promise: Promise ->
      doConnect(ssid, passphrase, timeoutMs, sae = false, promise)
    }

    /**
     * 开发期用：按 WPA3（SAE）请求。Android 10 把「WPA2/WPA3 混合」的热点一律归为 WPA3，按 WPA2 请求永远匹配不上
     * （2026-10-14 华为 P30 Pro 对 iPhone 热点实测）；真头盔是纯 WPA2，正式路径不走这里。iOS 没有这个函数。
     */
    AsyncFunction("connectSae") { ssid: String, passphrase: String, timeoutMs: Int, promise: Promise ->
      doConnect(ssid, passphrase, timeoutMs, sae = true, promise)
    }

    /**
     * 用户已在系统设置里手动连上头盔热点（Android 8/9，或程序化连接失败后的兜底）：
     * 找到当前 Wi-Fi 网络并绑定。找不到 Wi-Fi 返回 false。
     */
    Function("bindToWifi") { ->
      val wifi = connectivity.allNetworks.firstOrNull { network ->
        connectivity.getNetworkCapabilities(network)
          ?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
      }
      if (wifi == null) false else connectivity.bindProcessToNetwork(wifi)
    }

    /** 解绑并断开 App 发起的热点连接，手机回到原来的网络 */
    Function("release") { ->
      releaseInternal()
    }

    Function("openWifiSettings") { ->
      context.startActivity(
        Intent(Settings.ACTION_WIFI_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }

    /** 把截图文件存进系统相册「Pictures/零一唯创」。Android 10 以下需存储权限（已被合规屏蔽），不支持 */
    AsyncFunction("saveImage") { path: String, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        promise.reject("UNSUPPORTED", "Android 10 以下暂不支持保存到相册", null)
        return@AsyncFunction
      }
      val source = File(path.removePrefix("file://"))
      if (!source.exists()) {
        promise.reject("SAVE_FAILED", "截图文件不存在", null)
        return@AsyncFunction
      }
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, "helmet_${System.currentTimeMillis()}.png")
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/零一唯创")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
      if (uri == null) {
        promise.reject("SAVE_FAILED", "无法写入相册", null)
        return@AsyncFunction
      }
      try {
        resolver.openOutputStream(uri)?.use { out -> source.inputStream().use { it.copyTo(out) } }
        values.clear()
        values.put(MediaStore.Images.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        promise.resolve(null)
      } catch (e: Exception) {
        resolver.delete(uri, null, null)
        promise.reject("SAVE_FAILED", e.message, e)
      }
    }

    OnDestroy {
      releaseInternal()
    }
  }

  private fun doConnect(ssid: String, passphrase: String, timeoutMs: Int, sae: Boolean, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      promise.reject("MANUAL_REQUIRED", "Android 10 以下需在系统设置里手动连接", null)
      return
    }
    releaseInternal()
    val specifierBuilder = WifiNetworkSpecifier.Builder().setSsid(ssid)
    val specifier = (if (sae) specifierBuilder.setWpa3Passphrase(passphrase) else specifierBuilder.setWpa2Passphrase(passphrase))
      .build()
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifier)
      .build()
    var settled = false
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        val bound = connectivity.bindProcessToNetwork(network)
        if (settled) return
        settled = true
        if (bound) {
          promise.resolve(null)
        } else {
          promise.reject("BIND_FAILED", "已连上头盔热点，但无法把 App 流量绑到该网络", null)
        }
      }

      override fun onUnavailable() {
        callback = null
        if (settled) return
        settled = true
        promise.reject("UNAVAILABLE", "未连上头盔热点（用户取消、不在附近或超时）", null)
      }

      override fun onLost(network: Network) {
        // 头盔关机 / 走远：立刻解绑，别让 App 卡在一个已经没了的网络上
        connectivity.bindProcessToNetwork(null)
        this@HelmetWifiModule.sendEvent("onWifiLost")
      }
    }
    callback = cb
    connectivity.requestNetwork(request, cb, timeoutMs.coerceIn(5_000, 120_000))
  }

  private fun releaseInternal() {
    // 模块销毁时 React 上下文可能已经没了：拿不到就只清引用，绑定会随进程结束
    val cm = appContext.reactContext
      ?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    cm?.bindProcessToNetwork(null)
    callback?.let {
      try {
        cm?.unregisterNetworkCallback(it)
      } catch (_: IllegalArgumentException) {
        // 已被系统注销（onUnavailable 之后）
      }
    }
    callback = null
  }
}
