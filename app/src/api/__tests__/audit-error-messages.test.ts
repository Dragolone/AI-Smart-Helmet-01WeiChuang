// 审计 2026-09-13 §8：后端错误码 → App 文案覆盖率。
// API.md §1.1「客户端只依赖 code」；未映射的码走 error.unknown 回落（显示「未知错误（CODE）」），
// 不会露 key，但对用户无指导意义——本测试把当前缺口钉死，新增码时必须同步补文案。
import { describe, expect, it } from "@jest/globals";
import { isTransientFailure, toUserMessage } from "../error-messages";
import { ApiRequestError } from "../client";

/** 由 `grep -rhoE "code: '[A-Z_]+'" backend/src` 得到（2026-09-13，HEAD 2295eef） */
const BACKEND_CODES = [
  "BIND_CODE_INVALID",
  "CHANNEL_FULL",
  "DEVICE_ALREADY_BOUND",
  "DEVICE_NOT_FOUND",
  "EMERGENCY_CONTACT_LIMIT_REACHED",
  "MEDIA_NOT_READY",
  "NOT_FOUND",
  "PASSWORD_INCORRECT",
  "PHONE_ALREADY_REGISTERED",
  "PHONE_NOT_REGISTERED",
  "RATE_LIMITED",
  "SMS_CODE_DAILY_LIMIT",
  "SMS_CODE_INVALID",
  "SMS_CODE_TOO_FREQUENT",
  "SMS_SEND_FAILED",
  "SOS_ALREADY_FINALIZED",
  "TRTC_NOT_CONFIGURED",
  "UNAUTHORIZED",
  "VALIDATION_FAILED",
  // API.md §1.1 表内另有的通用码
  "FORBIDDEN",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
];

/** 当前已知缺口：这些码只会显示「未知错误（CODE）」。补上文案后请从本数组移除（测试会提示）。10-16 补了 CHANNEL_FULL 等 4 个。 */
const KNOWN_UNMAPPED = ["CONFLICT", "FORBIDDEN", "PAYLOAD_TOO_LARGE"].sort();

const msgFor = (code: string) =>
  toUserMessage(new ApiRequestError(400, { code, message: "x" }));

describe("后端错误码 → App 文案", () => {
  it("任何码都不会把 message key 或原始 code 当文案直接显示", () => {
    for (const code of BACKEND_CODES) {
      const m = msgFor(code);
      expect(m).not.toMatch(/^error\./);
      expect(m.length).toBeGreaterThan(1);
    }
  });

  it("未映射码清单与 KNOWN_UNMAPPED 一致（新增后端码必须同步补文案或更新本清单）", () => {
    const unknownText = msgFor("__NOT_A_REAL_CODE__");
    const unmapped = BACKEND_CODES.filter((c) => {
      const m = msgFor(c);
      // error.unknown 形如「未知错误（CODE）」：把 code 替换后与探针文案同形即视为未映射
      return m === unknownText.replace("__NOT_A_REAL_CODE__", c);
    }).sort();
    expect(unmapped).toEqual(KNOWN_UNMAPPED);
  });

  it("网络层失败（非 ApiRequestError）走网络文案而非未知错误", () => {
    const m = toUserMessage(new TypeError("Network request failed"));
    expect(m).not.toMatch(/未知|unknown/i);
    expect(m.length).toBeGreaterThan(1);
  });
});

// 绑定页「重新扫码」要不要认同一个码，看的就是这个：码本身没问题的失败才值得原样再来一次。
describe("失败是不是「原样再来一次可能就行」", () => {
  it("没连上服务器（断网、超时）：是", () => {
    expect(isTransientFailure(new TypeError("Network request failed"))).toBe(
      true,
    );
    const timeout = new Error("Aborted");
    timeout.name = "AbortError";
    expect(isTransientFailure(timeout)).toBe(true);
  });

  it("被限频、服务器自己出错：是", () => {
    expect(
      isTransientFailure(
        new ApiRequestError(429, { code: "RATE_LIMITED" }, 40),
      ),
    ).toBe(true);
    expect(
      isTransientFailure(new ApiRequestError(500, { code: "INTERNAL_ERROR" })),
    ).toBe(true);
    expect(isTransientFailure(new ApiRequestError(503, {}))).toBe(true);
  });

  it("服务端明确说不行（绑定码不对、已被绑定、设备不存在、登录失效）：不是", () => {
    expect(
      isTransientFailure(
        new ApiRequestError(400, { code: "BIND_CODE_INVALID" }),
      ),
    ).toBe(false);
    expect(
      isTransientFailure(
        new ApiRequestError(409, { code: "DEVICE_ALREADY_BOUND" }),
      ),
    ).toBe(false);
    expect(
      isTransientFailure(
        new ApiRequestError(404, { code: "DEVICE_NOT_FOUND" }),
      ),
    ).toBe(false);
    expect(
      isTransientFailure(new ApiRequestError(401, { code: "UNAUTHORIZED" })),
    ).toBe(false);
  });
});
