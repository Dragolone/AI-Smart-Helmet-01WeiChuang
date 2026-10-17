// 钥匙串条目的键名只在 services/secure-keys.ts 里写（2026-10-17）。
// iOS 删 App 不删钥匙串，重装后第一次打开按那份登记表清掉上一次安装留下的东西（services/fresh-install）；
// 注销账号按里面的账号清单删。别处自己写一个键名，重装后就会漏清——用源码不变式钉住。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "@jest/globals";

const SRC = join(__dirname, "..");
const REGISTRY = "services/secure-keys.ts";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" ? [] : sources(full);
    }
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

const all = sources(SRC).map((f) => ({
  path: relative(SRC, f),
  text: readFileSync(f, "utf8"),
}));
const keychainUsers = all.filter(
  (f) => f.path !== REGISTRY && f.text.includes('from "expo-secure-store"'),
);

describe("钥匙串的键名", () => {
  it("读写钥匙串的文件都从登记表取键名", () => {
    expect(keychainUsers.length).toBeGreaterThan(10);
    const missing = keychainUsers
      .filter((f) => !f.text.includes('from "@/services/secure-keys"'))
      .map((f) => f.path);
    expect(missing).toEqual([]);
  });

  it("调用 SecureStore 时不直接写键名", () => {
    const inline = all
      .filter((f) =>
        /SecureStore\.(?:get|set|delete)Item(?:Async)?\(\s*["'`]/.test(f.text),
      )
      .map((f) => f.path);
    expect(inline).toEqual([]);
  });

  it("登记表之外不再定义键名常量 / 键名模板", () => {
    const local = keychainUsers
      .filter(
        (f) =>
          /const \w*KEY\w* = ["'`]/.test(f.text) ||
          /["'`](?:helmet\.|last_login_phone|keepalive_tip_shown|ble_onboarding_dismissed)/.test(
            f.text,
          ),
      )
      .map((f) => f.path);
    expect(local).toEqual([]);
  });

  it("登记表里每个按账号的键名函数都在账号清单里（注销、重装清理都按清单删）", () => {
    const registry = readFileSync(join(SRC, REGISTRY), "utf8");
    const builders = [...registry.matchAll(/export const (\w+KeyOf) =/g)].map(
      (m) => m[1],
    );
    expect(builders.length).toBeGreaterThanOrEqual(6);
    const list = registry.slice(
      registry.indexOf("export const accountSecureKeysOf"),
    );
    for (const name of builders) expect(list).toContain(`${name}(userId)`);
  });
});

describe("重装检查排在读钥匙串之前", () => {
  it("根布局：清完才恢复会话 / 语言 / 外观 / 同意，别处不再直接恢复", () => {
    const src = readFileSync(join(SRC, "app/_layout.tsx"), "utf8");
    const after = src.match(
      /clearIfFreshInstall\(\)\.then\(\(\) => \{([\s\S]*?)\n {4}\}\);/,
    );
    expect(after).not.toBeNull();
    for (const call of [
      "void hydrate();",
      "void hydrateLocale();",
      "void hydrateTheme();",
      "void hydrateConsent();",
    ]) {
      expect(after![1]).toContain(call);
      expect(src.split(call).length - 1).toBe(1);
    }
  });

  it("开屏：清完才读启动记录", () => {
    const src = readFileSync(
      join(SRC, "components/splash/splash-overlay.tsx"),
      "utf8",
    );
    expect(src).toMatch(
      /clearIfFreshInstall\(\)\.then\(\(\) => \{\s*if \(!cancelled\) void hydrate\(\);/,
    );
  });
});
