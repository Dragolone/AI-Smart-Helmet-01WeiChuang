// 关掉安卓的系统备份与换机迁移（2026-10-22，回归 8.53）。
//
// 原来 allowBackup=true，expo-secure-store 的规则只排除了它自己那份（登录凭证），其余 SharedPreferences 全进备份 /
// 换机迁移——其中极光 SDK 的 app_prefs.xml 存着这台设备在极光的 uid / password / regId。恢复到新手机后，新手机直接
// 用旧手机的身份登上极光（两台模拟器实测：同一 uid、同一 regId；不带恢复文件则是新的）。服务端按 alias（用户 ID）
// 推送，alias 绑在 regId 上，于是：旧手机退出登录（deleteAlias）新手机跟着收不到求救推送；旧手机换别的账号登录
// （setAlias）新手机收到别人的推送；两台同时在线时极光一个 regId 只保留一条连接，推送落到哪台不确定。
//
// 备份里没有值得恢复的东西（登录凭证本来就排除了，App 自己的数据在数据库和文件里、规则也没带），所以整个关掉：
// - android:allowBackup="false"：安卓 11 及以下的云备份 / adb 备份，以及看这个开关的厂商换机工具；
// - android:dataExtractionRules：安卓 12 起 allowBackup=false **挡不住换机迁移**（device-transfer），要在规则里逐个域排除；
// - 去掉 expo-secure-store 加的 fullBackupContent（allowBackup=false 时用不上，留着容易让人以为还在备份）。
// app.json 里 expo-secure-store 配 configureAndroidBackup: false，否则它看到别的规则会告警。
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  createRunOncePlugin,
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PLUGIN_NAME = "with-no-backup";
const RULES_NAME = "no_backup_rules";
const DOMAINS = [
  "root",
  "file",
  "database",
  "sharedpref",
  "external",
  "device_root",
  "device_file",
  "device_database",
  "device_sharedpref",
];

const exclusions = DOMAINS.map(
  (d) => `    <exclude domain="${d}" path="." />`,
).join("\n");
const NO_BACKUP_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- with-no-backup 生成：云备份和换机迁移都不带任何数据（极光设备身份不能跟着去新手机） -->
<data-extraction-rules>
  <cloud-backup>
${exclusions}
  </cloud-backup>
  <device-transfer>
${exclusions}
  </device-transfer>
</data-extraction-rules>
`;

function applyAndroidManifest(androidManifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  app.$["android:allowBackup"] = "false";
  app.$["android:dataExtractionRules"] = `@xml/${RULES_NAME}`;
  delete app.$["android:fullBackupContent"];
  return androidManifest;
}

const withNoBackup = (config) => {
  config = withAndroidManifest(config, (c) => {
    c.modResults = applyAndroidManifest(c.modResults);
    return c;
  });
  config = withDangerousMod(config, [
    "android",
    (c) => {
      const dir = path.join(
        c.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml",
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${RULES_NAME}.xml`),
        NO_BACKUP_RULES_XML,
      );
      return c;
    },
  ]);
  return config;
};

module.exports = createRunOncePlugin(withNoBackup, PLUGIN_NAME, "1.0.0");
module.exports.applyAndroidManifest = applyAndroidManifest;
module.exports.NO_BACKUP_RULES_XML = NO_BACKUP_RULES_XML;
