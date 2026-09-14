// 错误码 → 用户可读文案（API.md §1.1：客户端只依赖 code，不依赖 message）
// 只映射到文案 key，语言在调用时由 translate() 解析——模块级常量不得捕获 locale。
import { translate, type MessageKey } from "@/i18n";

import { ApiRequestError } from "./client";

const MESSAGE_KEYS: Record<string, MessageKey> = {
  VALIDATION_FAILED: "error.validationFailed",
  UNAUTHORIZED: "error.unauthorized",
  PHONE_ALREADY_REGISTERED: "error.phoneAlreadyRegistered",
  PHONE_NOT_REGISTERED: "error.phoneNotRegistered",
  SMS_CODE_INVALID: "error.smsCodeInvalid",
  SMS_CODE_TOO_FREQUENT: "error.smsCodeTooFrequent",
  SMS_CODE_DAILY_LIMIT: "error.smsCodeDailyLimit",
  SMS_SEND_FAILED: "error.smsSendFailed",
  DEVICE_NOT_FOUND: "error.deviceNotFound",
  BIND_CODE_INVALID: "error.bindCodeInvalid",
  DEVICE_ALREADY_BOUND: "error.deviceAlreadyBound",
  PASSWORD_INCORRECT: "error.passwordIncorrect",
  RATE_LIMITED: "error.rateLimited",
  INTERNAL_ERROR: "error.internal",
};

export function toUserMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const key = MESSAGE_KEYS[err.code];
    return key
      ? translate(key)
      : translate("error.unknown", { code: err.code });
  }
  // 请求超时（client.ts 的 AbortController）：与断网区分，给用户可执行的提示
  if (err instanceof Error && err.name === "AbortError") {
    return translate("error.timeout");
  }
  // fetch 网络层失败（后端没起 / 无网络）
  return translate("error.network");
}
