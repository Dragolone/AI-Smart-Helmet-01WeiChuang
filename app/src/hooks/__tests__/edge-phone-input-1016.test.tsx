// 注册 / 登录 / 找回密码 / 换手机号四页的手机号规范化（2026-10-16 第二轮边界测试）。
// 联系人页第一轮已用 normalizePhone；这四页原来只 trim()，输入框还卡 11 位：
// 系统自动填充本机号码（「+86 138 0000 0000」）、从通讯录 / 聊天粘贴、中文输入法全角数字都会被判成格式不对或被截断。
import { readFileSync } from "fs";
import { join } from "path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { authApi } from "@/api/auth";
import { ApiRequestError } from "@/api/client";
import { changePhoneErrorMessage, toUserMessage } from "@/api/error-messages";
import { useLocaleStore, type Locale } from "@/i18n";

import {
  PHONE_INPUT_MAX,
  isValidPhone,
  normalizePhone,
  normalizeSmsCode,
  __resetSmsCooldownsForTests,
  useSmsCode,
} from "../use-sms-code";

// 仓库里有两份 React（app/node_modules 与根目录）；让 App 源码里的 hook 和 react-test-renderer 用同一份
jest.mock("react", () => jest.requireActual("../../../../node_modules/react"));
jest.mock("@/api/auth", () => ({
  authApi: { sendSmsCode: jest.fn(async () => undefined) },
}));
type AnyMock = jest.Mock<(...args: any[]) => any>;
const sendMock = authApi.sendSmsCode as unknown as AnyMock;

const read = (...p: string[]) =>
  readFileSync(join(__dirname, "..", "..", ...p), "utf8");
const PAGES = {
  login: read("app", "(auth)", "login.tsx"),
  register: read("app", "(auth)", "register.tsx"),
  reset: read("app", "(auth)", "reset-password.tsx"),
  changePhone: read("app", "account", "change-phone.tsx"),
  addContact: read("app", "add-contact.tsx"),
};

describe("PHONE_INPUT_MAX：输入框留得下带前缀 / 分隔符的号码", () => {
  it("「+86 138 0000 0000」「0086-138-0000-0000」「(+86) 138 0000 0000」都放得下", () => {
    for (const raw of [
      "+86 138 0000 0000",
      "0086-138-0000-0000",
      "(+86) 138 0000 0000",
    ]) {
      expect(raw.length).toBeLessThanOrEqual(PHONE_INPUT_MAX);
      expect(isValidPhone(normalizePhone(raw))).toBe(true);
    }
  });

  it("原来卡 11 位时自动填充的号码被截成「+86 138 000」，规整后也不合法——这就是要放宽的原因", () => {
    const truncated = "+86 138 0000 0000".slice(0, 11);
    expect(truncated).toBe("+86 138 000");
    expect(isValidPhone(normalizePhone(truncated))).toBe(false);
  });

  it("四页 + 联系人页的手机号输入框都用 PHONE_INPUT_MAX，不再有 maxLength={11}", () => {
    for (const [name, src] of Object.entries(PAGES)) {
      expect({
        name,
        max: src.includes("maxLength={PHONE_INPUT_MAX}"),
      }).toEqual({ name, max: true });
      expect({ name, eleven: src.includes("maxLength={11}") }).toEqual({
        name,
        eleven: false,
      });
    }
  });
});

