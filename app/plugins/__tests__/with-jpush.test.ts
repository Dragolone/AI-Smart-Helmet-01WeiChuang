// 极光 config plugin 的补丁全靠锚点正则，Expo 模板一改就会在 prebuild 时炸或（更糟）静默漏补。
// 夹具 = Expo SDK 57 生成的真实 AppDelegate.swift / build.gradle 片段；模板升级后这里先红。
import { describe, expect, it } from "@jest/globals";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../with-jpush.js") as {
  applyProjectBuildGradleHuawei: (s: string, o: { agpVersion: string }) => string;
  applyProjectBuildGradlePins: (s: string) => string;
  PINNED_ANDROID_SDKS: string[];
  readAgpVersion: (root: string) => string;
  applyAppBuildGradleHuawei: (s: string) => string;
  applyAppBuildGradleXiaomi: (s: string) => string;
  JPUSH_VENDOR_PLUGIN_VERSION: string;
  applyAppDelegate: (s: string) => string;
  applyAppBuildGradle: (
    s: string,
    cfg: { appKey: string; channel: string; xiaomi?: { appId: string; appKey: string } },
  ) => string;
  applyAndroidManifest: (m: unknown) => unknown;
  applyBridgingHeader: (s: string) => string;
  applyInfoPlist: (p: Record<string, unknown>) => Record<string, unknown>;
  readJPushExtra: (c: unknown) => {
    appKey: string;
    channel: string;
    xiaomi?: { appId: string; appKey: string };
  };
};

