// 关掉安卓备份 / 换机迁移（回归 8.53）：极光的设备身份（app_prefs.xml 里的 uid / regId）跟着备份去了新手机，
// 两台共用一个 regId，旧手机退出登录新手机就收不到求救推送。这里守住三件事：清单开关、规则内容、app.json 配置。
import { describe, expect, it } from "@jest/globals";

import appJson from "../../app.json";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../with-no-backup.js") as {
  applyAndroidManifest: (m: unknown) => unknown;
  NO_BACKUP_RULES_XML: string;
};

type Manifest = { manifest: { application: { $: Record<string, string> }[] } };

/** expo-secure-store 默认配置下 prebuild 出来的 application 属性 */
const manifestFixture = (): Manifest => ({
  manifest: {
    application: [
      {
        $: {
          "android:name": ".MainApplication",
          "android:allowBackup": "true",
          "android:fullBackupContent": "@xml/secure_store_backup_rules",
          "android:dataExtractionRules":
            "@xml/secure_store_data_extraction_rules",
        },
      },
    ],
  },
});

describe("with-no-backup", () => {
  it("关掉 allowBackup、换成不带任何数据的迁移规则、去掉 secure-store 的旧规则", () => {
    const m = plugin.applyAndroidManifest(manifestFixture()) as Manifest;
    const app = m.manifest.application[0].$;
    expect(app["android:allowBackup"]).toBe("false");
    expect(app["android:dataExtractionRules"]).toBe("@xml/no_backup_rules");
    expect(app["android:fullBackupContent"]).toBeUndefined();
    expect(app["android:name"]).toBe(".MainApplication");
  });

  it("云备份和换机迁移两节都逐个域排除，不留任何 include（安卓 12 起 allowBackup=false 挡不住换机迁移）", () => {
    const xml = plugin.NO_BACKUP_RULES_XML;
    expect(xml).not.toContain("<include");
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body =
        xml.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`))?.[1] ??
        "";
      for (const d of ["root", "file", "database", "sharedpref", "external"]) {
        expect(body).toContain(`<exclude domain="${d}" path="." />`);
      }
    }
  });

  it("app.json：allowBackup=false、secure-store 不再写自己的规则、插件已登记", () => {
    const { expo } = appJson as unknown as {
      expo: {
        android: { allowBackup?: boolean };
        plugins: (string | [string, Record<string, unknown>])[];
      };
    };
    expect(expo.android.allowBackup).toBe(false);
    const secureStore = expo.plugins.find(
      (p) => (Array.isArray(p) ? p[0] : p) === "expo-secure-store",
    );
    expect(secureStore).toEqual([
      "expo-secure-store",
      { configureAndroidBackup: false },
    ]);
    expect(expo.plugins).toContain("./plugins/with-no-backup.js");
  });
});
