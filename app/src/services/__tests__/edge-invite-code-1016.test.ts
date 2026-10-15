// 对讲邀请码输入的边界（2026-10-16）：微信里长按复制分享消息默认复制整条，粘进邀请码框原来被截成前 6 个字。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";

import { translate } from "@/i18n";
import { inviteCodeFrom } from "../invite-code";

describe("inviteCodeFrom", () => {
  it("正好 6 位字母数字：原样（大小写交给服务端归一）", () => {
    expect(inviteCodeFrom("K7RM3X")).toBe("K7RM3X");
    expect(inviteCodeFrom("k7rm3x")).toBe("k7rm3x");
    expect(inviteCodeFrom("483921")).toBe("483921");
  });

  it("首尾空白、中间夹空格或横线、全角字母数字、复制带进来的方向标记：都认", () => {
    expect(inviteCodeFrom("  K7RM3X\n")).toBe("K7RM3X");
    expect(inviteCodeFrom("K7R M3X")).toBe("K7RM3X");
    expect(inviteCodeFrom("K7R-M3X")).toBe("K7RM3X");
    expect(inviteCodeFrom("Ｋ７ＲＭ３Ｘ")).toBe("K7RM3X");
    expect(inviteCodeFrom("‭K7RM3X‬")).toBe("K7RM3X");
  });

  it("三种语言的整句分享文案（App 自己发出去的那句）：认出里面的邀请码", () => {
    for (const loc of ["zh-CN", "zh-TW", "en"] as const) {
      const msg = translate(
        "intercom.shareMessage",
        { name: "周末骑行队", code: "K7RM3X" },
        loc,
      );
      expect({ loc, code: inviteCodeFrom(msg) }).toEqual({
        loc,
        code: "K7RM3X",
      });
    }
  });

  it("频道名本身是 6 位字母数字（「ABC123」）时，取邀请码那一个，不取频道名", () => {
    const msg = translate(
      "intercom.shareMessage",
      { name: "ABC123", code: "K7RM3X" },
      "zh-CN",
    );
    expect(inviteCodeFrom(msg)).toBe("K7RM3X");
  });

  it("邀请码后面紧跟着别的字母数字（不是 6 位的码）：不认", () => {
    expect(inviteCodeFrom("邀请码：K7RM3XY")).toBeNull();
  });

  it("5 位、7 位、带标点、只有中文、空串：认不出", () => {
    for (const bad of [
      "K7RM3",
      "K7RM3XY",
      "K7RM3!",
      "加入我的骑行",
      "",
      "   ",
      "K7R_M3X",
    ]) {
      expect(inviteCodeFrom(bad)).toBeNull();
    }
  });

  it("原来的截断结果「加入我的骑行」（前 6 个字）认不出——要整句才行", () => {
    const msg = translate(
      "intercom.shareMessage",
      { name: "x", code: "K7RM3X" },
      "zh-CN",
    );
    expect(inviteCodeFrom(msg.slice(0, 6))).toBeNull();
  });
});

describe("接线：对讲页邀请码输入（源码不变式）", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "app", "(tabs)", "intercom.tsx"),
    "utf8",
  );

  it("输入框不再只收 6 个字；粘进来就换成认出的码；提交前同样整理", () => {
    expect(src).not.toMatch(/maxLength=\{6\}/);
    expect(src).toMatch(
      /onChangeText=\{\(v\) => setCodeDraft\(inviteCodeFrom\(v\) \?\? v\)\}/,
    );
    expect(src).toMatch(/const inviteCode = inviteCodeFrom\(codeDraft\);/);
    expect(src).toMatch(/\.join\(\{ inviteCode \}\)/);
  });
});
