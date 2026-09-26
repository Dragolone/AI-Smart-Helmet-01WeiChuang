// 极光推送（jpush-react-native 3.2.x）的 Expo config plugin（2026-09-24，决策 #10 / #48）。
// CNG 下 ios/ 与 android/ 都是 prebuild 产物不进 Git，所以极光要求手改的原生配置全部由这里生成：
//
// Android：manifestPlaceholders（JPUSH_PKGNAME / JPUSH_APPKEY / JPUSH_CHANNEL）+ 应用 manifest 的两条 meta-data。
//   RN 插件 3.2.6 起自己不带 meta-data，但极光 SDK 的 aar 仍从 meta-data 读 AppKey，Android 侧 init() 没有参数。
//   多余权限（READ_PHONE_STATE / 外部存储 / GET_TASKS / 后台定位）不在这里删，用 app.json `android.blockedPermissions`。
//
// iOS：AppDelegate.swift 补三块——① APNs deviceToken 交给极光；② 让 AppDelegate 实现 JPUSHRegisterDelegate
//   （RCTJPushModule 初始化时把 UIApplication.delegate 当作极光的回调对象，不实现就收不到点击事件）；
//   ③ 把 UNUserNotificationCenter 的回调**转发回 expo-notifications**——极光初始化会把 expo 设好的 delegate 顶掉，
//   不转发的话 SOS 锁屏本地通知的「取消/查看」按钮（services/sos-alert.ts）就全废了。
//   另外往 bridging header 加两行 #import（Swift 调 JPUSHService / RCTJPushEventQueue）。
//   **不在 AppDelegate 里初始化极光**：初始化必须等用户同意隐私政策之后由 JS 触发（services/push.ts）。
//
// 纯函数 apply*() 独立导出给单测（plugins/__tests__/with-jpush.test.ts）——补丁靠锚点正则，Expo 模板一变就会断，
// 单测拿真实模板做夹具，断了会先在 CI 红而不是在真机上黑屏。
const {
  withAppBuildGradle,
  withAndroidManifest,
  withAppDelegate,
  withInfoPlist,
  withDangerousMod,
  AndroidConfig,
  createRunOncePlugin,
} = require("expo/config-plugins");
const { mergeContents } = require("@expo/config-plugins/build/utils/generateCode");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_NAME = "with-jpush";

/** 从 app.json 拿配置：AppKey 是公开值放 extra.jpush，JS（services/push.ts）与原生共用同一份 */
function readJPushExtra(config) {
  const extra = (config.extra && config.extra.jpush) || {};
  if (!extra.appKey) {
    throw new Error(`[${PLUGIN_NAME}] app.json 缺 extra.jpush.appKey`);
  }
  return { appKey: String(extra.appKey), channel: String(extra.channel || "official") };
}

// ---------- Android ----------

function applyAppBuildGradle(contents, { appKey, channel }) {
  const block = [
    `        manifestPlaceholders = [`,
    `            JPUSH_PKGNAME: applicationId,`,
    `            JPUSH_APPKEY: "${appKey}",`,
    `            JPUSH_CHANNEL: "${channel}"`,
    `        ]`,
  ].join("\n");
  // mergeContents 锚不到会直接抛 ERR_NO_MATCH（不是静默跳过），这里换成一句看得懂的错误
  try {
    return mergeContents({
      src: contents,
      newSrc: block,
      tag: `${PLUGIN_NAME}-placeholders`,
      // Expo 模板：defaultConfig { applicationId 'com.xxx' ... }，插在 applicationId 那行之后
      anchor: /^\s*applicationId\s+['"]/m,
      offset: 1,
      comment: "//",
    }).contents;
  } catch (e) {
    throw new Error(`[${PLUGIN_NAME}] app/build.gradle 里找不到 applicationId 锚点（${e.message}）`);
  }
}

function applyAndroidManifest(androidManifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, "JPUSH_APPKEY", "${JPUSH_APPKEY}");
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, "JPUSH_CHANNEL", "${JPUSH_CHANNEL}");
  return androidManifest;
}

// ---------- iOS ----------

const BRIDGING_IMPORTS = ["#import <JPUSHService.h>", "#import <RCTJPushEventQueue.h>"];

