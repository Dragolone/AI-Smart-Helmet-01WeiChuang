// 中转 / 手动求救失败时这个错误再试有没有用：补发队列按它丢弃，页面按它决定说「已暂存」还是「没有发出」（10-17）
import { describe, expect, it } from "@jest/globals";

import { ApiRequestError } from "@/api/client";
import { isHelmetGoneError, isUnrecoverableRelayError } from "../relay-errors";

describe("isUnrecoverableRelayError", () => {
  it("服务端说的 404 头盔不在这个账号下 / 403 无权 / 400 坏体：再试也是同一个结果", () => {
    for (const [status, code] of [
      [404, "DEVICE_NOT_FOUND"],
      [403, "FORBIDDEN"],
      [400, "VALIDATION_FAILED"],
    ] as const)
      expect(
        isUnrecoverableRelayError(new ApiRequestError(status, { code })),
      ).toBe(true);
  });

  it("10-25 审查：网关 / 运营商回的 404 / 403 / 400 错误页（没有 JSON → 码是 INTERNAL_ERROR）、路由不存在的 NOT_FOUND：不丢积压，留着重发", () => {
    for (const status of [404, 403, 400])
      expect(isUnrecoverableRelayError(new ApiRequestError(status, {}))).toBe(
        false,
      );
    expect(
      isUnrecoverableRelayError(
        new ApiRequestError(404, { code: "NOT_FOUND" }),
      ),
    ).toBe(false);
    expect(
      isUnrecoverableRelayError(
        new ApiRequestError(403, { code: "BIND_CODE_INVALID" }),
      ),
    ).toBe(false);
  });

  it("断网、超时、服务端出错、会话过期：值得暂存重发", () => {
    expect(
      isUnrecoverableRelayError(new TypeError("Network request failed")),
    ).toBe(false);
    for (const status of [401, 409, 429, 500, 503])
      expect(
        isUnrecoverableRelayError(
          new ApiRequestError(status, { code: "INTERNAL_ERROR" }),
        ),
      ).toBe(false);
    expect(isUnrecoverableRelayError(undefined)).toBe(false);
    expect(isUnrecoverableRelayError(null)).toBe(false);
  });
});

describe("isHelmetGoneError", () => {
  it("只有 404（头盔不在这个账号下）算；403 / 400 / 断网 / 空值都不算", () => {
    expect(
      isHelmetGoneError(new ApiRequestError(404, { code: "DEVICE_NOT_FOUND" })),
    ).toBe(true);
    for (const status of [403, 400, 500])
      expect(
        isHelmetGoneError(new ApiRequestError(status, { code: "FORBIDDEN" })),
      ).toBe(false);
    expect(isHelmetGoneError(new TypeError("Network request failed"))).toBe(
      false,
    );
    expect(isHelmetGoneError(undefined)).toBe(false);
  });
});
