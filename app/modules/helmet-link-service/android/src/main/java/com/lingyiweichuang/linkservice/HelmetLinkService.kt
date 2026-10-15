package com.lingyiweichuang.linkservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * BLE 头盔链路前台服务（决策 #41）：本身不做任何蓝牙操作，只是让进程在退后台/锁屏后不被系统回收，
 * 真正的扫描/连接/中转仍在 JS 线程（services/ble-link.ts）。通知文案由 JS 按当前语言传入。
 */
class HelmetLinkService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: getString(R.string.helmet_link_channel_name)
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    ensureChannel()
    val notification = buildNotification(title, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    running = true
    // 系统因内存回收后自动重启服务（Intent 保留），配合 JS 端启动时的重连
    return START_REDELIVER_INTENT
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    // 每次都建：通道已存在时系统只更新名字和说明（重要程度等用户改过的设置不动），
    // 这样老用户手机上原来的英文名「Helmet link」也会换成跟系统语言走的名字
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.helmet_link_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = getString(R.string.helmet_link_channel_description)
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(title: String, text: String): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val pending = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION") Notification.Builder(this)
    }
    return builder
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .apply { if (pending != null) setContentIntent(pending) }
      .build()
  }

  companion object {
    const val CHANNEL_ID = "helmet_link"
    const val NOTIFICATION_ID = 0x4C4E // "LN"
    const val ACTION_STOP = "com.lingyiweichuang.linkservice.STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    @Volatile var running = false
  }
}
