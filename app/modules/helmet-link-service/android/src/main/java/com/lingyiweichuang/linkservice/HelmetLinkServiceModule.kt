package com.lingyiweichuang.linkservice

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
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

    /**
     * 打开系统的「应用启动管理」（华为 / 荣耀）。华为上从多任务划掉 App = 系统强停、之后求救推送到不了，
     * 只有把本应用设成手动管理、三项全开才不会（10-18 华为 P30 Pro 实测，REGRESSION 4.8）。
     * 能直接开那一页就开（老系统）；新系统那两页要 com.huawei.permission.external_app_settings.USE_COMPONENT、
     * 第三方拿不到，就开本应用的应用信息页。返回打开的是哪一种（launch / details / none），JS 据此提示
     */
    Function("openAppLaunchSettings") { ->
      val direct = launchManagerIntent()
      if (direct != null && tryStart(direct)) {
        "launch"
      } else if (tryStart(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))) {
        "details"
      } else {
        "none"
      }
    }

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

  /**
   * 找一个本应用有权直接打开的「应用启动管理」页。隐式 action 在华为上匹配到两页，resolveActivity 会给系统选择器、
   * 选了也会因权限打不开，所以逐个看匹配到的页面：要求的权限拿不到就跳过；一个都不行返回 null
   */
  private fun launchManagerIntent(): Intent? {
    val pm = context.packageManager
    val candidates = listOf(
      Intent("huawei.intent.action.HSM_STARTUPAPP_MANAGER"),
      Intent("huawei.intent.action.HSM_BOOTAPP_MANAGER"),
      Intent().setClassName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
      Intent().setClassName("com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"),
      Intent().setClassName("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
    )
    for (intent in candidates) {
      for (match in pm.queryIntentActivities(intent, 0)) {
        val info = match.activityInfo ?: continue
        if (!info.exported) continue
        val permission = info.permission
        if (permission != null && context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) continue
        return Intent(intent).setClassName(info.packageName, info.name)
      }
    }
    return null
  }

  private fun tryStart(intent: Intent): Boolean =
    try {
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    } catch (e: Exception) {
      Log.w("HelmetLinkService", "start failed: ${intent.component ?: intent.action}", e)
      false
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