describe("四页提交前都过 normalizePhone", () => {
  it("登录：提交和记住的号码都是规整后的", () => {
    expect(PAGES.login).toContain("const cleanPhone = normalizePhone(phone)");
    expect(PAGES.login).toContain(
      "authApi.login({ phone: cleanPhone, password })",
    );
    expect(PAGES.login).toMatch(
      /setItemAsync\(SECURE_KEYS\.lastLoginPhone, cleanPhone\)/,
    );
  });

  it("注册 / 找回密码：发验证码前按规整后的号码校验、发送；提交也用规整后的", () => {
    for (const src of [PAGES.register, PAGES.reset]) {
      expect(src).toContain("const cleanPhone = normalizePhone(phone)");
      expect(src).toContain("isValidPhone(cleanPhone)");
      expect(src).toContain("sms.send(cleanPhone)");
      expect(src).toContain("phone: normalizePhone(phone)");
    }
  });

  it("换手机号：校验、发验证码、提交、和当前号码比较都用规整后的", () => {
    const src = PAGES.changePhone;
    expect(src).toContain("const cleanPhone = normalizePhone(phone)");
    expect(src).toContain("isValidPhone(cleanPhone)");
    expect(src).toMatch(/cleanPhone === normalizePhone\(user\?\.phone/);
    expect(src).toContain("sms.send(cleanPhone)");
    expect(src).toContain("newPhone: cleanPhone");
  });

  it("四页都不再把 phone.trim() 原样交给接口", () => {
    for (const src of [
      PAGES.login,
      PAGES.register,
      PAGES.reset,
      PAGES.changePhone,
    ])
      expect(src).not.toContain("phone.trim()");
  });

  it("「+86 139 0000 0042」和「13900000042」是同一个号：换号页不会把它当成新号放过去", () => {
    expect(normalizePhone("+86 139 0000 0042")).toBe(
      normalizePhone("13900000042"),
    );
  });
});

describe("normalizeSmsCode：验证码规整成半角数字", () => {
  it("全角数字（中文输入法全角状态）换成半角", () => {
    expect(normalizeSmsCode("１２３４５６")).toBe("123456");
  });

  it("短信里复制带的空格 / 横线 / 零宽字符去掉", () => {
    expect(normalizeSmsCode("123 456")).toBe("123456");
    expect(normalizeSmsCode("123-456")).toBe("123456");
    expect(normalizeSmsCode("​123456﻿")).toBe("123456");
  });

  it("字母、多出来的位数不动（照样判格式不对，由页面提示）", () => {
    expect(normalizeSmsCode("12a456")).toBe("12a456");
    expect(normalizeSmsCode("1234567")).toBe("1234567");
    expect(normalizeSmsCode("")).toBe("");
  });

  it("三个带验证码的页面提交前都规整", () => {
    for (const src of [PAGES.register, PAGES.reset, PAGES.changePhone]) {
      expect(src).toContain("const cleanCode = normalizeSmsCode(code)");
      expect(src).toContain("code: cleanCode");
    }
  });
});

describe("useSmsCode.send：发出去的一定是 11 位纯数字", () => {
  const renderers: ReactTestRenderer[] = [];
  beforeEach(() => {
    sendMock.mockClear();
    __resetSmsCooldownsForTests();
  });
  afterEach(() => {
    act(() => renderers.splice(0).forEach((r) => r.unmount()));
  });

  async function mount() {
    const box = {} as { current: ReturnType<typeof useSmsCode> };
    function Probe() {
      box.current = useSmsCode("register", "");
      return null;
    }
    await act(async () => {
      renderers.push(create(<Probe />));
    });
    return box;
  }

  it("页面传来带 +86 / 空格的号码也规整后再发（幂等）", async () => {
    const sms = await mount();
    await act(async () => {
      await sms.current.send("+86 138-0000-1234");
    });
    expect(sendMock).toHaveBeenCalledWith({
      phone: "13800001234",
      purpose: "register",
    });
  });

  it("已经规整过的号码原样发", async () => {
    const sms = await mount();
    await act(async () => {
      await sms.current.send("13800001234");
    });
    expect(sendMock).toHaveBeenCalledWith({
      phone: "13800001234",
      purpose: "register",
    });
  });
});

describe("换手机号页：新号已被别的账号注册时的文案", () => {
  const prev = useLocaleStore.getState().locale;
  const withLocale = (l: Locale) => useLocaleStore.setState({ locale: l });
  afterEach(() => useLocaleStore.setState({ locale: prev }));
  const taken = new ApiRequestError(409, { code: "PHONE_ALREADY_REGISTERED" });

  it("不说「请直接登录」（用户已经登录在换号），说这个号被其他账号用了——三种语言", () => {
    withLocale("zh-CN");
    expect(changePhoneErrorMessage(taken)).toBe(
      "这个手机号已被其他账号使用，请换一个号码",
    );
    expect(changePhoneErrorMessage(taken)).not.toContain("登录");
    withLocale("zh-TW");
    expect(changePhoneErrorMessage(taken)).toBe(
      "這個手機號碼已被其他帳號使用，請換一個號碼",
    );
    withLocale("en");
    expect(changePhoneErrorMessage(taken)).toBe(
      "This number is already used by another account. Please use a different number.",
    );
  });

  it("注册页那条通用文案保持原样（「请直接登录」在注册页是对的）", () => {
    withLocale("zh-CN");
    expect(toUserMessage(taken)).toBe("该手机号已注册，请直接登录");
  });

  it("其余错误与 toUserMessage 相同：验证码错、限频、断网", () => {
    withLocale("zh-CN");
    const cases: unknown[] = [
      new ApiRequestError(400, { code: "SMS_CODE_INVALID" }),
      new ApiRequestError(429, { code: "RATE_LIMITED" }, 30),
      new TypeError("Network request failed"),
    ];
    for (const e of cases)
      expect(changePhoneErrorMessage(e)).toBe(toUserMessage(e));
  });

  it("接线：换号页两处错误都走 changePhoneErrorMessage；注册页仍走通用的 toUserMessage", () => {
    expect(
      PAGES.changePhone.match(/form\.fail\(changePhoneErrorMessage\(e\)\)/g),
    ).toHaveLength(2);
    expect(PAGES.changePhone).not.toContain("toUserMessage");
    expect(PAGES.register).toContain("toUserMessage(e)");
    expect(PAGES.register).not.toContain("changePhoneErrorMessage");
  });
});
