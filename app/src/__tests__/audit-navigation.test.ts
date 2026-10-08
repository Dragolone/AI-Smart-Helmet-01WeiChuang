// 点了打开页面一律用 router.navigate，不用 router.push（2026-10-08 负责人在设备页连点两下头盔，叠出了两张设备详情）。
// push 每调一次就新开一页；navigate 在「同一页已经在最上面」时只是留在这一页（expo-router 的栈路由按路由名 + 路径参数判断）。
// 页面层没有渲染测试，用源码不变式钉住，免得以后新加的入口又写回 push。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "@jest/globals";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" ? [] : sources(full);
    }
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("打开页面的写法", () => {
  it("除了拉起求救倒计时页那一处，全仓不用 router.push", () => {
    const users = sources(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("router.push("))
      .map((f) => relative(SRC, f));
    // 那一处必须是 push：两顶头盔同时有进行中的单时，各开各的倒计时页（同一单只开一次由 presentedSos 管）
    expect(users).toEqual(["hooks/use-realtime.ts"]);
  });

  it("拉起求救倒计时页仍然是 push", () => {
    const src = readFileSync(join(SRC, "hooks/use-realtime.ts"), "utf8");
    expect(src).toMatch(
      /openCountdown: \(sosId, deviceId\) =>\s*router\.push\(`\/sos-active\?sosId=\$\{sosId\}&deviceId=\$\{deviceId\}`\)/,
    );
  });
});
