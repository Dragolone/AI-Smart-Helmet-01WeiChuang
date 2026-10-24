// 关掉安卓备份 / 换机迁移（回归 8.53）：极光的设备身份（app_prefs.xml 里的 uid / regId）跟着备份去了新手机，
// 两台共用一个 regId，旧手机退出登录新手机就收不到求救推送。这里守住三件事：清单开关、规则内容、app.json 配置。
import { afterEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import appJson from "../../app.json";

type Mod = (c: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Config = {
  name: string;
  slug: string;
  mods?: Record<string, Record<string, Mod>>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../with-no-backup.js") as ((c: Config) => Config) & {
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

// 组装层：插件挂上之后登记了哪些 mod，拿假的 modRequest 直接跑一遍（链上的下一个是空操作），看改出来的清单和写出的文件
describe("with-no-backup 组装", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  const configOf = (): Config => ({ name: "app", slug: "app" });

  it("登记安卓 manifest + dangerous 两个 mod；同一份 config 再挂一次不重复（runOnce）", () => {
    const cfg = plugin(configOf());
    expect(Object.keys(cfg.mods!.android).sort()).toEqual([
      "dangerous",
      "manifest",
    ]);
    expect(cfg.mods!.ios).toBeUndefined();
    const again = plugin(cfg);
    expect(again.mods!.android.manifest).toBe(cfg.mods!.android.manifest);
  });

  it("manifest mod：改的是 prebuild 传进来的清单——关备份、换成不带数据的规则、去掉 secure-store 的旧规则", async () => {
    const cfg = plugin(configOf());
    const out = await cfg.mods!.android.manifest({
      modRequest: { platform: "android" },
      modResults: manifestFixture(),
    });
    const app = (out.modResults as Manifest).manifest.application[0].$;
    expect(app["android:allowBackup"]).toBe("false");
    expect(app["android:dataExtractionRules"]).toBe("@xml/no_backup_rules");
    expect(app["android:fullBackupContent"]).toBeUndefined();
  });

  it("dangerous mod：把规则写进 android/app/src/main/res/xml/no_backup_rules.xml，目录不存在也建；再跑一次照样覆盖成同一份", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-backup-"));
    tmps.push(root);
    const platform = path.join(root, "android");
    const cfg = plugin(configOf());
    const req = {
      modRequest: {
        projectRoot: root,
        platformProjectRoot: platform,
        platform: "android",
      },
      modResults: {},
    };
    await cfg.mods!.android.dangerous(req);
    const file = path.join(
      platform,
      "app",
      "src",
      "main",
      "res",
      "xml",
      "no_backup_rules.xml",
    );
    expect(fs.readFileSync(file, "utf8")).toBe(plugin.NO_BACKUP_RULES_XML);
    fs.writeFileSync(file, "<!-- 旧的 -->");
    await cfg.mods!.android.dangerous(req);
    expect(fs.readFileSync(file, "utf8")).toBe(plugin.NO_BACKUP_RULES_XML);
  });
});
