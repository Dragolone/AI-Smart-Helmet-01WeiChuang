// 后端会回的每个错误码，App 都要有一句人话（API.md §1.1：客户端只依赖 code）。
// 2026-10-16 模拟器实测：满员频道直接露出「操作失败（CHANNEL_FULL）」——当时还有 3 个码同样没映射。
// 后端在同一个仓库里，按源码对一遍：以后后端新增错误码而 App 没跟上，这里会先红。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

const BACKEND_SRC = join(__dirname, "..", "..", "..", "backend", "src");
const MESSAGES = readFileSync(
  join(__dirname, "..", "api", "error-messages.ts"),
  "utf8",
);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "generated" || name === "node_modules") return [];
    if (statSync(p).isDirectory()) return tsFiles(p);
    return name.endsWith(".ts") && !name.endsWith(".spec.ts") ? [p] : [];
  });
}

describe("后端错误码都有 App 文案", () => {
  const backendCodes = new Set(
    tsFiles(BACKEND_SRC).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/code: '([A-Z_]+)'/g)].map(
        (m) => m[1],
      ),
    ),
  );
  const mapped = new Set(
    [...MESSAGES.matchAll(/^\s+([A-Z_]+): "error\./gm)].map((m) => m[1]),
  );

  it("扫到了后端的错误码（防止路径变了这条测试空转）", () => {
    expect(backendCodes.size).toBeGreaterThan(10);
    expect(backendCodes.has("SOS_ALREADY_FINALIZED")).toBe(true);
  });

  it("每个都在 error-messages 的映射表里", () => {
    expect([...backendCodes].filter((c) => !mapped.has(c)).sort()).toEqual([]);
  });
});
