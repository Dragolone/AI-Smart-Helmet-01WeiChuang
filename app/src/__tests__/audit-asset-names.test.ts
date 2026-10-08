// 资源文件不能只靠扩展名区分。
//
// 安卓正式包把打进去的资源放进 res/，名字是「路径去掉扩展名和符号」：assets/splash/a-b.mp4 和 a-b.skpack
// 都叫 splash_ab，合并资源时报重名，正式包编不过。调试包里资源走开发服务器，所以平时开发发现不了
// （2026-10-08 第一次按正式方式编包时才撞上）。规则照 React Native 的 assets/path-support.js。
import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..", "..", "assets");
/** 这些类型进 drawable，其余进 raw；两边各自不能重名 */
const drawable = new Set([
  "gif",
  "jpeg",
  "jpg",
  "ktx",
  "png",
  "svg",
  "webp",
  "xml",
]);
/** 不是资源、是代码或数据的（Metro 当模块处理，不进 res/） */
const notAssets = new Set(["json", "js", "ts", "tsx", "md"]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.startsWith(".") ? [] : [p];
  });
}

describe("资源文件名", () => {
  it("同一个目录里没有只差扩展名的两个资源", () => {
    const seen = new Map<string, string[]>();
    for (const file of walk(root)) {
      const ext = path.extname(file).slice(1).toLowerCase();
      if (notAssets.has(ext)) continue;
      const rel = path.relative(path.dirname(root), file);
      const name = rel
        .slice(0, rel.length - path.extname(rel).length)
        // logo@2x.png 和 logo.png 是同一个资源的两个倍率
        .replace(/@\d+(\.\d+)?x$/, "")
        .toLowerCase()
        .split(path.sep)
        .join("_")
        .replace(/[^a-z0-9_]/g, "")
        .replace(/^assets_/, "");
      const key = `${drawable.has(ext) ? "drawable" : "raw"}/${name}`;
      const base = rel.replace(/@\d+(\.\d+)?x(\.[^.]+)$/, "$2");
      const list = seen.get(key) ?? [];
      if (!list.includes(base)) list.push(base);
      seen.set(key, list);
    }
    const clashes = [...seen.entries()].filter(([, files]) => files.length > 1);
    expect(clashes).toEqual([]);
  });
});
