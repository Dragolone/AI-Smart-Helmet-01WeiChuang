// 每个页面都有自己的错误边界（10-21 夜测）：一页渲染出错只换掉这一页，标签栏、别的页面和求救倒计时页照常能用。
// 原来只有根上一层，常驻的地图 / 对讲 / 我的标签页一出错整个 App 都换成「页面暂时无法显示」。页面层没有渲染测试，用源码不变式钉住。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "@jest/globals";

const APP = join(__dirname, "..", "app");

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routes(full);
    return /\.tsx$/.test(name) && !name.startsWith("_layout") ? [full] : [];
  });
}

describe("页面级错误边界", () => {
  it("app/ 下每个页面文件都导出 ErrorBoundary = RouteErrorBoundary", () => {
    const files = routes(APP);
    const missing = files
      .filter(
        (f) =>
          !readFileSync(f, "utf8").includes(
            'export { RouteErrorBoundary as ErrorBoundary } from "@/components/route-error-boundary";',
          ),
      )
      .map((f) => relative(APP, f));
    expect(files.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });
});
