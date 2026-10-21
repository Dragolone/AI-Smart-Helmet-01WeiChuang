// 键盘让位的写法（2026-10-17 安卓 16 模拟器）：原来整页表单和居中弹层只在 iOS 让位、Android 交给系统，以为系统会把窗口
// 缩到键盘上方——内容铺到系统栏底下（edge-to-edge）后系统不再缩，改昵称弹层、修改密码页底部的「保存」都被键盘盖住。
// 一律包共用的 KeyboardAvoid（双端 padding，并按自己在窗口里的位置补上导航栏高度）。页面层没有键盘的渲染测试，用源码不变式钉住。
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

describe("键盘让位", () => {
  it("不再有只在 iOS 让位的写法", () => {
    const hits = sources(SRC)
      .filter((f) =>
        /behavior=\{\s*Platform\.OS === "ios" \? "padding" : undefined\s*\}/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it("直接用 RN KeyboardAvoidingView 的只有共用组件和扫码绑定页（那一层铺满全屏、顶上没有导航栏，双端已是 padding）", () => {
    const users = sources(SRC)
      .filter((f) => readFileSync(f, "utf8").includes("<KeyboardAvoidingView"))
      .map((f) => relative(SRC, f))
      .sort();
    expect(users).toEqual([
      "app/bind-device.tsx",
      "components/keyboard-avoid.tsx",
    ]);
  });

  it("页面里有输入框的，都包了 KeyboardAvoid（10-21 夜测：添加紧急联系人页漏了，横着拿的大屏 / 小屏上保存按钮被键盘盖住）", () => {
    const pages = sources(join(SRC, "app")).filter((f) => {
      const src = readFileSync(f, "utf8");
      return /<(FormInput|TextInput)\b/.test(src);
    });
    const missing = pages
      .filter((f) => !readFileSync(f, "utf8").includes("<KeyboardAvoid"))
      .map((f) => relative(SRC, f))
      // 蓝牙工程模式是开发用的调试页；扫码绑定页直接用 RN 的 KeyboardAvoidingView（见上一条）
      .filter((f) => f !== "app/ble-bench.tsx" && f !== "app/bind-device.tsx");
    expect(pages.length).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });
});
