// React Compiler 不能悄悄退出这几个页面。
//
// 一个组件里只要出现编译器不支持的写法——没有 catch 的 try/finally、try 里的条件表达式、一处 eslint-disable 压掉的
// hooks 规则——整个组件就静默退出编译（正式包里 panicThreshold 是 NONE，只记一条日志，不报错也不变慢提示），
// 之后给它加的每一处 memo 优化都白做了，而且没人会发现。
// 这里用和 App 一样的插件（babel-plugin-react-compiler，babel-preset-expo 带的那份）和同样的选项（target 19）
// 编译这几个文件，读它的日志：没有编译失败的函数，并且页面主体确实编译成功了。
// 编不过的组件（比如设备页 index.tsx 的 DevicesScreen，onRefresh 里有 try/finally）本来就不在这张表里。
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type CompilerEvent = {
  kind: string;
  fnName?: string | null;
  fnLoc?: { start?: { line?: number } } | null;
  detail?: { options?: { reason?: string }; reason?: string };
  data?: unknown;
};

const babel = require("@babel/core") as {
  transformSync(code: string, options: object): unknown;
};
const compilerPlugin = require.resolve("babel-plugin-react-compiler");
const srcRoot = join(__dirname, "..");

function compile(rel: string): CompilerEvent[] {
  const filename = join(srcRoot, rel);
  const events: CompilerEvent[] = [];
  babel.transformSync(readFileSync(filename, "utf8"), {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [
      [
        compilerPlugin,
        {
          target: "19",
          // 和正式包一样不抛错，只记日志；失败的函数在日志里是 CompileError / PipelineError
          panicThreshold: "none",
          logger: {
            logEvent: (_file: unknown, ev: CompilerEvent) => events.push(ev),
          },
        },
      ],
    ],
  });
  return events;
}

const failures = (events: CompilerEvent[]) =>
  events
    .filter((e) => e.kind === "CompileError" || e.kind === "PipelineError")
    .map(
      (e) =>
        `${e.fnName ?? "?"}（第 ${e.fnLoc?.start?.line ?? "?"} 行）：${
          e.detail?.options?.reason ??
          e.detail?.reason ??
          JSON.stringify(e.data)
        }`,
    );
const compiled = (events: CompilerEvent[]) =>
  events.filter((e) => e.kind === "CompileSuccess").map((e) => e.fnName);

/** 文件 → 其中必须编译成功的组件（页面主体） */
const GUARDED: [string, string[]][] = [
  ["app/(tabs)/map.tsx", ["MapScreen"]],
  ["app/device/[deviceId].tsx", ["DeviceDetailScreen"]],
  ["app/(tabs)/safety.tsx", ["SafetyScreen"]],
  ["components/map/amap-view.tsx", ["AmapView"]],
  ["components/map/ride-replay.tsx", ["RideReplay"]],
  ["components/map/ride-list.tsx", ["RideList"]],
];

describe("React Compiler 没有静默退出这几个页面", () => {
  it.each(GUARDED)("%s：没有编译失败的函数，页面主体编译成功", (rel, must) => {
    const events = compile(rel);
    expect(failures(events)).toEqual([]);
    for (const name of must) expect(compiled(events)).toContain(name);
  });
});

describe("倒计时页的 SosActiveContent 明确不让编译器碰", () => {
  const rel = "app/sos-active.tsx";

  it('首行写着 "use no memo"（队列靠 cacheTick 重渲染重算，编译器看不出这个依赖，会把它 memo 掉）', () => {
    const src = readFileSync(join(srcRoot, rel), "utf8");
    expect(src).toMatch(
      /function SosActiveContent\(\) \{\s*(\/\/[^\n]*\n\s*)*"use no memo";/,
    );
  });

  it("编译器没有编译它（现在它因为 eslint-disable 和 try 里的条件表达式本来就编不过，指令是防着将来改好后静默变坏）", () => {
    expect(compiled(compile(rel))).not.toContain("SosActiveContent");
  });
});
