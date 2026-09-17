package com.lingyiweichuang.linkservice

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HelmetLinkServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

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
      context.stopService(Intent(context, HelmetLinkService::class.java))
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
