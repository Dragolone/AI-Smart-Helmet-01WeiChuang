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
// Android 厂商通道——华为（2026-10-08，上线清单 A-11）：App 被杀后只有厂商通道能把 SOS 推送送到。极光的
//   华为插件 + HMS Push SDK + AGC Gradle 插件，再把 AGC 的 agconnect-services.json（「不包含密钥」版，进 Git）
//   拷进 android/app/。项目根有这个文件才接，没有就跳过并提示——拿不到华为参数的开发机照样能 prebuild。
//   小米通道等账号审核通过后同样方式加（manifestPlaceholders XIAOMI_APPID / XIAOMI_APPKEY）。
//
// 纯函数 apply*() 独立导出给单测（plugins/__tests__/with-jpush.test.ts）——补丁靠锚点正则，Expo 模板一变就会断，
// 单测拿真实模板做夹具，断了会先在 CI 红而不是在真机上黑屏。
const {
  withProjectBuildGradle,
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

/** 极光厂商插件的版本必须与 jpush-react-native 自带的 JPush SDK 版本一致（单测对照 node_modules 里的 build.gradle） */
const JPUSH_HUAWEI_PLUGIN_VERSION = "6.2.0";
/** 极光官方集成指南给出的 HMS Push 版本（docs.jiguang.cn 厂商通道 SDK 集成指南） */
const HMS_PUSH_VERSION = "6.13.0.300";
/** 华为 AGC Gradle 插件（apply plugin: 'com.huawei.agconnect'），同一份指南 */
const AGCP_VERSION = "1.9.1.301";
const HUAWEI_MAVEN = "maven { url 'https://developer.huawei.com/repo/' }";
const AGC_SERVICES_FILE = "agconnect-services.json";

function huaweiEnabled(projectRoot) {
  return fs.existsSync(path.join(projectRoot, AGC_SERVICES_FILE));
}

/**
 * AGC Gradle 插件（agcp）在 apply 时会检查 buildscript classpath 里的 `com.android.tools.build:gradle`，碰到不带版本号的
 * 声明就报「com.android.tools.build:gradle is no set in the build.gradle file」——另加一行带版本的也没用，它取到的仍是
 * 模板那行（2026-10-08 本机打包实测）。Expo 模板写的是 `classpath('com.android.tools.build:gradle')`，版本由 React Native
 * 的 gradle 版本表给出；这里从同一份表读出来，把模板那一行**改写成带版本的**，解析到的 AGP 与原来完全相同。
 */
function readAgpVersion(projectRoot) {
  const catalog = path.join(
    path.dirname(require.resolve("react-native/package.json", { paths: [projectRoot] })),
    "gradle",
    "libs.versions.toml",
  );
  const m = /^agp\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(catalog, "utf8"));
  if (!m) {
    throw new Error(`[${PLUGIN_NAME}] 读不到 React Native 的 AGP 版本（${catalog} 里没有 agp = "…"）`);
  }
  return m[1];
}

