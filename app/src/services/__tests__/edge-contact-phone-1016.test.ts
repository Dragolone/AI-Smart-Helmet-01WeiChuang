// 添加紧急联系人时的两条号码检查（2026-10-16 第二轮边界测试）。
// 服务端只限 5 个（EMERGENCY_CONTACT_LIMIT_REACHED），不查重复、不拦本人号码：
// - 同一个号码加两次：求救时这个人收两条短信，还白占一个名额；
// - 填自己的号码：求救短信发到摔倒的人自己手机上，等于没人收到，而安全页照样显示「已设置联系人」。
import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "@jest/globals";

import { contactPhoneProblem } from "../contact-phone";

const existing = [{ phone: "13800001111" }, { phone: "13900002222" }];

describe("contactPhoneProblem", () => {
  it("新号码：没问题", () => {
    expect(contactPhoneProblem("13700003333", existing, "13600004444")).toBe(
      null,
    );
  });

  it("已经是联系人的号码：duplicate", () => {
    expect(contactPhoneProblem("13800001111", existing, null)).toBe(
      "duplicate",
    );
  });

  it("写法不同的同一个号也算重复：+86、空格、横线、全角", () => {
    for (const raw of [
      "+86 138 0000 1111",
      "138-0000-1111",
      "１３８００００１１１１",
    ])
      expect(contactPhoneProblem(raw, existing, null)).toBe("duplicate");
  });

  it("已有联系人存的是带前缀的写法（老数据）也认得出", () => {
    expect(
      contactPhoneProblem("13800001111", [{ phone: "+8613800001111" }], null),
    ).toBe("duplicate");
  });

  it("本人号码：self；本人号码带 +86 也认得出", () => {
    expect(contactPhoneProblem("13600004444", existing, "13600004444")).toBe(
      "self",
    );
    expect(
      contactPhoneProblem("+86 136 0000 4444", existing, "13600004444"),
    ).toBe("self");
  });

  it("既是本人又已在列表里：先报重复（重复是硬拦，本人号码只是提醒）", () => {
    expect(
      contactPhoneProblem(
        "13600004444",
        [{ phone: "13600004444" }],
        "13600004444",
      ),
    ).toBe("duplicate");
  });

  it("本机还没有自己的号码（档案没回来）/ 联系人列表没缓存：不误判", () => {
    expect(contactPhoneProblem("13600004444", [], undefined)).toBe(null);
    expect(contactPhoneProblem("13600004444", [], "")).toBe(null);
  });
});

describe("添加联系人页接线", () => {
  const src = readFileSync(
    join(__dirname, "..", "..", "app", "add-contact.tsx"),
    "utf8",
  );

  it("提交前查重复（就地报错）和本人号码（确认框，可仍然添加）", () => {
    expect(src).toContain("contactPhoneProblem(");
    expect(src).toContain(
      'queryClient.getQueryData<EmergencyContact[]>(["contacts"])',
    );
    expect(src).toContain(
      'return { key: "duplicate", message: t("contacts.duplicatePhone") }',
    );
    expect(src).toContain('t("contacts.selfPhoneTitle")');
    expect(src).toContain('text: t("contacts.selfPhoneConfirm")');
  });
});
