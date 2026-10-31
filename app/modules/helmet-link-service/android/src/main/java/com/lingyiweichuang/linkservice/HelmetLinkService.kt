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
import android.util.Log
import java.util.concurrent.atomic.AtomicInteger

/**
 * BLE 头盔链路前台服务（决策 #41）：本身不做任何蓝牙操作，只是让进程在退后台/锁屏后不被系统回收，
 * 真正的扫描/连接/中转仍在 JS 线程（services/ble-link.ts）。通知文案由 JS 按当前语言传入。
 *
 * 2026-10-17 起对讲也用这个服务：在房期间加上 microphone 类型——Android 11 起退到后台 / 锁屏后，
 * 没有这一类前台服务的 App 麦克风被系统静音，对端只听到静音。头盔链路（linkOn）和对讲（micOn）各自开关，
 * 类型按当前开着的那几样声明，两样都不用了才退出；开着对讲时通知写对讲。
 */
class HelmetLinkService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_MIC) {
      if (!linkOn && !micOn) {
        // 起服务的 Intent 还没送到就又撤了（断网时点进入、马上失败）：startForegroundService 之后
        // 必须 startForeground 一次，否则系统判 App 崩溃。露个面就收掉
        try {
          startTyped(true)
        } catch (e: RuntimeException) {
          Log.w(TAG, "foreground start refused", e)
        }
        stopSelf()
      } else {
        applyForeground()
      }
      // 开关由模块先写进 micOn；进程被回收后对讲早就不在了，这个 Intent 不要重新送回来
      return START_NOT_STICKY
    }
    // 这条启动 Intent 送到了，不再算「在路上」（进程被回收时还没送到的 Intent 系统会在新进程里补送，新进程没有计数，钳在 0）
    val stillPending = pendingStarts.updateAndGet { (it - 1).coerceAtLeast(0) }
    if (stopRequested) {
      // 启动 Intent 还在路上时 JS 就撤了（登录态失效的被动登出紧跟在链路启动之后，10-24 Android 17 模拟器实测相隔 220 ms）：
      // startForegroundService 之后必须 startForeground 一次，否则系统按「前台服务没按时露面」把整个 App 杀掉
      // （ForegroundServiceDidNotStartInTimeException）。露个面就收掉；后面还有在路上的启动 Intent 时标记留着，等它们都到齐
      if (stillPending == 0) stopRequested = false
      linkOn = false
      showBriefly()
      stopSelf()
      return START_NOT_STICKY
    }
    linkOn = true
    linkTitle = intent?.getStringExtra(EXTRA_TITLE) ?: getString(R.string.helmet_link_channel_name)
    linkText = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    applyForeground()
    // 进程被杀后不让系统把服务重启回来：重启只有服务、没有 JS（React 要等有 Activity 才起），也就没有蓝牙和中转，
    // 通知却又挂上「已连接」，违背「未执行绝不显示成功」；Android 12+ 后台重启时 startForeground 还可能被拒成崩溃循环。
    // 链路在用户重新打开 App 时由 JS 重新建立、再次 start（华为手动清后台本来也拉不回，DEVELOPMENT 2026-09-16）
    return START_NOT_STICKY
  }

  /** 只为满足「startForegroundService 之后必须 startForeground」露一面，紧接着就会 stopSelf */
  private fun showBriefly() {
    ensureChannel()
    try {
      val notification = buildNotification(linkTitle, linkText)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: RuntimeException) {
      Log.w(TAG, "foreground start refused", e)
    }
  }

  override fun onDestroy() {
    running = false
    linkOn = false
    micOn = false
    if (instance === this) instance = null
    super.onDestroy()
  }

  /** 按头盔链路 / 对讲此刻开着哪几样重新声明前台服务类型；两样都不用了就退出 */
  fun applyForeground() {
    if (!linkOn && !micOn) {
      stopSelf()
      return
    }
    ensureChannel()
    try {
      startTyped(micOn)
    } catch (e: RuntimeException) {
      // 麦克风类型被系统拒（Android 14：不在前台 / 没有录音权限）：退回只连头盔，别让整个服务一起起不来
      if (!micOn) throw e
      Log.w(TAG, "microphone foreground type refused", e)
      micOn = false
      if (!linkOn) {
        stopSelf()
        return
      }
      startTyped(false)
    }
    running = true
  }

  private fun startTyped(mic: Boolean) {
    val notification =
      if (mic) buildNotification(micTitle, micText) else buildNotification(linkTitle, linkText)
    when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> {
        var type = 0
        if (linkOn) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        if (mic) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        startForeground(NOTIFICATION_ID, notification, type)
      }
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && linkOn ->
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      // Android 10 只开对讲 / 更老的系统：还没有按类型管麦克风，有前台服务就行（类型取清单里声明的）
      else -> startForeground(NOTIFICATION_ID, notification)
    }
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
      .setContentTitle(title.ifEmpty { getString(R.string.helmet_link_channel_name) })
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .apply { if (pending != null) setContentIntent(pending) }
      .build()
  }

  companion object {
    private const val TAG = "HelmetLinkService"
    const val CHANNEL_ID = "helmet_link"
    const val NOTIFICATION_ID = 0x4C4E // "LN"
    const val ACTION_STOP = "com.lingyiweichuang.linkservice.STOP"
    const val ACTION_MIC = "com.lingyiweichuang.linkservice.MIC"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    @Volatile var running = false
    /** 头盔链路要前台服务（JS start / stop） */
    @Volatile var linkOn = false
    /** 模块已发出、服务还没收到的启动 Intent 数（有在路上的就不能 stopService，见模块 stop） */
    val pendingStarts = AtomicInteger(0)
    /** 启动 Intent 还在路上时 JS 已经叫停：服务收到后露个面就收掉，而不是由模块 stopService */
    @Volatile var stopRequested = false
    /** 对讲在房、要麦克风类型（JS setMicrophone） */
    @Volatile var micOn = false
    @Volatile var linkTitle = ""
    @Volatile var linkText = ""
    @Volatile var micTitle = ""
    @Volatile var micText = ""
    /** 正在运行的实例：撤掉一样时直接在它身上重新声明类型，不再发 Intent（这时 App 可能已在后台） */
    @Volatile var instance: HelmetLinkService? = null
  }
}