function applyBridgingHeader(contents) {
  const tag = `${PLUGIN_NAME}-imports`;
  if (contents.includes(`@generated begin ${tag}`)) return contents; // 幂等
  try {
    return mergeContents({
      src: contents,
      newSrc: BRIDGING_IMPORTS.join("\n"),
      tag,
      anchor: /^\/\/$/m, // 模板首行是一句 `//` 注释
      offset: 0,
      comment: "//",
    }).contents;
  } catch {
    // 空文件或非模板：mergeContents 抛 ERR_NO_MATCH，追加到末尾即可（评审 2026-09-26：原「兜底」是死代码）
    const base = contents.trimEnd();
    return `${base ? `${base}\n` : ""}// @generated begin ${tag} - expo prebuild (DO NOT MODIFY)\n${BRIDGING_IMPORTS.join("\n")}\n// @generated end ${tag}\n`;
  }
}

/** Swift：AppDelegate 类体内追加的方法（APNs token 交极光） */
const SWIFT_CLASS_BODY = `
  // MARK: - JPush（plugins/with-jpush.js 生成）
  /// 极光初始化时 expo-notifications 已经是 UNUserNotificationCenter 的 delegate，会被极光顶掉；
  /// 在这里把它记下来，JPUSHRegisterDelegate 的回调再转发回去，SOS 锁屏本地通知的按钮才能继续工作。
  static var jpushForwardDelegate: UNUserNotificationCenterDelegate?

  public override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    JPUSHService.registerDeviceToken(deviceToken)
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }
`;

/** Swift：文件末尾追加的 extension（极光回调 + 转发 expo） */
const SWIFT_EXTENSION = `
// MARK: - JPUSHRegisterDelegate（plugins/with-jpush.js 生成）
extension AppDelegate: JPUSHRegisterDelegate {
  public func jpushNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (Int) -> Void
  ) {
    let userInfo = notification.request.content.userInfo
    if notification.request.trigger is UNPushNotificationTrigger {
      JPUSHService.handleRemoteNotification(userInfo)
      NotificationCenter.default.post(name: NSNotification.Name("J_APNS_NOTIFICATION_ARRIVED_EVENT"), object: userInfo)
    }
    if let forward = AppDelegate.jpushForwardDelegate,
       let method = forward.userNotificationCenter(_:willPresent:withCompletionHandler:) {
      // expo-notifications 决定前台要不要弹（SOS 本地通知需要横幅+声音）
      method(center, notification) { options in completionHandler(Int(options.rawValue)) }
      return
    }
    let options: UNNotificationPresentationOptions = [.badge, .sound, .banner, .list]
    completionHandler(Int(options.rawValue))
  }

  public func jpushNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    if response.notification.request.trigger is UNPushNotificationTrigger {
      JPUSHService.handleRemoteNotification(userInfo)
      // 被杀状态下点通知：JS 还没起来，先压进队列，RCTJPushModule 初始化时回放（同官方示例）
      RCTJPushEventQueue.sharedInstance()._notificationQueue?.insert(userInfo, at: 0)
      NotificationCenter.default.post(name: NSNotification.Name("J_APNS_NOTIFICATION_OPENED_EVENT"), object: userInfo)
    }
    if let forward = AppDelegate.jpushForwardDelegate,
       let method = forward.userNotificationCenter(_:didReceive:withCompletionHandler:) {
      method(center, response, completionHandler)
      return
    }
    completionHandler()
  }

  public func jpushNotificationCenter(_ center: UNUserNotificationCenter, openSettingsFor notification: UNNotification?) {
    if let forward = AppDelegate.jpushForwardDelegate,
       let method = forward.userNotificationCenter(_:openSettingsFor:) {
      method(center, notification)
    }
  }

  public func jpushNotificationAuthorization(_ status: JPAuthorizationStatus, withInfo info: [AnyHashable: Any]?) {
    // 只是让协议完整；权限结果 JS 侧不关心
  }
}
`;

