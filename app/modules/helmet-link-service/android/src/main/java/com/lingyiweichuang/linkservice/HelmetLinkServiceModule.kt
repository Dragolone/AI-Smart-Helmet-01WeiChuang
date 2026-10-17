package com.lingyiweichuang.linkservice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HelmetLinkServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

  private companion object {
    const val TAG = "HelmetLinkService"
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun definition() = ModuleDefinition {
    Name("HelmetLinkService")

    /**
     * 高危事件待上传期间短暂持锁：CPU 部分唤醒 + Wi-Fi 高性能锁，最多 ms 毫秒自动释放。
     * 华为息屏深睡后 App 网络被挂起（2026-09-16 实测：BLE 照常 ACK，HTTP 4 小时发不出去），
     * 保命事件不能等系统心情好；周期事件不持锁。
     */
    Function("holdNetwork") { ms: Int ->
      val timeout = ms.coerceIn(1_000, 5 * 60_000).toLong()
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      val wl = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "helmet:uplink").also { wakeLock = it }
      if (!wl.isHeld) wl.acquire(timeout) else { wl.release(); wl.acquire(timeout) }
      val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      val fl = wifiLock ?: wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "helmet:uplink").also { wifiLock = it }
      if (!fl.isHeld) fl.acquire()
    }

    Function("releaseNetwork") { ->
      wakeLock?.let { if (it.isHeld) it.release() }
      wifiLock?.let { if (it.isHeld) it.release() }
    }

    /** 起前台服务并显示常驻通知（重复调用只刷新文案） */
    Function("start") { title: String, text: String ->
      val intent = Intent(context, HelmetLinkService::class.java)
        .putExtra(HelmetLinkService.EXTRA_TITLE, title)
        .putExtra(HelmetLinkService.EXTRA_TEXT, text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    Function("stop") { ->
      HelmetLinkService.linkOn = false
      if (HelmetLinkService.micOn) {
        // 对讲还在房里（比如锁屏通话中头盔断开）：只撤掉连接外设这一样，麦克风那一样不能跟着没了。
        // 服务还没起来（刚发出的对讲 Intent 还没送到）时不 stopService：那边起来后按 micOn 只开对讲
        HelmetLinkService.instance?.let { service -> onMain { service.applyForeground() } }
      } else {
        context.stopService(Intent(context, HelmetLinkService::class.java))
      }
    }

    /**
     * 对讲在房期间给前台服务加上 / 撤掉麦克风类型（Android 11 起锁屏后没有这一类的 App 麦克风被系统静音）。
     * 加：Android 14 起只许在 App 在前台、已有录音权限时加（JS 只在前台时调）；没有权限、系统不许起服务时返回 false。
     * 服务已经在跑也照样发一次 Intent：让系统按「此刻在前台」重新核定这个服务能不能用麦克风。
     * 撤：直接在运行中的实例上重新声明类型（这时 App 可能已在后台，不能再起服务）
     */
    Function("setMicrophone") { on: Boolean, title: String, text: String ->
      if (!on) {
        if (HelmetLinkService.micOn) {
          HelmetLinkService.micOn = false
          HelmetLinkService.instance?.let { service -> onMain { service.applyForeground() } }
        }
        true
      } else if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        false
      } else {
        HelmetLinkService.micTitle = title
        HelmetLinkService.micText = text
        HelmetLinkService.micOn = true
        try {
          val intent = Intent(context, HelmetLinkService::class.java).setAction(HelmetLinkService.ACTION_MIC)
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
          } else {
            context.startService(intent)
          }
          true
        } catch (e: Exception) {
          // Android 12+ 在后台起前台服务会被拒（ForegroundServiceStartNotAllowedException）
          Log.w(TAG, "microphone foreground service not started", e)
          HelmetLinkService.micOn = false
          false
        }
      }
    }

    Function("isRunning") { -> HelmetLinkService.running }

    /** 是否已加入省电白名单（华为/小米等激进杀后台的机型未加入时链路随时可能被杀） */
    Function("isIgnoringBatteryOptimizations") { ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        true
      } else {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        pm.isIgnoringBatteryOptimizations(context.packageName)
      }
    }

    /** 拉起系统「忽略电池优化」对话框；机型不支持时退到电池优化设置页 */
    Function("requestIgnoreBatteryOptimizations") { ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) openBatterySettings()
    }
  }

  /** 前台服务的类型变更放到主线程做（onStartCommand 也在主线程），出错只记日志：撤不掉不能把 App 带崩 */
  private fun onMain(block: () -> Unit) {
    Handler(Looper.getMainLooper()).post {
      try {
        block()
      } catch (e: RuntimeException) {
        Log.w(TAG, "foreground service update failed", e)
      }
    }
  }

  private fun openBatterySettings() {
      val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val intent = if (direct.resolveActivity(context.packageManager) != null) direct else fallback
      context.startActivity(intent)
  }
}
