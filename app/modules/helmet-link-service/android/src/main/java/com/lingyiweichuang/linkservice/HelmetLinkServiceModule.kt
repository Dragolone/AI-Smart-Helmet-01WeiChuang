package com.lingyiweichuang.linkservice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HelmetLinkServiceModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

  private companion object {
    const val TAG = "HelmetLinkService"
    const val ALARM_START_VOLUME = 0.4f
    const val ALARM_RAMP_STEP = 0.1f
    const val ALARM_RAMP_INTERVAL_MS = 1_500L
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  // Wi-Fi 锁的 acquire 不带超时，到点要自己放：不可恢复错误丢队列、退出登录、注销之后队列为空，JS 再也不会调 releaseNetwork。
  // 续期在 JS 线程、到点在主线程，判断 isHeld 和放锁要连着做（这把锁是计数的，多放一次会抛异常）
  private val networkHandler = Handler(Looper.getMainLooper())
  private val wifiLockGuard = Any()
  private val wifiLockTimeout = Runnable { releaseWifiLock() }

  // —— 求救倒计时警报（F15，2026-10-20 华为实测）——
  // expo-audio 把播放器写死成媒体用途（USAGE_MEDIA）：手机静音 / 媒体音量 0 时倒计时完全无声，只剩每秒 60 ms 的弱震动。
  // 这里改用闹钟用途循环播放：走闹钟音量、不受铃声静音影响、勿扰模式下默认放行；音量从 40% 渐升到满，误报时不至于一上来就最响
  private var alarmPlayer: MediaPlayer? = null
  private var alarmFocus: AudioFocusRequest? = null
  // 开始时记下应用级 Context：停的时候 reactContext 可能已经没了（JS 重载、页面销毁），焦点和震动照样要还
  private var alarmCtx: Context? = null
  // 播放器起不来时只剩震动，也算在响：最后 10 秒照样换急促
  private var alarmOn = false
  private var alarmVolume = ALARM_START_VOLUME
  private val alarmHandler = Handler(Looper.getMainLooper())
  private val alarmRamp = object : Runnable {
    override fun run() {
      val p = alarmPlayer ?: return
      alarmVolume = (alarmVolume + ALARM_RAMP_STEP).coerceAtMost(1f)
      try {
        p.setVolume(alarmVolume, alarmVolume)
      } catch (e: IllegalStateException) {
        return
      }
      if (alarmVolume < 1f) alarmHandler.postDelayed(this, ALARM_RAMP_INTERVAL_MS)
    }
  }
  // 兜底：停警报靠 JS，而 App 在后台时安卓的 JS 定时器不跑、实时通道断了也不会重连——单子在别处结束了也收不到。
  // 原生侧到点自己停，不会一直响下去（时长由 JS 按截止时间 + 余量给）
  private val alarmWatchdog = Runnable {
    Log.w(TAG, "SOS alarm stopped by watchdog")
    stopAlarm()
  }

  override fun definition() = ModuleDefinition {
    Name("HelmetLinkService")

    /** 求救倒计时开始：闹钟用途循环播放警报 + 满幅震动（重复调用不叠加）；maxMs 后没人叫停就自己停 */
    Function("startSosAlarm") { maxMs: Int ->
      onMain { startAlarm(maxMs.toLong()) }
    }

    /** 倒计时结束 / 取消 / 页面离开：停声、停震、还音频焦点 */
    Function("stopSosAlarm") { ->
      onMain { stopAlarm() }
    }

    /** 最后 10 秒：震动换成每秒两下（声音不变） */
    Function("setSosAlarmUrgent") { urgent: Boolean ->
      onMain { alarmCtx?.let { if (alarmOn) vibrateAlarm(it, urgent) } }
    }

    OnDestroy {
      stopAlarm()
      releaseNetworkLocks()
    }

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
      networkHandler.removeCallbacks(wifiLockTimeout)
      synchronized(wifiLockGuard) {
        val fl = wifiLock ?: wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "helmet:uplink").also { wifiLock = it }
        if (!fl.isHeld) fl.acquire()
      }
      networkHandler.postDelayed(wifiLockTimeout, timeout)
    }

    Function("releaseNetwork") { ->
      releaseNetworkLocks()
    }

    /** 起前台服务并显示常驻通知（重复调用只刷新文案） */
    Function("start") { title: String, text: String ->
      val intent = Intent(context, HelmetLinkService::class.java)
        .putExtra(HelmetLinkService.EXTRA_TITLE, title)
        .putExtra(HelmetLinkService.EXTRA_TEXT, text)
      // 先登记再发：服务收到这条 Intent 时会减回去；stop 看到还有在路上的就不 stopService
      HelmetLinkService.stopRequested = false
      HelmetLinkService.pendingStarts.incrementAndGet()
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (e: Exception) {
        HelmetLinkService.pendingStarts.updateAndGet { (it - 1).coerceAtLeast(0) }
        throw e
      }
    }

    Function("stop") { ->
      HelmetLinkService.linkOn = false
      if (HelmetLinkService.micOn) {
        // 对讲还在房里（比如锁屏通话中头盔断开）：只撤掉连接外设这一样，麦克风那一样不能跟着没了。
        // 服务还没起来（刚发出的对讲 Intent 还没送到）时不 stopService：那边起来后按 micOn 只开对讲
        HelmetLinkService.instance?.let { service -> onMain { service.applyForeground() } }
      } else if (HelmetLinkService.pendingStarts.get() == 0) {
        context.stopService(Intent(context, HelmetLinkService::class.java))
      } else {
        // 刚发出的启动 Intent 还没送到（服务还没来得及 startForeground）：这时 stopService 会让系统判
        // 「前台服务没按时露面」、把整个 App 杀掉（ForegroundServiceDidNotStartInTimeException；10-24 Android 17
        // 模拟器实测：登录态失效的被动登出紧跟在链路启动之后 220 ms，首次冷启动就崩）。
        // 改为留下标记，让服务收到 Intent 后露一面再自己收掉
        HelmetLinkService.stopRequested = true
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

    /**
     * 打开系统的「应用启动管理」（华为 / 荣耀）。华为上从多任务划掉 App = 系统强停、之后求救推送到不了，
     * 只有把本应用设成手动管理、三项全开才不会（10-18 华为 P30 Pro 实测，REGRESSION 4.8）。
     * 能直接开那一页就开（老系统）；新系统那两页要 com.huawei.permission.external_app_settings.USE_COMPONENT、
     * 第三方拿不到，就开本应用的应用信息页（P30 Pro 上再点「耗电详情」→「启动管理」；耗电详情页
     * DetailOfSoftConsumptionActivity 也要同一权限，不能直接开，10-18 adb 实测）。返回打开的是哪一种（launch / details / none）
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

  private fun releaseNetworkLocks() {
    wakeLock?.let { if (it.isHeld) it.release() }
    releaseWifiLock()
  }

  private fun releaseWifiLock() {
    networkHandler.removeCallbacks(wifiLockTimeout)
    synchronized(wifiLockGuard) {
      wifiLock?.let { if (it.isHeld) it.release() }
    }
  }

  private fun startAlarm(maxMs: Long) {
    if (alarmOn) return
    val ctx = appContext.reactContext?.applicationContext ?: return
    alarmOn = true
    alarmCtx = ctx
    alarmHandler.postDelayed(alarmWatchdog, maxMs)
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    try {
      val p = MediaPlayer()
      ctx.resources.openRawResourceFd(R.raw.sos_alarm).use { afd ->
        p.setAudioAttributes(attrs)
        p.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
      }
      p.isLooping = true
      alarmVolume = ALARM_START_VOLUME
      p.setVolume(alarmVolume, alarmVolume)
      p.prepare()
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attrs)
        .build()
      am.requestAudioFocus(focus)
      alarmFocus = focus
      p.start()
      alarmPlayer = p
      alarmHandler.postDelayed(alarmRamp, ALARM_RAMP_INTERVAL_MS)
    } catch (e: Exception) {
      // 放不出声也绝不能把倒计时页带崩：震动照常、页面照常
      Log.w(TAG, "SOS alarm (alarm stream) failed to start", e)
      releaseAlarmPlayer()
    }
    vibrateAlarm(ctx, false)
  }

  private fun stopAlarm() {
    alarmHandler.removeCallbacks(alarmRamp)
    alarmHandler.removeCallbacks(alarmWatchdog)
    releaseAlarmPlayer()
    val ctx = alarmCtx ?: appContext.reactContext?.applicationContext
    alarmOn = false
    alarmCtx = null
    if (ctx == null) return
    alarmFocus?.let { (ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(it) }
    alarmFocus = null
    vibrator(ctx)?.cancel()
  }

  private fun releaseAlarmPlayer() {
    alarmPlayer?.let {
      try {
        if (it.isPlaying) it.stop()
      } catch (e: IllegalStateException) {
        // 已经停了
      }
      it.release()
    }
    alarmPlayer = null
  }

  private fun vibrator(ctx: Context): Vibrator? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

  /** 普通：每秒一下 400 ms；急促（最后 10 秒）：每秒两下 200 ms。满幅、闹钟用途（静音模式下照震） */
  private fun vibrateAlarm(ctx: Context, urgent: Boolean) {
    val vib = vibrator(ctx) ?: return
    if (!vib.hasVibrator()) return
    val timings = if (urgent) longArrayOf(0, 200, 100, 200, 500) else longArrayOf(0, 400, 600)
    val amplitudes = if (urgent) intArrayOf(0, 255, 0, 255, 0) else intArrayOf(0, 255, 0)
    val effect = if (vib.hasAmplitudeControl()) {
      VibrationEffect.createWaveform(timings, amplitudes, 0)
    } else {
      VibrationEffect.createWaveform(timings, 0)
    }
    vib.cancel()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      vib.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
    } else {
      @Suppress("DEPRECATION")
      vib.vibrate(effect, AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
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
