// 系统语言 → App 语言的边界补测（2026-10-16）。edge-persisted-stores.test.ts 已钉 en / zh-TW / HK / MO / Hant / Hans-HK；
// 这里补粤语、带扩展标签的写法、和「中文开头但不是 zh」的语言。
import { afterEach, describe, expect, it, jest } from "@jest/globals";

type LocaleStore = typeof import("../locale-store");

const detectWith = (tag: string | undefined) => {
  jest.spyOn(Intl, "DateTimeFormat").mockImplementation(
    () =>
      ({
        resolvedOptions: () => ({ locale: tag }),
      }) as unknown as Intl.DateTimeFormat,
  );
  let mod!: LocaleStore;
  jest.isolateModules(() => {
    mod = jest.requireActual<LocaleStore>("../locale-store");
  });
  return mod.detectLocale();
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe("detectLocale 的边", () => {
  // 原来只认 zh- 开头：iOS「粤语（繁体）」的 yue-Hant-HK 落到简体
  it.each([
    ["yue-Hant-HK", "zh-TW"],
    ["yue-Hant", "zh-TW"],
    ["yue-HK", "zh-TW"],
    ["yue-Hans-CN", "zh-CN"],
    ["yue", "zh-CN"],
  ])("粤语 %s → %s", (tag, expected) => {
    expect(detectWith(tag)).toBe(expected);
  });

  it.each([
    ["zh-Hant-TW", "zh-TW"],
    ["zh-TW-u-ca-roc", "zh-TW"],
    ["zh-HK-u-nu-hanidec", "zh-TW"],
    ["zh-Hans-MO", "zh-CN"],
    ["zh-Hans-TW", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-MY", "zh-CN"],
    ["zh-CN-u-ca-chinese", "zh-CN"],
    ["ZH-HANT", "zh-TW"],
  ])("中文带地区 / 脚本 / 扩展 %s → %s", (tag, expected) => {
    expect(detectWith(tag)).toBe(expected);
  });

  it.each([
    // 「zh」只是前缀的别的语言代码（如 zha 壮语）不算中文；中文以外的系统语言退回英文（负责人 10-21 定，O11）
    ["zha-CN", "en"],
    ["zh-Latn-TW", "zh-TW"],
    ["ja-JP", "en"],
    ["ko-KR", "en"],
    ["fr-TW", "en"],
    ["en-HK", "en"],
    ["en-TW", "en"],
    ["", "zh-CN"],
  ])("其它 %s → %s", (tag, expected) => {
    expect(detectWith(tag)).toBe(expected);
  });
});
