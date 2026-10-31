// 图标字体只打用到的两套（Ionicons / MaterialIcons）。
// "@expo/vector-icons" 裸包名在 metro.config.js 里被指到 components/vector-icons.ts，只导出这两套；
// 别名方案下 tsc 看的仍是原包类型，引了别的图标集编译照过、运行时才是 undefined，所以在这里钉死。
// 另外两条路会绕过别名把整套字体拖回包里：@expo/vector-icons 的子路径、react-native-vector-icons（Expo 会把它改写成前者）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, jest } from "@jest/globals";

// 真的 getDefaultConfig 在 jest 里加载不起来（ESM 依赖），换成只带本测试要用的两个字段的替身
jest.mock("expo/metro-config", () => ({
  getDefaultConfig: () => ({ resolver: { assetExts: [] as string[] } }),
}));

const SRC = join(__dirname, "..");
const ROOT = join(SRC, "..");
const ALLOWED = ["Ionicons", "MaterialIcons"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const SPECIFIER_LOOSE =
  /["'`]((?:@expo\/vector-icons|react-native-vector-icons)[^"'`]*)["'`]/g;
const IMPORT =
  /(?:import|export)\s+(?:type\s+)?([^;]*?)\s+from\s+["'`]((?:@expo\/vector-icons|react-native-vector-icons)[^"'`]*)["'`]/g;

/** 生产代码里每一处图标包引用（import / export … from）：[文件, 导入的名字（default 记作 "default"）, 包路径] */
function iconImports(): [string, string, string][] {
  return sources(SRC).flatMap((file) => {
    // 注释里提到包名（带引号）不算引用
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const rel = file.slice(SRC.length + 1);
    const found = [...code.matchAll(IMPORT)].flatMap((m) => {
      const clause = m[1];
      const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
      const names = named
        .split(",")
        .map((n) => n.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
      const hasDefault = /^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim());
      if (hasDefault) names.push("default");
      if (clause.trim().startsWith("*")) names.push("*");
      return names.map((n): [string, string, string] => [rel, n, m[2]]);
    });
    // 不是 import … from 的写法（require、动态 import）一律算违规，免得绕过上面的检查
    const literals = [...code.matchAll(SPECIFIER_LOOSE)].length;
    const imports = [...code.matchAll(IMPORT)].length;
    if (literals !== imports) found.push([rel, "非 import 写法", "?"]);
    return found;
  });
}

describe("图标字体只打用到的两套", () => {
  it("裸包名 @expo/vector-icons 只能具名引 Ionicons / MaterialIcons", () => {
    const bad = iconImports().filter(
      ([, name, spec]) =>
        spec === "@expo/vector-icons" && !ALLOWED.includes(name),
    );
    expect(bad).toEqual([]);
  });

  it("子路径只能是 @expo/vector-icons/Ionicons 或 /MaterialIcons；不直接用 react-native-vector-icons", () => {
    const bad = iconImports().filter(([, , spec]) => {
      if (spec === "@expo/vector-icons") return false;
      return !ALLOWED.some((n) => spec === `@expo/vector-icons/${n}`);
    });
    expect(bad).toEqual([]);
  });

  it("扫描确实扫到了图标引用（防正则失效后空转通过）", () => {
    const used = new Set(iconImports().map(([, name]) => name));
    expect(used.has("Ionicons")).toBe(true);
    expect(used.has("MaterialIcons")).toBe(true);
  });

  it("vector-icons.ts 只导出这两套", () => {
    const shim = readFileSync(join(SRC, "components/vector-icons.ts"), "utf8");
    const exported = [...shim.matchAll(/export\s*\{\s*default as (\w+)\s*\}/g)];
    expect(exported.map((m) => m[1]).sort()).toEqual([...ALLOWED].sort());
    expect(shim).not.toMatch(/export\s*\*/);
  });

  it("metro.config.js 把裸包名指向 vector-icons.ts，其它模块照走默认解析", () => {
    const config = require(join(ROOT, "metro.config.js")) as {
      resolver: {
        resolveRequest: (
          ctx: { resolveRequest: () => unknown },
          name: string,
          platform: string,
        ) => unknown;
      };
    };
    const fallback = jest.fn(() => ({ type: "empty" }));
    const ctx = { resolveRequest: fallback };
    const hit = config.resolver.resolveRequest(
      ctx,
      "@expo/vector-icons",
      "android",
    ) as { type: string; filePath: string };
    expect(hit.type).toBe("sourceFile");
    expect(hit.filePath).toBe(join(SRC, "components/vector-icons.ts"));
    expect(fallback).not.toHaveBeenCalled();

    for (const name of [
      "@expo/vector-icons/Ionicons",
      "react-native",
      "expo-router",
    ]) {
      config.resolver.resolveRequest(ctx, name, "ios");
    }
    expect(fallback).toHaveBeenCalledTimes(3);
  });
});
