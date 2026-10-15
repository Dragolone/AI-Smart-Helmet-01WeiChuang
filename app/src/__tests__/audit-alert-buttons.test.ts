// 系统提示框必须自带按钮文案（2026-10-16 华为实测：不传按钮时 Android 用系统自带的英文「OK」，中文界面也是）。
// 只有一个按钮的提示走 services/notice 的 showNotice；自己传按钮的 Alert.alert 不受影响。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** 取出 Alert.alert( … ) 整段（按括号配对） */
function alertCalls(code: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const start = code.indexOf("Alert.alert(", from);
    if (start < 0) return calls;
    let i = start + "Alert.alert(".length;
    let depth = 1;
    while (depth > 0 && i < code.length) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") depth -= 1;
      i += 1;
    }
    calls.push(code.slice(start, i));
    from = i;
  }
}

describe("系统提示框的按钮", () => {
  it("没有不传按钮的 Alert.alert（会显示英文 OK）", () => {
    const bare = sources(SRC).flatMap((file) =>
      alertCalls(readFileSync(file, "utf8"))
        .filter((call) => !call.includes("["))
        .map((call) => `${file.slice(SRC.length + 1)}: ${call.slice(0, 80)}`),
    );
    expect(bare).toEqual([]);
  });

  it("showNotice 给的是本地化的按钮文案", () => {
    const notice = readFileSync(join(SRC, "services/notice.ts"), "utf8");
    expect(notice).toMatch(/\[\{ text: translate\("common\.confirm"\) \}\]/);
  });
});