const APP_DELEGATE_SDK57 = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func bundleURL() -> URL? {
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
  }
}
`;

const BUILD_GRADLE_SDK57 = `android {
    ndkVersion rootProject.ext.ndkVersion
    namespace 'com.lingyiweichuang.app'
    defaultConfig {
        applicationId 'com.lingyiweichuang.app'
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0.0"
    }
}
`;

describe("iOS AppDelegate.swift 补丁", () => {
  const once = plugin.applyAppDelegate(APP_DELEGATE_SDK57);

  it("四块都补上了", () => {
    expect(once).toContain("import UserNotifications");
    expect(once).toContain("JPUSHService.registerDeviceToken(deviceToken)");
    expect(once).toContain("extension AppDelegate: JPUSHRegisterDelegate");
    // 记 delegate 必须在 super 之后（expo-notifications 在 super 里才把 delegate 设上）
    const superIdx = once.indexOf("let jpushLaunched = super.application(application, didFinishLaunchingWithOptions: launchOptions)");
    const rememberIdx = once.indexOf("AppDelegate.jpushForwardDelegate = UNUserNotificationCenter.current().delegate");
    expect(superIdx).toBeGreaterThan(0);
    expect(rememberIdx).toBeGreaterThan(superIdx);
    // 原来的裸 return 不能还留着，否则 Swift 报 unreachable / 重复 return
    expect(once).not.toMatch(/^\s*return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)\s*$/m);
  });

  it("被杀状态下点击会先压进 RCTJPushEventQueue（JS 起来后回放）", () => {
    expect(once).toContain("RCTJPushEventQueue.sharedInstance()._notificationQueue?.insert(userInfo, at: 0)");
    expect(once).toContain('NSNotification.Name("J_APNS_NOTIFICATION_OPENED_EVENT")');
  });

  it("回调转发回 expo-notifications（SOS 锁屏本地通知的按钮不能废）", () => {
    expect(once).toContain("forward.userNotificationCenter(_:didReceive:withCompletionHandler:)");
    expect(once).toContain("forward.userNotificationCenter(_:willPresent:withCompletionHandler:)");
  });

  it("AppDelegate 实现了 networkDidReceiveMessage:（极光把它注册成自定义消息的观察者，没有这个方法收到自定义消息就崩）", () => {
    // RCTJPushModule.m：addObserver:[[UIApplication sharedApplication] delegate] selector:@selector(networkDidReceiveMessage:)
    expect(once).toMatch(/@objc public func networkDidReceiveMessage\(_ notification: Notification\)/);
    expect(once).toContain('NSNotification.Name("J_CUSTOM_NOTIFICATION_EVENT")');
    // 必须在 AppDelegate 类体里（观察者是 delegate 实例本身）
    const classStart = once.indexOf("class AppDelegate");
    const ext = once.indexOf("extension AppDelegate: JPUSHRegisterDelegate");
    const at = once.indexOf("func networkDidReceiveMessage");
    expect(at).toBeGreaterThan(classStart);
    expect(at).toBeLessThan(ext);
  });

  it("库里确实还是把 AppDelegate 注册成这个 selector 的观察者（库升级后若改了名，这条会提醒同步）", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const lib = fs.readFileSync(
      path.join(__dirname, "../../../node_modules/jpush-react-native/ios/RCTJPushModule/RCTJPushModule.m"),
      "utf8",
    );
    expect(lib).toMatch(/addObserver:\[\[UIApplication sharedApplication\] delegate\]\s*selector:@selector\(networkDidReceiveMessage:\)/);
    const header = fs.readFileSync(
      path.join(__dirname, "../../../node_modules/jpush-react-native/ios/RCTJPushModule/RCTJPushModule.h"),
      "utf8",
    );
    expect(header).toContain('#define J_CUSTOM_NOTIFICATION_EVENT        @"J_CUSTOM_NOTIFICATION_EVENT"');
  });

  it("不在 AppDelegate 里初始化极光（必须等用户同意隐私政策后由 JS 触发）", () => {
    expect(once).not.toContain("JPUSHService.setup");
    expect(once).not.toContain("registerForRemoteNotificationConfig");
  });

  it("幂等：再补一次结果不变", () => {
    expect(plugin.applyAppDelegate(once)).toBe(once);
  });

  it("不是 Expo 模板就报错，不静默漏补", () => {
    expect(() => plugin.applyAppDelegate("class AppDelegate: UIResponder {}")).toThrow(/Expo 模板/);
    const noReturn = APP_DELEGATE_SDK57.replace(
      "return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
      "return true",
    );
    expect(() => plugin.applyAppDelegate(noReturn)).toThrow(/remember-delegate/);
  });
});

describe("Android build.gradle 占位符", () => {
  const cfg = { appKey: "79cce150234ce38063213ccd", channel: "official" };
  const once = plugin.applyAppBuildGradle(BUILD_GRADLE_SDK57, cfg);

  it("三个占位符都在，且包名跟着 applicationId 走", () => {
    expect(once).toContain("JPUSH_PKGNAME: applicationId");
    expect(once).toContain('JPUSH_APPKEY: "79cce150234ce38063213ccd"');
    expect(once).toContain('JPUSH_CHANNEL: "official"');
    // 插在 defaultConfig 里、applicationId 之后
    expect(once.indexOf("manifestPlaceholders")).toBeGreaterThan(once.indexOf("applicationId 'com.lingyiweichuang.app'"));
  });

  it("幂等", () => {
    expect(plugin.applyAppBuildGradle(once, cfg)).toBe(once);
  });

  it("找不到 applicationId 就报错", () => {
    expect(() => plugin.applyAppBuildGradle("android {}", cfg)).toThrow(/applicationId/);
  });
});

describe("Android manifest / iOS plist / bridging header", () => {
  it("manifest 加两条 meta-data，重复应用不重复加", () => {
    const manifest = {
      manifest: {
        application: [{ $: { "android:name": ".MainApplication" }, "meta-data": [] as unknown[] }],
      },
    };
    plugin.applyAndroidManifest(manifest);
    plugin.applyAndroidManifest(manifest);
    const names = manifest.manifest.application[0]["meta-data"].map(
      (m) => (m as { $: Record<string, string> }).$["android:name"],
    );
    expect(names).toEqual(["JPUSH_APPKEY", "JPUSH_CHANNEL"]);
  });

  it("Info.plist 补 remote-notification 后台模式，保留原有 audio", () => {
    const out = plugin.applyInfoPlist({ UIBackgroundModes: ["audio"] });
    expect(out.UIBackgroundModes).toEqual(["audio", "remote-notification"]);
    expect(plugin.applyInfoPlist(out).UIBackgroundModes).toEqual(["audio", "remote-notification"]);
  });

  it("bridging header 为空文件时也能补（mergeContents 锚不到会抛，不能当兜底）", () => {
    const out = plugin.applyBridgingHeader("");
    expect(out).toContain("#import <JPUSHService.h>");
    expect(plugin.applyBridgingHeader(out)).toBe(out);
  });

  it("bridging header 两行 import 幂等", () => {
    const template = "//\n// Use this file to import your target's public headers that you would like to expose to Swift.\n//\n";
    const once = plugin.applyBridgingHeader(template);
    expect(once).toContain("#import <JPUSHService.h>");
    expect(once).toContain("#import <RCTJPushEventQueue.h>");
    expect(plugin.applyBridgingHeader(once)).toBe(once);
  });

  it("app.json 缺 appKey 直接报错", () => {
    expect(() => plugin.readJPushExtra({ extra: {} })).toThrow(/appKey/);
    expect(plugin.readJPushExtra({ extra: { jpush: { appKey: "k" } } })).toEqual({ appKey: "k", channel: "official" });
  });
});

// Expo SDK 57 prebuild 产物 android/build.gradle（2026-10-08 实际生成）
const PROJECT_BUILD_GRADLE_SDK57 = `// Top-level build file where you can add configuration options common to all sub-projects/modules.

