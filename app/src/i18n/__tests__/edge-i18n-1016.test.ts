// 文案字典与 translate 的边界（2026-10-16）。audit-i18n-parity 按文件清单查三语 key 一致；
// 这里改成扫 messages/ 目录（新加的文件——如 guide.ts——不用记得登记也会被查到），并补占位符一致、跨文件重名、
// translate 遇到不存在的 key / 语言。
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import {
  translate,
  useLocaleStore,
  type Locale,
  type MessageKey,
} from "../index";

const LOCALES = ["zh-CN", "zh-TW", "en"] as const;
type Dict = Record<(typeof LOCALES)[number], Record<string, string>>;
const DIR = join(__dirname, "..", "messages");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(join(DIR, f)) as Record<string, Dict>;
    return { file: f, dict: Object.values(mod)[0] };
  });
const placeholders = (s: string) => [...(s.match(/\{(\w+)\}/g) ?? [])].sort();

describe("字典：扫整个 messages/ 目录", () => {
  it("每个文件都导出三种语言", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(15);
    for (const { file, dict } of FILES) {
      for (const loc of LOCALES)
        expect({ file, loc, ok: typeof dict[loc] === "object" }).toEqual({
          file,
          loc,
          ok: true,
        });
    }
  });

  it("每个文件三种语言的 key 集合一致、没有空串", () => {
    for (const { file, dict } of FILES) {
      const base = Object.keys(dict["zh-CN"]).sort();
      for (const loc of LOCALES) {
        expect({ file, loc, keys: Object.keys(dict[loc]).sort() }).toEqual({
          file,
          loc,
          keys: base,
        });
        for (const [k, v] of Object.entries(dict[loc])) {
          expect({ file, loc, k, empty: v.trim() === "" }).toEqual({
            file,
            loc,
            k,
            empty: false,
          });
        }
      }
    }
  });

  it("同一个 key 三种语言的占位符一样（英文漏了 {n} 就会少一个数字）", () => {
    for (const { file, dict } of FILES) {
      for (const k of Object.keys(dict["zh-CN"])) {
        const zh = placeholders(dict["zh-CN"][k]);
        expect({ file, k, tw: placeholders(dict["zh-TW"][k]) }).toEqual({
          file,
          k,
          tw: zh,
        });
        expect({ file, k, en: placeholders(dict.en[k]) }).toEqual({
          file,
          k,
          en: zh,
        });
      }
    }
  });

  it("不同文件之间没有重名的 key（index.ts 按顺序展开，后面的会悄悄盖掉前面的）", () => {
    const owner = new Map<string, string>();
    const dups: string[] = [];
    for (const { file, dict } of FILES) {
      for (const k of Object.keys(dict["zh-CN"])) {
        if (owner.has(k)) dups.push(`${k}: ${owner.get(k)} / ${file}`);
        else owner.set(k, file);
      }
    }
    expect(dups).toEqual([]);
  });

  it("没有写坏的占位符（缺半边花括号、花括号里有空格）", () => {
    for (const { file, dict } of FILES) {
      for (const loc of LOCALES) {
        for (const [k, v] of Object.entries(dict[loc])) {
          const bad = /\{[^}]*$|^[^{]*\}|\{\s|\s\}/.test(v);
          expect({ file, loc, k, bad }).toEqual({ file, loc, k, bad: false });
        }
      }
    }
  });

  it("目录里的每个文件都接进了 translate（随便取每个文件的第一个 key，三种语言都查得到）", () => {
    for (const { file, dict } of FILES) {
      const k = Object.keys(dict["zh-CN"])[0] as MessageKey;
      for (const loc of LOCALES) {
        expect({ file, loc, text: translate(k, undefined, loc) }).toEqual({
          file,
          loc,
          text: dict[loc][k],
        });
      }
    }
  });
});

describe("translate 的边", () => {
  // 原来 key 不存在时返回 undefined：带参数就在 .replace 上抛 TypeError，不带参数会被插成「undefined」
  it("不存在的 key（用服务端值拼出来的）：给空串，带不带参数都不抛", () => {
    const k = "safety.status.expired" as MessageKey;
    expect(translate(k, undefined, "zh-CN")).toBe("");
    expect(() => translate(k, { n: 1 }, "en")).not.toThrow();
    expect(translate(k, { n: 1 }, "en")).toBe("");
    expect(
      translate(
        "safety.recordsLatest",
        { date: "10月16日", type: "疑似摔倒", status: translate(k) },
        "zh-CN",
      ),
    ).not.toContain("undefined");
  });

  it("语言值不在三种之内（被改坏的状态）：按简体给，不抛", () => {
    expect(translate("common.justNow", undefined, "fr" as Locale)).toBe("刚刚");
    const prev = useLocaleStore.getState().locale;
    try {
      useLocaleStore.setState({ locale: "xx" as Locale });
      expect(translate("common.justNow")).toBe("刚刚");
    } finally {
      useLocaleStore.setState({ locale: prev });
    }
  });

  it("参数值是负数、小数、空串、很长的字符串：原样插进去", () => {
    expect(translate("common.minutesAgo", { n: -3 }, "zh-CN")).toBe(
      "-3 分钟前",
    );
    expect(translate("common.minutesAgo", { n: 1.5 }, "en")).toBe(
      "1.5 min ago",
    );
    expect(translate("common.minutesAgo", { n: "" }, "zh-CN")).toBe(" 分钟前");
    expect(
      translate("common.minutesAgo", { n: "x".repeat(1000) }, "zh-CN"),
    ).toHaveLength(1000 + 4);
  });

  it("参数名是 Object.prototype 的成员名、但文案里没有这个占位符：不影响结果", () => {
    expect(
      translate(
        "common.minutesAgo",
        { constructor: 1, n: 2 } as never,
        "zh-CN",
      ),
    ).toBe("2 分钟前");
  });
});
