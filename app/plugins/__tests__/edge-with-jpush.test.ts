// 极光 config plugin 的组装层（withJPush 本身）和几条锚点失效的报错路径。
// 组装层：插件挂上之后 config.mods 里登记了哪些 mod，拿假的 modRequest 直接跑一遍，看生成的东西——
// 华为参数文件在不在、小米配没配，各走各的分支；文件只写进临时目录。
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Mod = (c: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Config = {
  name: string;
  slug: string;
  extra?: Record<string, unknown>;
  mods?: Record<string, Record<string, Mod>>;
  _internal?: Record<string, unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../with-jpush.js") as ((c: Config) => Config) & {
  applyProjectBuildGradlePins: (s: string) => string;
  applyProjectBuildGradleHuawei: (
    s: string,
    o: { agpVersion?: string },
  ) => string;
  applyAppDelegate: (s: string) => string;
  applyInfoPlist: (p: Record<string, unknown>) => Record<string, unknown>;
  readAgpVersion: (root: string) => string;
  readJPushExtra: (c: unknown) => {
    appKey: string;
    channel: string;
    xiaomi?: unknown;
  };
};

const APP_ROOT = path.join(__dirname, "..", "..");
const APP_GRADLE = `apply plugin: "com.android.application"
apply plugin: "com.facebook.react"

android {
    defaultConfig {
        applicationId 'com.lingyiweichuang.app'
    }
}

dependencies {
    implementation("com.facebook.react:react-android")
}
`;
const PROJECT_GRADLE = `buildscript {
  repositories {
    google()
    mavenCentral()
  }
  dependencies {
    classpath('com.android.tools.build:gradle')
    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
  }
}

allprojects {
  repositories {
    maven { url 'https://www.jitpack.io' }
  }
}
`;
const APP_DELEGATE = `internal import Expo
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "with-jpush-"));
  tmpDirs.push(d);
  return d;
};
let warn: ReturnType<typeof jest.spyOn>;
beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const configOf = (jpush: Record<string, unknown> | undefined): Config => ({
  name: "app",
  slug: "app",
  extra: jpush ? { jpush } : {},
});
/** 跑登记在 platform.mod 上的那个 mod（链上的下一个是空操作） */
const run = (
  cfg: Config,
  platform: string,
  mod: string,
  c: Record<string, unknown>,
) => {
  const fn = cfg.mods?.[platform]?.[mod];
  if (!fn) throw new Error(`没有登记 ${platform}.${mod}`);
  return fn(c);
};

describe("withJPush 组装", () => {
  it("没配 appKey：挂插件时就报错", () => {
    expect(() => plugin(configOf(undefined))).toThrow(/extra\.jpush\.appKey/);
  });

  it("登记了 Android 四个 mod、iOS 三个 mod；同一份 config 再挂一次不重复（runOnce）", () => {
    const cfg = plugin(configOf({ appKey: "k" }));
    expect(Object.keys(cfg.mods!.android).sort()).toEqual(
      ["appBuildGradle", "dangerous", "manifest", "projectBuildGradle"].sort(),
    );
    expect(Object.keys(cfg.mods!.ios).sort()).toEqual(
      ["appDelegate", "dangerous", "infoPlist"].sort(),
    );
    const again = plugin(cfg);
    expect(again.mods!.android.appBuildGradle).toBe(
      cfg.mods!.android.appBuildGradle,
    );
  });

  it("app/build.gradle：项目根有华为参数文件、配了小米 → 占位符 + 华为 + 小米三样都补", async () => {
    const cfg = plugin(
      configOf({
        appKey: "k1",
        xiaomi: { appId: "2882303761520592446", appKey: "5922059287446" },
      }),
    );
    const out = await run(cfg, "android", "appBuildGradle", {
      modRequest: { projectRoot: APP_ROOT },
      modResults: { contents: APP_GRADLE, language: "groovy" },
    });
    const g = (out.modResults as { contents: string }).contents;
    expect(g).toContain('JPUSH_APPKEY: "k1"');
    expect(g).toContain('JPUSH_CHANNEL: "official"');
    expect(g).toContain('XIAOMI_APPID: "2882303761520592446"');
    expect(g).toContain('apply plugin: "com.huawei.agconnect"');
    expect(g).toContain("cn.jiguang.sdk.plugin:xiaomi:");
    expect(warn).not.toHaveBeenCalled();
  });

  it("app/build.gradle：没有华为文件、没配小米 → 只补占位符，并提示小米通道没接", async () => {
    const cfg = plugin(configOf({ appKey: "k2", channel: "beta" }));
    const out = await run(cfg, "android", "appBuildGradle", {
      modRequest: { projectRoot: tmp() },
      modResults: { contents: APP_GRADLE, language: "groovy" },
    });
    const g = (out.modResults as { contents: string }).contents;
    expect(g).toContain('JPUSH_CHANNEL: "beta"');
    expect(g).not.toContain("huawei");
    expect(g).not.toContain("xiaomi");
    expect(String(warn.mock.calls[0][0])).toContain("xiaomi");
  });

  it("项目级 build.gradle：有华为文件时按 React Native 的 AGP 版本改写；没有就跳过并提示", async () => {
    const cfg = plugin(configOf({ appKey: "k" }));
    const withHw = await run(cfg, "android", "projectBuildGradle", {
      modRequest: { projectRoot: APP_ROOT },
      modResults: { contents: PROJECT_GRADLE, language: "groovy" },
    });
    const agp = plugin.readAgpVersion(APP_ROOT);
    expect((withHw.modResults as { contents: string }).contents).toContain(
      `classpath('com.android.tools.build:gradle:${agp}')`,
    );
    const without = await run(cfg, "android", "projectBuildGradle", {
      modRequest: { projectRoot: tmp() },
      modResults: { contents: PROJECT_GRADLE, language: "groovy" },
    });
    // 没有华为文件：只有钉版本那一段，华为的补丁一样都不加
    expect((without.modResults as { contents: string }).contents).toBe(
      plugin.applyProjectBuildGradlePins(PROJECT_GRADLE),
    );
    expect(String(warn.mock.calls[0][0])).toContain("agconnect-services.json");
  });

  it("Android 危险 mod：有华为文件就拷进 android/app/，没有就什么都不做", async () => {
    const cfg = plugin(configOf({ appKey: "k" }));
    const root = tmp();
    fs.writeFileSync(
      path.join(root, "agconnect-services.json"),
      '{"client":{}}',
    );
    const platform = path.join(root, "android");
    fs.mkdirSync(path.join(platform, "app"), { recursive: true });
    await run(cfg, "android", "dangerous", {
      modRequest: {
        projectRoot: root,
        platformProjectRoot: platform,
        platform: "android",
      },
      modResults: {},
    });
    expect(
      fs.readFileSync(
        path.join(platform, "app", "agconnect-services.json"),
        "utf8",
      ),
    ).toBe('{"client":{}}');
    const bare = tmp();
    fs.mkdirSync(path.join(bare, "android", "app"), { recursive: true });
    await run(cfg, "android", "dangerous", {
      modRequest: {
        projectRoot: bare,
        platformProjectRoot: path.join(bare, "android"),
        platform: "android",
      },
      modResults: {},
    });
    expect(
      fs.existsSync(
        path.join(bare, "android", "app", "agconnect-services.json"),
      ),
    ).toBe(false);
  });

  it("manifest / Info.plist mod", async () => {
    const cfg = plugin(configOf({ appKey: "k" }));
    const manifest = await run(cfg, "android", "manifest", {
      modRequest: {},
      modResults: {
        manifest: {
          application: [{ $: { "android:name": ".MainApplication" } }],
        },
      },
    });
    const app = (
      manifest.modResults as {
        manifest: {
          application: { "meta-data": { $: Record<string, string> }[] }[];
        };
      }
    ).manifest.application[0];
    expect(app["meta-data"].map((m) => m.$["android:name"])).toEqual([
      "JPUSH_APPKEY",
      "JPUSH_CHANNEL",
    ]);
    const plist = await run(cfg, "ios", "infoPlist", {
      modRequest: {},
      modResults: {},
    });
    expect(
      (plist.modResults as { UIBackgroundModes: string[] }).UIBackgroundModes,
    ).toEqual(["remote-notification"]);
  });

  it("AppDelegate mod：Swift 补上；Objective-C 直接报错", async () => {
    const cfg = plugin(configOf({ appKey: "k" }));
    const out = await run(cfg, "ios", "appDelegate", {
      modRequest: {},
      modResults: { contents: APP_DELEGATE, language: "swift" },
    });
    expect((out.modResults as { contents: string }).contents).toContain(
      "JPUSHService.registerDeviceToken",
    );
    await expect(
      run(cfg, "ios", "appDelegate", {
        modRequest: {},
        modResults: { contents: "", language: "objcpp" },
      }),
    ).rejects.toThrow(/Swift/);
  });

  it("iOS 危险 mod：bridging header 不存在就新建、存在就补在模板注释后", async () => {
    const cfg = plugin(configOf({ appKey: "k" }));
    const root = tmp();
    const platform = path.join(root, "ios");
    fs.mkdirSync(path.join(platform, "app"), { recursive: true });
    const header = path.join(platform, "app", "app-Bridging-Header.h");
    const req = {
      projectRoot: root,
      platformProjectRoot: platform,
      projectName: "app",
      platform: "ios",
    };
    await run(cfg, "ios", "dangerous", { modRequest: req, modResults: {} });
    expect(fs.readFileSync(header, "utf8")).toContain(
      "#import <JPUSHService.h>",
    );
    fs.writeFileSync(
      header,
      "//\n// Use this file to import your target's public headers\n",
    );
    await run(cfg, "ios", "dangerous", { modRequest: req, modResults: {} });
    const text = fs.readFileSync(header, "utf8");
    expect(text).toContain("#import <RCTJPushEventQueue.h>");
    expect(text).toContain("Use this file to import");
  });
});

describe("锚点失效 / 参数缺失的报错", () => {
  it("项目级华为补丁：没给 AGP 版本直接报错", () => {
    expect(() =>
      plugin.applyProjectBuildGradleHuawei(PROJECT_GRADLE, {}),
    ).toThrow(/agpVersion/);
  });

  it("项目级华为补丁：模板里已经带版本的 AGP 不再改写；一行 AGP 都没有就报错", () => {
    const versioned = PROJECT_GRADLE.replace(
      "classpath('com.android.tools.build:gradle')",
      "classpath('com.android.tools.build:gradle:8.9.0')",
    );
    const out = plugin.applyProjectBuildGradleHuawei(versioned, {
      agpVersion: "8.12.0",
    });
    expect(out).toContain("gradle:8.9.0");
    expect(out).not.toContain("gradle:8.12.0");
    const none = PROJECT_GRADLE.replace(
      "    classpath('com.android.tools.build:gradle')\n",
      "",
    );
    expect(() =>
      plugin.applyProjectBuildGradleHuawei(none, { agpVersion: "8.12.0" }),
    ).toThrow(/com\.android\.tools\.build:gradle/);
  });

  it("项目级华为补丁：kotlin classpath / jitpack 锚点没了，报出是哪一个", () => {
    const noKotlin = PROJECT_GRADLE.replace(
      "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')",
      "",
    );
    expect(() =>
      plugin.applyProjectBuildGradleHuawei(noKotlin, { agpVersion: "1" }),
    ).toThrow(/classpath/);
    const noJitpack = PROJECT_GRADLE.replace(
      "maven { url 'https://www.jitpack.io' }",
      "",
    );
    expect(() =>
      plugin.applyProjectBuildGradleHuawei(noJitpack, { agpVersion: "1" }),
    ).toThrow(/allprojects/);
  });

  it("AppDelegate：找不到 return super.application(…didFinishLaunching…) 就报错，不静默漏补", () => {
    const broken = APP_DELEGATE.replace(
      "return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
      "return true",
    );
    expect(() => plugin.applyAppDelegate(broken)).toThrow(/remember-delegate/);
  });

  it("读 AGP 版本：React Native 的版本表里没有 agp 就报错", () => {
    const root = tmp();
    const rn = path.join(root, "node_modules", "react-native");
    fs.mkdirSync(path.join(rn, "gradle"), { recursive: true });
    fs.writeFileSync(
      path.join(rn, "package.json"),
      '{"name":"react-native","version":"0.0.0"}',
    );
    fs.writeFileSync(
      path.join(rn, "gradle", "libs.versions.toml"),
      '[versions]\nkotlin = "2.1.0"\n',
    );
    expect(() => plugin.readAgpVersion(root)).toThrow(/AGP/);
    fs.writeFileSync(
      path.join(rn, "gradle", "libs.versions.toml"),
      '[versions]\nagp = "8.7.1"\n',
    );
    expect(plugin.readAgpVersion(root)).toBe("8.7.1");
  });

  it("Info.plist 原来的后台模式不是数组（被手改坏）也能补上", () => {
    expect(
      plugin.applyInfoPlist({ UIBackgroundModes: "audio" }).UIBackgroundModes,
    ).toEqual(["remote-notification"]);
  });

  it("app.json 没写渠道按 official", () => {
    expect(
      plugin.readJPushExtra({ extra: { jpush: { appKey: 123 } } }),
    ).toEqual({
      appKey: "123",
      channel: "official",
      xiaomi: undefined,
    });
  });
});
