package com.lingyiweichuang.linkservice

import android.app.Application
import android.content.Context
import android.util.Log
import cn.jpush.android.api.JPushInterface

/**
 * 极光推送的提前初始化（2026-10-18，补充决策 #48）。
 *
 * 极光 SDK 原来只在 JS 跑起来、用户同意过隐私政策之后初始化（services/push.ts）。华为上从多任务划掉 App =
 * 系统强停，之后 HMS 会刷新推送令牌并把进程悄悄拉起一小截来送新令牌（logcat `onNewToken`）——这时 JS 没跑，
 * 极光 SDK 没初始化，新令牌报不上去，极光服务器还按旧令牌推，划掉之后的求救推送一条都到不了，直到用户再打开 App
 * （10-18 华为 P30 Pro 正式包实测，REGRESSION 4.8）。
 *
 * 这里在 Application.onCreate 里、**只在用户之前同意过隐私政策时**初始化（同意标记由 JS 在同意时写进原生偏好，
 * 见 HelmetLinkServiceModule.setPrivacyAccepted）。没同意过的新装用户照旧什么都不做，合规口径不变。
 * 做的事和 jpush-react-native 的 init() 一样：JPushInterface.init + 通知回调开关；JS 之后再调一次 init 是幂等的。
 */
object HelmetPushBoot {
  private const val TAG = "HelmetPushBoot"
  const val PREFS = "helmet_push"
  const val KEY_PRIVACY_ACCEPTED = "privacy_accepted"

  fun setPrivacyAccepted(context: Context, accepted: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putBoolean(KEY_PRIVACY_ACCEPTED, accepted)
      .apply()
  }

  fun isPrivacyAccepted(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_PRIVACY_ACCEPTED, false)

  /** MainApplication.onCreate 里调（plugins/with-jpush.js 生成那一行） */
  @JvmStatic
  fun onCreate(application: Application) {
    if (!isPrivacyAccepted(application)) return
    try {
      JPushInterface.setDebugMode(false)
      JPushInterface.init(application)
      JPushInterface.setNotificationCallBackEnable(application, true)
      Log.i(TAG, "JPush initialized at Application.onCreate (privacy accepted earlier)")
    } catch (e: RuntimeException) {
      // 极光初始化失败不能把 App 带崩：JS 起来后还会再初始化一次
      Log.w(TAG, "early JPush init failed", e)
    }
  }
}
