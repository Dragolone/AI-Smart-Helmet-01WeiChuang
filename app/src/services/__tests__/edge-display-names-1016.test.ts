// 名字整理推广到对讲频道名、紧急联系人名、昵称（2026-10-16 第二轮边界测试）。
// 头盔名（cleanHelmetName）和别人的昵称（personNameOf）第一轮已整理；这里把同一套规则用到：
// 建频道 / 频道列表 / 房间标题 / 切换面板 / 小条 / 分享文案，联系人添加与分享，注册与编辑资料的昵称。
import { readFileSync } from "fs";
import { join } from "path";

import { afterEach, describe, expect, it } from "@jest/globals";

import { useLocaleStore, type Locale } from "@/i18n";

import { profilePatch } from "../profile-patch";
import { channelNameOf, cleanNickname, contactNameOf } from "../user-name";

const ZW = "​​​";
const RLO = "‮";
const read = (...p: string[]) =>
  readFileSync(join(__dirname, "..", "..", ...p), "utf8");

const prevLocale = useLocaleStore.getState().locale;
const withLocale = (l: Locale) => useLocaleStore.setState({ locale: l });
afterEach(() => useLocaleStore.setState({ locale: prevLocale }));

describe("channelNameOf：对讲频道显示名", () => {
  it("正常名字原样；首尾空白去掉", () => {
    expect(channelNameOf("周末骑行队")).toBe("周末骑行队");
    expect(channelNameOf("  周末骑行队 ")).toBe("周末骑行队");
  });

  it("只含零宽字符 / 方向控制符 / 全角空格：回退「未命名频道」，不留一片空白", () => {
    withLocale("zh-CN");
    for (const raw of [ZW, RLO, "　　", "﻿", " ​ ‌ "])
      expect(channelNameOf(raw)).toBe("未命名频道");
  });

  it("回退文案跟当前语言：繁体「未命名頻道」、英文「Untitled channel」", () => {
    withLocale("zh-TW");
    expect(channelNameOf(ZW)).toBe("未命名頻道");
    withLocale("en");
    expect(channelNameOf(ZW)).toBe("Untitled channel");
  });

  it("带换行 / 制表：压成一行（列表单行显示原来只剩第一行）", () => {
    expect(channelNameOf("周末\n骑行队")).toBe("周末 骑行队");
    expect(channelNameOf("周末\t\t骑行队\r\n")).toBe("周末 骑行队");
  });

  it("表情组合不拆：👨‍👩‍👧 车队、❤️", () => {
    expect(channelNameOf("👨‍👩‍👧 车队")).toBe("👨‍👩‍👧 车队");
    expect(channelNameOf("❤️骑行")).toBe("❤️骑行");
  });

  it("夹在中间的零宽字符去掉，可见的字不动", () => {
    expect(channelNameOf("周​末")).toBe("周末");
  });

  it("空串 / null / undefined：回退", () => {
    withLocale("zh-CN");
    expect(channelNameOf("")).toBe("未命名频道");
    expect(channelNameOf(null)).toBe("未命名频道");
    expect(channelNameOf(undefined)).toBe("未命名频道");
  });

  it("名字恰好就叫「未命名频道」时照常显示（不和回退混淆也无妨，显示一致）", () => {
    expect(channelNameOf("未命名频道")).toBe("未命名频道");
  });
});

describe("contactNameOf：紧急联系人显示名", () => {
  it("有名字用名字", () => {
    expect(contactNameOf({ name: "妈妈", phone: "13800001234" })).toBe("妈妈");
  });

  it("名字只含零宽 / 空白：写号码", () => {
    expect(contactNameOf({ name: ZW, phone: "13800001234" })).toBe(
      "13800001234",
    );
    expect(contactNameOf({ name: "   ", phone: "13800001234" })).toBe(
      "13800001234",
    );
  });

  it("名字带换行：压成一行", () => {
    expect(contactNameOf({ name: "妈\n妈", phone: "1" })).toBe("妈 妈");
  });

  it("名字、号码都没有：空串（调用方不会出现 undefined / null 字样）", () => {
    expect(contactNameOf({ name: null, phone: null })).toBe("");
    expect(contactNameOf({})).toBe("");
  });
});

describe("profilePatch：昵称按显示规则整理后再比、再发", () => {
  const user = { nickname: "骑手", avatarUrl: null };

  it("草稿只含零宽字符：当成清空昵称，发空串（原来把零宽字符原样发上去）", () => {
    expect(profilePatch(user, ZW, null)).toEqual({ nickname: "" });
  });

  it("草稿带换行：发压成一行的名字", () => {
    expect(profilePatch(user, "新\n名字", null)).toEqual({
      nickname: "新 名字",
    });
  });

  it("本机存的昵称带换行、弹层预填的是整理后的样子：没动过就不发（不把别的手机上的修改覆盖掉）", () => {
    const stored = { nickname: "骑手\n二号", avatarUrl: null };
    expect(profilePatch(stored, cleanNickname(stored.nickname), null)).toBe(
      null,
    );
  });

  it("本机存的昵称只含零宽字符、弹层预填空串：没动过就不发", () => {
    const stored = { nickname: ZW, avatarUrl: null };
    expect(profilePatch(stored, "", null)).toBeNull();
  });

  it("中间夹零宽字符的「骑​手」和「骑手」显示一样，不算改动", () => {
    expect(profilePatch(user, "骑​手", null)).toBeNull();
  });
});

describe("页面接线不变式", () => {
  it("对讲页：频道名显示全部走 channelNameOf，不再直接渲染 c.name / channel?.name", () => {
    const src = read("app", "(tabs)", "intercom.tsx");
    expect(src).not.toMatch(/\{c\.name\}/);
    expect(src).not.toMatch(/channel\?\.name/);
    expect(src).not.toMatch(/name: c\.name\b/);
    expect(src).not.toMatch(/name: channel\.name\b/);
    expect(src).toMatch(
      /sessionName = channel \? channelNameOf\(channel\.name\)/,
    );
  });

  it("对讲页：建频道提交整理后的名字，整理后为空时按钮灰着、不提交", () => {
    const src = read("app", "(tabs)", "intercom.tsx");
    expect(src).toContain("const createName = cleanNickname(nameDraft)");
    expect(src).toContain(".create({ name: createName })");
    expect(src).toContain("disabled={!createName}");
    expect(src).not.toContain("nameDraft.trim()");
  });

  it("添加联系人：名字和关系提交前整理；名字整理后为空按「必填」处理", () => {
    const src = read("app", "add-contact.tsx");
    expect(src).toContain("const cleanName = cleanNickname(name)");
    expect(src).toContain("const cleanRelation = cleanNickname(relation)");
    expect(src).toContain("if (!cleanName || !phone.trim())");
    expect(src).not.toContain("name: name.trim()");
  });

  it("联系人页：列表、删除确认、「告诉 TA」分享都用 contactNameOf；关系也整理", () => {
    const src = read("app", "contacts.tsx");
    expect(src).toContain("name: contactNameOf(contact)");
    expect(src).toContain(
      'translate("contacts.deleteBody", { name: contactNameOf(c) })',
    );
    expect(src).toContain("cleanNickname(contact.relation)");
    expect(src).not.toMatch(/name: (contact|c)\.name\b/);
  });

  it("注册页：昵称提交前整理", () => {
    const src = read("app", "(auth)", "register.tsx");
    expect(src).toContain("nickname: cleanNickname(nickname)");
    expect(src).not.toContain("nickname.trim()");
  });
});