function applyAppDelegate(contents) {
  if (!/class\s+AppDelegate\s*:\s*ExpoAppDelegate/.test(contents)) {
    throw new Error(`[${PLUGIN_NAME}] AppDelegate.swift 不是 Expo 模板（找不到 class AppDelegate: ExpoAppDelegate）`);
  }
  let next = contents;

  // ① import UserNotifications（放在最后一条 import 之后；SDK 56 起模板是 `internal import Expo`）
  next = mergeContents({
    src: next,
    newSrc: "import UserNotifications",
    tag: `${PLUGIN_NAME}-import`,
    anchor: /^(?:\w+\s+)?import\s+ReactAppDependencyProvider\s*$/m,
    offset: 1,
    comment: "//",
  }).contents;

  // ② 类体：插在 `var window: UIWindow?` 之后
  next = mergeContents({
    src: next,
    newSrc: SWIFT_CLASS_BODY,
    tag: `${PLUGIN_NAME}-class-body`,
    anchor: /^\s*var window: UIWindow\?\s*$/m,
    offset: 1,
    comment: "//",
  }).contents;

  // ③ 记住 expo-notifications 的 delegate：必须在 super.application(didFinishLaunching) **之后**——
  //    expo 的 AppDelegateSubscriber 是在 super 里跑起来并把 delegate 设上的，之前读到的是 nil。
  const rememberTag = `${PLUGIN_NAME}-remember-delegate`;
  if (!next.includes(`@generated begin ${rememberTag}`)) {
    const returnLine = /^(\s*)return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)\s*$/m;
    const m = returnLine.exec(next);
    if (!m) {
      throw new Error(`[${PLUGIN_NAME}] AppDelegate.swift 锚点失效：remember-delegate（Expo 模板变了，请更新插件）`);
    }
    const indent = m[1];
    const replacement = [
      `${indent}// @generated begin ${rememberTag} - expo prebuild (DO NOT MODIFY)`,
      `${indent}let jpushLaunched = super.application(application, didFinishLaunchingWithOptions: launchOptions)`,
      `${indent}AppDelegate.jpushForwardDelegate = UNUserNotificationCenter.current().delegate`,
      `${indent}return jpushLaunched`,
      `${indent}// @generated end ${rememberTag}`,
    ].join("\n");
    next = next.replace(returnLine, replacement);
  }

  // ④ 文件末尾的 extension（幂等：已有同 tag 就替换）
  const tagged = `// @generated begin ${PLUGIN_NAME}-extension`;
  if (next.includes(tagged)) {
    next = next.replace(
      new RegExp(`\\n?// @generated begin ${PLUGIN_NAME}-extension[\\s\\S]*?// @generated end ${PLUGIN_NAME}-extension\\n?`),
      "\n",
    );
  }
  next = `${next.trimEnd()}\n\n${tagged}\n${SWIFT_EXTENSION.trim()}\n// @generated end ${PLUGIN_NAME}-extension\n`;

  for (const tag of ["import", "class-body", "remember-delegate"]) {
    if (!next.includes(`@generated begin ${PLUGIN_NAME}-${tag}`)) {
      throw new Error(`[${PLUGIN_NAME}] AppDelegate.swift 锚点失效：${tag}（Expo 模板变了，请更新插件）`);
    }
  }
  return next;
}

function applyInfoPlist(infoPlist) {
  const modes = new Set(Array.isArray(infoPlist.UIBackgroundModes) ? infoPlist.UIBackgroundModes : []);
  modes.add("remote-notification");
  infoPlist.UIBackgroundModes = Array.from(modes);
  return infoPlist;
}

// ---------- 组装 ----------

const withJPush = (config) => {
  const jpush = readJPushExtra(config);

  config = withAppBuildGradle(config, (c) => {
    c.modResults.contents = applyAppBuildGradle(c.modResults.contents, jpush);
    return c;
  });
  config = withAndroidManifest(config, (c) => {
    c.modResults = applyAndroidManifest(c.modResults);
    return c;
  });

  config = withInfoPlist(config, (c) => {
    c.modResults = applyInfoPlist(c.modResults);
    return c;
  });
  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== "swift") {
      throw new Error(`[${PLUGIN_NAME}] 只支持 Swift AppDelegate（当前 ${c.modResults.language}）`);
    }
    c.modResults.contents = applyAppDelegate(c.modResults.contents);
    return c;
  });
  config = withDangerousMod(config, [
    "ios",
    (c) => {
      const name = c.modRequest.projectName;
      const header = path.join(c.modRequest.platformProjectRoot, name, `${name}-Bridging-Header.h`);
      const current = fs.existsSync(header) ? fs.readFileSync(header, "utf8") : "";
      fs.writeFileSync(header, applyBridgingHeader(current));
      return c;
    },
  ]);
  return config;
};

module.exports = createRunOncePlugin(withJPush, PLUGIN_NAME, "1.0.0");
module.exports.applyAppBuildGradle = applyAppBuildGradle;
module.exports.applyAndroidManifest = applyAndroidManifest;
module.exports.applyAppDelegate = applyAppDelegate;
module.exports.applyBridgingHeader = applyBridgingHeader;
module.exports.applyInfoPlist = applyInfoPlist;
module.exports.readJPushExtra = readJPushExtra;
