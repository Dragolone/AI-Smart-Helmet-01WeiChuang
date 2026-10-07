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
  SOS_ALREADY_FINALIZED: "error.sosAlreadyFinalized",
  INTERNAL_ERROR: "error.internal",
};

/** 只认表里自己的键：code 恰好叫 constructor / toString / __proto__ 时，普通下标会取到 Object.prototype 上的东西 */
const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

export function toUserMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    // 限频：服务端说了还要等几秒就照说（负责人 2026-10-07 iPhone 2.6 实测：只说「太频繁」用户不知道要等多久）
    if (err.code === "RATE_LIMITED" && err.retryAfterSec) {
      return translate("error.rateLimitedRetry", {
        seconds: err.retryAfterSec,
      });
    }
    const key = own(MESSAGE_KEYS, err.code);
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

/**
 * 头盔回执错误码 → 用户看得懂的一句话（BLE v0.6 §3.0，清单见 shared HELMET_ERROR_CODES）。
 * 回执里的码形如 `ERR_PARAM_VALUE:volume`（冒号后是设置键）——用户不该读到这种东西，
 * 但技术支持需要，所以正文说人话、原始码留在括号里。
 */
export function helmetErrorText(
  code: string,
  t: (key: MessageKey) => string,
): string {
  const [name] = code.split(":");
  const key = own(HELMET_ERROR_TEXT, name);
  return key ? t(key) : code;
}

const HELMET_ERROR_TEXT: Record<string, MessageKey | undefined> = {
  ERR_LENGTH: "device.err.protocol",
  ERR_INSTRUCTION: "device.err.protocol",
  ERR_ADDR_RANGE: "device.err.unsupported",
  UNSUPPORTED_SETTING: "device.err.unsupported",
  ERR_EPROM_LOCKED: "device.err.locked",
  ERR_PARAM_VALUE: "device.err.paramValue",
  ERR_BATTERY_LOW: "device.err.batteryLow",
  ERR_HARDWARE_FAULT: "device.err.hardware",
};
