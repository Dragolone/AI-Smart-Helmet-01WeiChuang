// 输入框长度上限和服务端校验对齐（2026-10-16 第二轮边界测试）。
// 上限比服务端严没关系（只会少输几个字）；但同一个字段在两处上限不同时，长的那处存进去的值
// 到短的那处预填会被 Android 的长度过滤截断，改一个字再保存就丢字。
import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "@jest/globals";

const read = (...p: string[]) =>
  readFileSync(join(__dirname, "..", ...p), "utf8");
const backend = (...p: string[]) =>
  readFileSync(
    join(__dirname, "..", "..", "..", "backend", "src", ...p),
    "utf8",
  );

/** 某个 FormInput 的 maxLength（按 label 找到那一段） */
function maxLengthAfter(src: string, labelKey: string): number | null {
  const at = src.indexOf(`t("${labelKey}")`);
  if (at < 0) return null;
  const m = /maxLength=\{(\d+)\}/.exec(src.slice(at, at + 600));
  return m ? Number(m[1]) : null;
}

describe("昵称：注册页和编辑资料一致，都等于服务端上限", () => {
  it("服务端注册和改资料都是 30", () => {
    expect(backend("auth", "auth.dto.ts")).toMatch(
      /@MaxLength\(30\)\s*nickname\?: string/,
    );
    expect(backend("users", "users.controller.ts")).toMatch(
      /@MaxLength\(30\)\s*nickname\?: string/,
    );
  });

  it("注册页 30、编辑资料 30（10-16 第二轮改：编辑资料原来是 20）", () => {
    expect(
      maxLengthAfter(read("app", "(auth)", "register.tsx"), "auth.nickname"),
    ).toBe(30);
    expect(
      maxLengthAfter(read("app", "(tabs)", "profile.tsx"), "profile.nickname"),
    ).toBe(30);
  });
});

describe("其余几处不比服务端宽", () => {
  it("建频道名 ≤ 30（服务端 CreateChannelDto 30）", () => {
    expect(backend("voice", "voice.controller.ts")).toMatch(
      /@MaxLength\(30\)\s*name!: string/,
    );
    expect(
      maxLengthAfter(
        read("app", "(tabs)", "intercom.tsx"),
        "intercom.channelName",
      ),
    ).toBeLessThanOrEqual(30);
  });

  it("联系人名 ≤ 30、关系 ≤ 20（服务端 CreateContactDto）", () => {
    const src = read("app", "add-contact.tsx");
    expect(maxLengthAfter(src, "contacts.name")).toBeLessThanOrEqual(30);
    expect(maxLengthAfter(src, "contacts.relation")).toBeLessThanOrEqual(20);
  });
});
