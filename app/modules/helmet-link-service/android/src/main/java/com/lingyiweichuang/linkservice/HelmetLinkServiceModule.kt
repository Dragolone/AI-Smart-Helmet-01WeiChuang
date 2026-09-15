package com.lingyiweichuang.linkservice

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HelmetLinkServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

  override fun definition() = ModuleDefinition {
    Name("HelmetLinkService")

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