/** 项目级 build.gradle：buildscript 与 allprojects 都加华为仓库；buildscript 加显式 AGP 版本 + agcp classpath */
function applyProjectBuildGradleHuawei(contents, { agpVersion }) {
  if (!agpVersion) throw new Error(`[${PLUGIN_NAME}] applyProjectBuildGradleHuawei 需要 agpVersion`);
  const tag = `${PLUGIN_NAME}-huawei-project`;
  if (contents.includes(`@generated begin ${tag}-repo`)) return contents; // 幂等
  const merge = (src, newSrc, suffix, anchor) => {
    try {
      return mergeContents({ src, newSrc, tag: `${tag}-${suffix}`, anchor, offset: 1, comment: "//" }).contents;
    } catch (e) {
      throw new Error(`[${PLUGIN_NAME}] android/build.gradle 锚点失效：${suffix}（Expo 模板变了，请更新插件；${e.message}）`);
    }
  };
  let next = contents;
  // 模板里不带版本的 AGP 声明改写成带版本的（agcp 的要求，见 readAgpVersion 注释）
  const versionless = /^(\s*)classpath\(['"]com\.android\.tools\.build:gradle['"]\)\s*$/m;
  if (versionless.test(next)) {
    next = next.replace(versionless, `$1classpath('com.android.tools.build:gradle:${agpVersion}')`);
  } else if (!/classpath\(['"]com\.android\.tools\.build:gradle:[^'"]+['"]\)/.test(next)) {
    throw new Error(`[${PLUGIN_NAME}] android/build.gradle 锚点失效：找不到 classpath('com.android.tools.build:gradle')（Expo 模板变了，请更新插件）`);
  }
  // buildscript.repositories：模板里第一个 mavenCentral() 在 buildscript 块
  next = merge(next, `    ${HUAWEI_MAVEN}`, "repo", /^\s*mavenCentral\(\)\s*$/m);
  next = merge(
    next,
    `    classpath('com.huawei.agconnect:agcp:${AGCP_VERSION}')`,
    "classpath",
    /^\s*classpath\('org\.jetbrains\.kotlin:kotlin-gradle-plugin'\)\s*$/m,
  );
  // allprojects.repositories：锚在模板里的 jitpack 那行
  next = merge(next, `    ${HUAWEI_MAVEN}`, "allprojects", /^\s*maven \{ url 'https:\/\/www\.jitpack\.io' \}\s*$/m);
  return next;
}

/** 应用级 build.gradle：apply AGC 插件 + 极光华为插件 + HMS Push 依赖 */
function applyAppBuildGradleHuawei(contents) {
  const tag = `${PLUGIN_NAME}-huawei-app`;
  if (contents.includes(`@generated begin ${tag}-plugin`)) return contents; // 幂等
  const merge = (src, newSrc, suffix, anchor) => {
    try {
      return mergeContents({ src, newSrc, tag: `${tag}-${suffix}`, anchor, offset: 1, comment: "//" }).contents;
    } catch (e) {
      throw new Error(`[${PLUGIN_NAME}] app/build.gradle 锚点失效：${suffix}（Expo 模板变了，请更新插件；${e.message}）`);
    }
  };
  let next = contents;
  next = merge(next, `apply plugin: "com.huawei.agconnect"`, "plugin", /^apply plugin: "com\.facebook\.react"\s*$/m);
  next = merge(
    next,
    [
      `    implementation("cn.jiguang.sdk.plugin:huawei:${JPUSH_HUAWEI_PLUGIN_VERSION}")`,
      `    implementation("com.huawei.hms:push:${HMS_PUSH_VERSION}")`,
    ].join("\n"),
    "deps",
    /^\s*implementation\("com\.facebook\.react:react-android"\)\s*$/m,
  );
  return next;
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

  /// 极光「自定义消息」（走长连接、不是 APNs）。RCTJPushModule 初始化时把 AppDelegate 注册成了
  /// kJPFNetworkDidReceiveMessageNotification 的观察者，selector 就是这个方法名（RCTJPushModule.m）。
  /// AppDelegate 上没有它的话，极光一旦下发自定义消息——控制台手滑点一下就够——所有在线的 iPhone
  /// 客户端直接崩在 unrecognized selector 上，BLE 中转随进程中断（2026-10-05 评审）。
  /// 后端目前只发通知不发自定义消息；这里照官方示例转给 JS 监听，没人监听就是空操作。
  @objc public func networkDidReceiveMessage(_ notification: Notification) {
    NotificationCenter.default.post(name: NSNotification.Name("J_CUSTOM_NOTIFICATION_EVENT"), object: notification.userInfo)
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
    if (huaweiEnabled(c.modRequest.projectRoot)) {
      c.modResults.contents = applyAppBuildGradleHuawei(c.modResults.contents);
    }
    return c;
  });
  config = withProjectBuildGradle(config, (c) => {
    if (huaweiEnabled(c.modRequest.projectRoot)) {
      c.modResults.contents = applyProjectBuildGradleHuawei(c.modResults.contents, {
        agpVersion: readAgpVersion(c.modRequest.projectRoot),
      });
    } else {
      console.warn(`[${PLUGIN_NAME}] 项目根没有 ${AGC_SERVICES_FILE}，跳过华为推送通道（被杀状态下华为手机收不到 SOS 推送）`);
    }
    return c;
  });
  config = withDangerousMod(config, [
    "android",
    (c) => {
      const src = path.join(c.modRequest.projectRoot, AGC_SERVICES_FILE);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(c.modRequest.platformProjectRoot, "app", AGC_SERVICES_FILE));
      }
      return c;
    },
  ]);
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
module.exports.applyAppBuildGradleHuawei = applyAppBuildGradleHuawei;
module.exports.applyProjectBuildGradleHuawei = applyProjectBuildGradleHuawei;
module.exports.readAgpVersion = readAgpVersion;
module.exports.JPUSH_HUAWEI_PLUGIN_VERSION = JPUSH_HUAWEI_PLUGIN_VERSION;
module.exports.applyAndroidManifest = applyAndroidManifest;
module.exports.applyAppDelegate = applyAppDelegate;
module.exports.applyBridgingHeader = applyBridgingHeader;
module.exports.applyInfoPlist = applyInfoPlist;
module.exports.readJPushExtra = readJPushExtra;
