// 页面读路由参数一律经 hooks/use-route-params（10-22 夜测）：同一参数在链接里写两次时 expo-router 给数组，
// 倒计时页、扫码绑定页拿数组当字符串直接崩。直接用 useLocalSearchParams / useGlobalSearchParams 的页面会再犯，源码不变式钉住。
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

describe("路由参数取单值", () => {
  it("除了 hooks/use-route-params，没有地方直接读 expo-router 的搜索参数", () => {
    const hits = sources(SRC)
      .filter((f) =>
        /\buse(Local|Global)SearchParams\b/.test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(SRC, f));
    expect(hits).toEqual(["hooks/use-route-params.ts"]);
  });
});