buildscript {
  repositories {
    google()
    mavenCentral()
  }
  dependencies {
    classpath('com.android.tools.build:gradle')
    classpath('com.facebook.react:react-native-gradle-plugin')
    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
  }
}

allprojects {
  repositories {
    google()
    mavenCentral()
    maven { url 'https://www.jitpack.io' }
  }
}

apply plugin: "expo-root-project"
apply plugin: "com.facebook.react.rootproject"
`;

describe("钉住动态版本的安卓 SDK", () => {
  const pinned = plugin.applyProjectBuildGradlePins(PROJECT_BUILD_GRADLE_SDK57);
  const readLibGradle = (lib: string) => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    return fs.readFileSync(path.join(__dirname, `../../../node_modules/${lib}/android/build.gradle`), "utf8");
  };

  it("force 写在 allprojects 块里，不进 buildscript，也不进 repositories", () => {
    const allprojects = pinned.slice(pinned.indexOf("allprojects"));
    expect(pinned.slice(0, pinned.indexOf("allprojects"))).not.toContain("resolutionStrategy");
    const force = allprojects.indexOf("configurations.configureEach { resolutionStrategy.force ");
    expect(force).toBeGreaterThan(0);
    expect(force).toBeLessThan(allprojects.indexOf("repositories"));
    expect(allprojects).toContain("'cn.jiguang.sdk:jcore:5.5.0'");
    expect(allprojects).toContain("'com.tencent.liteav:LiteAVSDK_Professional:13.4.0.20477'");
  });

  it("钉的都是完整版本号，不是动态写法", () => {
    for (const dep of plugin.PINNED_ANDROID_SDKS) {
      expect(dep).toMatch(/^[\w.]+:[\w.]+:\d+(\.\d+)+$/);
    }
  });

  it("重复 prebuild 不叠加；和华为通道的补丁互不影响", () => {
    expect(plugin.applyProjectBuildGradlePins(pinned)).toBe(pinned);
    const both = plugin.applyProjectBuildGradleHuawei(pinned, { agpVersion: "8.12.0" });
    expect(both).toContain("resolutionStrategy.force");
    expect(both).toContain("classpath('com.huawei.agconnect:agcp:1.9.1.301')");
    expect(plugin.applyProjectBuildGradlePins(both)).toBe(both);
  });

  it("模板变了（锚点找不到）就报错，不静默漏钉", () => {
    expect(() => plugin.applyProjectBuildGradlePins("buildscript {}")).toThrow(/android\/build\.gradle 锚点失效/);
  });

  it("钉的版本和库自己声明的对得上（库升级后这条会提醒同步）", () => {
    expect(readLibGradle("jcore-react-native")).toContain(plugin.PINNED_ANDROID_SDKS[0]);
    const liteav = /LiteAVSDK_Professional:(\d+\.\d+)\.\+/.exec(readLibGradle("trtc-react-native"));
    expect(plugin.PINNED_ANDROID_SDKS[1]).toContain(`LiteAVSDK_Professional:${liteav?.[1]}.`);
  });
});

// 同一份产物 android/app/build.gradle 的头部与 dependencies 块（中间省略）
const APP_BUILD_GRADLE_HEAD_SDK57 = `apply plugin: "com.android.application"
apply plugin: "org.jetbrains.kotlin.android"
apply plugin: "com.facebook.react"

