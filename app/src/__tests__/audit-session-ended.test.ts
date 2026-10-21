// 会话已被服务端否定（SessionEndedError）时只提示一次「登录已失效」：登录页顶部的说明（App 在后台时另有一条本地通知），
// 页面自己不再弹「XX 失败 · 登录已失效」、不再在错误横幅 / 表单下面写一遍（10-17 前端评审遗留：#231 只改了紧急联系人页）。
// 页面级的行为由各页测试覆盖；这里守住写法，免得新页面又直接把错误交给 showNotice。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, jest } from "@jest/globals";
import { Alert } from "react-native";

import {
  ApiRequestError,
  SessionCheckUnavailableError,
  SessionEndedError,
} from "@/api/client";
import { translate, useLocaleStore } from "@/i18n";
import { showFailure } from "@/services/notice";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** 取出 name( … ) 整段（按括号配对） */
function calls(code: string, name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = code.indexOf(`${name}(`, from);
    if (start < 0) return out;
    let i = start + name.length + 1;
    let depth = 1;
    while (depth > 0 && i < code.length) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") depth -= 1;
      i += 1;
    }
    out.push(code.slice(start, i));
    from = i;
  }
}

const rel = (file: string) => file.slice(SRC.length + 1);
const TO_TEXT = /\b(toUserMessage|changePhoneErrorMessage)\(/;

/**
 * 求救相关的失败照常提示，哪怕是会话已失效：登录页只说「重新登录前摔倒不会通知联系人」，
 * 不会告诉他刚才那条求救没发出去、倒计时没取消掉 / 没立即通知
 */
const SOS_EXCEPTIONS = (file: string, call: string) =>
  rel(file) === "app/sos-active.tsx" ||
  (rel(file) === "app/(tabs)/safety.tsx" &&
    call.includes('"safety.sosSendFailed"'));

/** 只发不带会话的请求（登录 / 注册 / 找回密码）：拿不到 SessionEndedError */
const NO_SESSION_PAGES = new Set([
  "app/(auth)/login.tsx",
  "app/(auth)/register.tsx",
  "app/(auth)/reset-password.tsx",
]);

describe("会话已失效时页面不再单独提示", () => {
  it("接口失败的提示框走 showFailure（会话已失效时不弹），不直接把错误文案交给 showNotice", () => {
    const bare = sources(SRC)
      // showFailure 自己就在这里
      .filter((file) => rel(file) !== "services/notice.ts")
      .flatMap((file) =>
        calls(readFileSync(file, "utf8"), "showNotice")
          .filter((call) => TO_TEXT.test(call))
          .filter((call) => !SOS_EXCEPTIONS(file, call))
          .map((call) => `${rel(file)}: ${call.replace(/\s+/g, " ")}`),
      );
    expect(bare).toEqual([]);
  });

  it("把接口错误转成文字的页面都认得会话已失效（isSessionEnded / showFailure）", () => {
    const unaware = sources(SRC)
      .filter((file) => !rel(file).startsWith("api/"))
      .filter((file) => !NO_SESSION_PAGES.has(rel(file)))
      .filter((file) => rel(file) !== "app/sos-active.tsx")
      .filter((file) => {
        const code = readFileSync(file, "utf8");
        return (
          TO_TEXT.test(code) && !/\b(isSessionEnded|showFailure)\b/.test(code)
        );
      })
      .map(rel);
    expect(unaware).toEqual([]);
  });

  it("showFailure：会话已失效时不弹；其余弹标题 + 按错误码的原因，调用方给了说明就用说明", () => {
    useLocaleStore.setState({ locale: "zh-CN" });
    const alert = jest
      .spyOn(Alert, "alert")
      .mockImplementation(() => undefined);
    const ok = [{ text: translate("common.confirm") }];
    showFailure("保存失败", new SessionEndedError());
    showFailure("保存失败", new SessionEndedError(), "别的说明");
    expect(alert).not.toHaveBeenCalled();
    showFailure(
      "保存失败",
      new ApiRequestError(400, { code: "VALIDATION_FAILED" }),
    );
    expect(alert).toHaveBeenLastCalledWith(
      "保存失败",
      translate("error.validationFailed"),
      ok,
    );
    // 暂时核对不了（刷新遇到 5xx / 断网）不是会话结束：照常说明
    showFailure("保存失败", new SessionCheckUnavailableError());
    expect(alert).toHaveBeenLastCalledWith(
      "保存失败",
      translate("error.sessionCheckFailed"),
      ok,
    );
    showFailure(
      "加入失败",
      new ApiRequestError(404, { code: "NOT_FOUND" }),
      "邀请码没找到",
    );
    expect(alert).toHaveBeenLastCalledWith("加入失败", "邀请码没找到", ok);
    alert.mockRestore();
  });
});
