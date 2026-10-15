import { describe, expect, it } from "@jest/globals";

import { cleanNickname, personNameOf } from "../user-name";

describe("personNameOf：昵称为空时回退（10-16）", () => {
  it("正常昵称原样用", () => {
    expect(personNameOf({ nickname: "骑手", phone: "13800001234" }, "我")).toBe(
      "骑手",
    );
  });

  it("空串 / 全空白 / 零宽字符：回退手机号", () => {
    for (const nickname of ["", "   ", "​​", "　"]) {
      expect(personNameOf({ nickname, phone: "138****1234" }, "我")).toBe(
        "138****1234",
      );
    }
  });

  it("带换行：压成一行", () => {
    expect(personNameOf({ nickname: "第一行\n第二行", phone: "1" }, "我")).toBe(
      "第一行 第二行",
    );
  });

  it("昵称、手机号都没有：用 fallback", () => {
    expect(personNameOf({ nickname: null, phone: null }, "我")).toBe("我");
    expect(personNameOf(null, "?")).toBe("?");
    expect(personNameOf(undefined, "?")).toBe("?");
  });

  it("cleanNickname：没有可显示的昵称时是空串（资料卡据此显示「设置昵称」）", () => {
    expect(cleanNickname("  ​ ")).toBe("");
    expect(cleanNickname(null)).toBe("");
    expect(cleanNickname(" 骑手 ")).toBe("骑手");
  });
});
