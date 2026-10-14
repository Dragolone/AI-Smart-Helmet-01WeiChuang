// 点了打开页面一律用 router.navigate，不用 router.push（2026-10-08 负责人在设备页连点两下头盔，叠出了两张设备详情）。
// push 每调一次就新开一页；navigate 在「同一页已经在最上面」时只是留在这一页——expo-router 只比路由名和**路径**参数，
// 查询参数（?sosId=…）不算：最上面是 sos-active 时 navigate 到另一单会直接改写这一页的参数。所以 sos-active 在 _layout
// 用 dangerouslySingular 按 sosId 区分页面（见下面「求救倒计时页」一组）。
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

describe("求救倒计时页不被别的页面挤掉（10-06 F-4 / F-5）", () => {
  it("_layout 按 sosId 区分倒计时页：点另一单的通知不改写当前这一页", () => {
    const src = readFileSync(join(SRC, "app/_layout.tsx"), "utf8");
    expect(src).toMatch(
      /name="sos-active"\s*dangerouslySingular=\{\(_, params\) =>\s*typeof params\.sosId === "string" \? params\.sosId : undefined\s*\}/,
    );
  });

  it("倒计时页的内容按 sosId 重建（换了单不复用上一单的 eventId）", () => {
    const src = readFileSync(join(SRC, "app/sos-active.tsx"), "utf8");
    expect(src).toMatch(/<SosActiveContent key=\{sosId \?\? "drill"\} \/>/);
  });

  it("除倒计时页自己那份，返回键监听都只在页面获得焦点时注册", () => {
    // 不看焦点的监听在别的页面盖上来后仍会收到返回键；依赖变化重新注册时还会排到倒计时页那份前面
    //（RN 的 BackHandler 后注册先执行）——10-14 绑定页的 dismissAll 就是这样能关掉倒数中的倒计时页
    const offenders = sources(SRC)
      .filter((f) => relative(SRC, f) !== join("app", "sos-active.tsx"))
      .flatMap((f) => {
        const src = readFileSync(f, "utf8");
        const hits: string[] = [];
        let at = src.indexOf("BackHandler.addEventListener(");
        while (at !== -1) {
          const before = src.slice(0, at);
          if (
            before.lastIndexOf("useFocusEffect(") <
            before.lastIndexOf("useEffect(")
          ) {
            hits.push(relative(SRC, f));
          }
          at = src.indexOf("BackHandler.addEventListener(", at + 1);
        }
        return hits;
      });
    expect(offenders).toEqual([]);
  });
});