def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()

dependencies {
    // The version of react-native is set by the React Native Gradle Plugin
    implementation("com.facebook.react:react-android")

    def isGifEnabled = (findProperty('expo.gif.enabled') ?: "") == "true";
}
`;

describe("Android 华为厂商通道（上线清单 A-11）", () => {
  const project = plugin.applyProjectBuildGradleHuawei(PROJECT_BUILD_GRADLE_SDK57, { agpVersion: "8.12.0" });
  const app = plugin.applyAppBuildGradleHuawei(APP_BUILD_GRADLE_HEAD_SDK57);

  it("项目级：buildscript 与 allprojects 都加华为仓库，buildscript 加 agcp classpath", () => {
    const buildscript = project.slice(0, project.indexOf("allprojects"));
    const allprojects = project.slice(project.indexOf("allprojects"));
    expect(buildscript).toContain("maven { url 'https://developer.huawei.com/repo/' }");
    expect(buildscript).toContain("classpath('com.huawei.agconnect:agcp:1.9.1.301')");
    // agcp 碰到不带版本的 AGP 声明就报错：模板那行要改写成带版本的，且不能再留一行不带版本的
    expect(buildscript).toContain("classpath('com.android.tools.build:gradle:8.12.0')");
    expect(buildscript).not.toMatch(/classpath\(['"]com\.android\.tools\.build:gradle['"]\)/);
    expect(allprojects).toContain("maven { url 'https://developer.huawei.com/repo/' }");
    // 仓库要在 repositories 块里、classpath 要在 dependencies 块里
    expect(buildscript.indexOf("developer.huawei.com")).toBeLessThan(buildscript.indexOf("dependencies {"));
    expect(buildscript.indexOf("agcp")).toBeGreaterThan(buildscript.indexOf("dependencies {"));
  });

  it("应用级：AGC 插件紧跟 com.facebook.react 之后；极光华为插件与 HMS Push 进 dependencies", () => {
    expect(app).toMatch(/apply plugin: "com\.facebook\.react"\n(?:\/\/.*\n)?apply plugin: "com\.huawei\.agconnect"/);
    const deps = app.slice(app.indexOf("dependencies {"));
    expect(deps).toContain(`implementation("cn.jiguang.sdk.plugin:huawei:${plugin.JPUSH_VENDOR_PLUGIN_VERSION}")`);
    expect(deps).toContain('implementation("com.huawei.hms:push:6.13.0.300")');
  });

  it("AGP 版本从 React Native 的 gradle 版本表读（与模板里不带版本的那行指向同一版本）", () => {
    const path = require("node:path") as typeof import("node:path");
    expect(plugin.readAgpVersion(path.join(__dirname, "../.."))).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("幂等：再补一次结果不变", () => {
    expect(plugin.applyProjectBuildGradleHuawei(project, { agpVersion: "8.12.0" })).toBe(project);
    expect(plugin.applyAppBuildGradleHuawei(app)).toBe(app);
  });

  it("模板变了（锚点找不到）就报错，不静默漏接", () => {
    expect(() => plugin.applyProjectBuildGradleHuawei("buildscript {}", { agpVersion: "8.12.0" })).toThrow(/android\/build\.gradle 锚点失效/);
    expect(() => plugin.applyAppBuildGradleHuawei("android {}")).toThrow(/app\/build\.gradle 锚点失效/);
  });

  it("极光厂商插件的版本与 jpush-react-native 自带的 JPush SDK 版本一致（库升级后这条会提醒同步）", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const gradle = fs.readFileSync(
      path.join(__dirname, "../../../node_modules/jpush-react-native/android/build.gradle"),
      "utf8",
    );
    expect(gradle).toContain(`cn.jiguang.sdk:jpush:${plugin.JPUSH_VENDOR_PLUGIN_VERSION}`);
  });
});

describe("Android 小米厂商通道", () => {
  const xiaomi = { appId: "2882303761520592446", appKey: "5922059287446" };

  it("配了小米：manifestPlaceholders 多两项，原样是字符串（19 位 AppID 不能丢精度）", () => {
    const out = plugin.applyAppBuildGradle(BUILD_GRADLE_SDK57, { appKey: "k", channel: "official", xiaomi });
    expect(out).toContain('XIAOMI_APPID: "2882303761520592446"');
    expect(out).toContain('XIAOMI_APPKEY: "5922059287446"');
    // 插件 5.5.3 起不加「MI-」前缀
    expect(out).not.toContain("MI-");
    // 仍是一个合法的 Groovy map：最后一项后面没有逗号
    expect(out).toMatch(/XIAOMI_APPKEY: "5922059287446"\n\s*\]/);
  });

  it("没配小米：占位符与原来完全一样（不多出空项）", () => {
    const out = plugin.applyAppBuildGradle(BUILD_GRADLE_SDK57, { appKey: "k", channel: "official" });
    expect(out).not.toContain("XIAOMI");
    expect(out).toMatch(/JPUSH_CHANNEL: "official"\n\s*\]/);
  });

  it("应用级 dependencies 加极光小米插件，版本跟 JPush SDK；和华为一起接也不打架", () => {
    const app = plugin.applyAppBuildGradleXiaomi(APP_BUILD_GRADLE_HEAD_SDK57);
    const deps = app.slice(app.indexOf("dependencies {"));
    expect(deps).toContain(`implementation("cn.jiguang.sdk.plugin:xiaomi:${plugin.JPUSH_VENDOR_PLUGIN_VERSION}")`);
    expect(plugin.applyAppBuildGradleXiaomi(app)).toBe(app);
    const both = plugin.applyAppBuildGradleXiaomi(plugin.applyAppBuildGradleHuawei(APP_BUILD_GRADLE_HEAD_SDK57));
    expect(both).toContain("cn.jiguang.sdk.plugin:huawei:");
    expect(both).toContain("cn.jiguang.sdk.plugin:xiaomi:");
    expect(plugin.applyAppBuildGradleXiaomi(both)).toBe(both);
  });

  it("模板变了（锚点找不到）就报错，不静默漏接", () => {
    expect(() => plugin.applyAppBuildGradleXiaomi("android {}")).toThrow(/xiaomi-deps/);
  });

  it("app.json：只收纯数字字符串；写成数字（会丢精度）或缺一项直接报错", () => {
    expect(plugin.readJPushExtra({ extra: { jpush: { appKey: "k", xiaomi } } }).xiaomi).toEqual(xiaomi);
    expect(() =>
      plugin.readJPushExtra({ extra: { jpush: { appKey: "k", xiaomi: { appId: Number("2882303761520592446"), appKey: "5922059287446" } } } }),
    ).toThrow(/xiaomi\.appId/);
    expect(() => plugin.readJPushExtra({ extra: { jpush: { appKey: "k", xiaomi: { appId: "2882303761520592446" } } } })).toThrow(
      /xiaomi\.appKey/,
    );
    expect(() =>
      plugin.readJPushExtra({ extra: { jpush: { appKey: "k", xiaomi: { appId: "MI-2882303761520592446", appKey: "5922059287446" } } } }),
    ).toThrow(/xiaomi\.appId/);
  });

  it("仓库里的 app.json 配的就是小米开发者站上的值", () => {
    const appJson = require("../../app.json") as { expo: unknown };
    expect(plugin.readJPushExtra(appJson.expo).xiaomi).toEqual(xiaomi);
  });
});
