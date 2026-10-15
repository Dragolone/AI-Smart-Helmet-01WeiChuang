// 英文文案里的 App 名（2026-10-16 第二轮边界测试）。
// 10-15 App 改名「零一智行」（#185）时只改了中文，英文五处还写旧名「Lingyi Weichuang」（那是旧名「零一唯创」的拼音）：
// 分享对讲邀请、告诉紧急联系人的短信、反馈邮件标题、「关于」、登录页标题。
// App 没有单独的英文名：图标下显示名、商店名、备案名都是「零一智行」（app.json 不分语言，STORE_LISTING §1 要求三处一致），
// 收到英文分享的人也只能按「零一智行」在商店里找到它——英文里一律写「零一智行」。
// 公司法定英文名 Shenzhen Lingyi Weichuang Technology Co., Ltd. 不是 App 名，保持不变。
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import { translate } from "../index";

const APP_NAME = "零一智行";
const COMPANY_EN = "Shenzhen Lingyi Weichuang Technology Co., Ltd.";
type Dict = Record<"zh-CN" | "zh-TW" | "en", Record<string, string>>;
const DIR = join(__dirname, "..", "messages");
const all = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts"))
  .flatMap((f) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dict = Object.values(require(join(DIR, f)))[0] as Dict;
    return (["zh-CN", "zh-TW", "en"] as const).flatMap((loc) =>
      Object.entries(dict[loc]).map(([key, text]) => ({
        file: f,
        loc,
        key,
        text,
      })),
    );
  });

describe("英文 App 名统一为「零一智行」", () => {
  it("英文登录页标题（auth.appName）就是「零一智行」", () => {
    expect(translate("auth.appName", undefined, "en")).toBe(APP_NAME);
  });

  it("五处原来写旧名的英文文案都换成了「零一智行」", () => {
    expect(translate("profile.about", undefined, "en")).toBe(
      `About ${APP_NAME}`,
    );
    expect(translate("help.emailSubject", { v: "1.0.0" }, "en")).toBe(
      `${APP_NAME} app feedback (version 1.0.0)`,
    );
    expect(
      translate(
        "intercom.shareMessage",
        { name: "Weekend", code: "AB12CD" },
        "en",
      ),
    ).toBe(
      `Join my ride channel "Weekend" in the ${APP_NAME} app with invite code AB12CD`,
    );
    expect(translate("contacts.tellMessage", { name: "Mom" }, "en")).toContain(
      `in the ${APP_NAME} helmet app`,
    );
  });

  it("任何语言的文案里都不再有旧名「Lingyi Weichuang」，公司法定英文名除外", () => {
    const stale = all.filter((e) =>
      e.text.replaceAll(COMPANY_EN, "").includes("Lingyi Weichuang"),
    );
    expect(stale.map((e) => `${e.loc} ${e.key}`)).toEqual([]);
  });

  it("中文文案里没有旧名「零一唯创 / 零一唯創」，公司名（深圳零一唯创科技有限公司）除外", () => {
    const stale = all.filter((e) =>
      e.text.replace(/深圳零一唯[创創]科技有限公司/g, "").match(/零一唯[创創]/),
    );
    expect(stale.map((e) => `${e.loc} ${e.key}`)).toEqual([]);
  });

  it("公司法定英文名还在「关于」正文里，没被一起换掉", () => {
    expect(translate("profile.aboutBody", undefined, "en")).toContain(
      COMPANY_EN,
    );
  });

  it("三种语言里提到 App 名的地方写法一致：凡写「零一智行」的都是同四个字", () => {
    for (const loc of ["zh-CN", "zh-TW", "en"] as const)
      expect(translate("auth.appName", undefined, loc)).toBe(APP_NAME);
  });
});
