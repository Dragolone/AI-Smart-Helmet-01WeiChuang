// 错误码 → 用户可读文案（API.md §1.1：客户端只依赖 code，不依赖 message）
// 只映射到文案 key，语言在调用时由 translate() 解析——模块级常量不得捕获 locale。
import { translate, type MessageKey } from "@/i18n";

import {
  ApiRequestError,
  SessionCheckUnavailableError,
  SessionEndedError,
} from "./client";

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
  NOT_FOUND: "error.notFound",
  BIND_CODE_INVALID: "error.bindCodeInvalid",
  DEVICE_ALREADY_BOUND: "error.deviceAlreadyBound",
  PASSWORD_INCORRECT: "error.passwordIncorrect",
  RATE_LIMITED: "error.rateLimited",
  SOS_ALREADY_FINALIZED: "error.sosAlreadyFinalized",
  // 注销账号时还有进行中的求救（O15，2026-10-22）；App 注销前已先拦，这是服务端兜底
  SOS_IN_PROGRESS: "error.sosInProgress",
  // 因账号已注销被拒的 401（O15）：另一台手机上的会话失效原因由会话层处理，这里只兜「按 code 显示」的场景
  ACCOUNT_DELETED: "error.accountDeleted",
  // 下面四个原来没映射，界面上直接露出「操作失败（CHANNEL_FULL）」（2026-10-16 模拟器实测满员频道）
  CHANNEL_FULL: "error.channelFull",
  EMERGENCY_CONTACT_LIMIT_REACHED: "error.contactLimitReached",
  MEDIA_NOT_READY: "error.mediaNotReady",
  TRTC_NOT_CONFIGURED: "error.trtcNotConfigured",
  // 10-22 服务端校验（上线清单 B 线 23）
  CHANNEL_LIMIT_REACHED: "error.channelLimitReached",
  CONTACT_IS_SELF: "error.contactIsSelf",
  CONTACT_DUPLICATE: "error.contactDuplicate",
  VOICE_TAKEN_OVER: "error.voiceTakenOver",
  INTERNAL_ERROR: "error.internal",
};

/** 文案里带上限值的几条：服务端没给 details.limit 时用的默认值（与服务端默认一致） */
const LIMIT_DEFAULTS: Record<string, number> = {
  "error.channelFull": 20,
  "error.channelLimitReached": 20,
  "error.contactLimitReached": 5,
};

/** 只认表里自己的键：code 恰好叫 constructor / toString / __proto__ 时，普通下标会取到 Object.prototype 上的东西 */
const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/**
 * 等多久换成人读得懂的单位：发码有「同 IP 每天 50 条」的日限，Retry-After 可达 86400，
 * 原样写成「请 86231 秒后再试」没人看得懂
 */
function rateLimitedMessage(seconds: number): string {
  if (seconds <= 90) return translate("error.rateLimitedRetry", { seconds });
  if (seconds <= 90 * 60) {
    return translate("error.rateLimitedRetryMinutes", {
      minutes: Math.ceil(seconds / 60),
    });
  }
  return translate("error.rateLimitedRetryHours", {
    hours: Math.ceil(seconds / 3600),
  });
}

export function toUserMessage(err: unknown): string {
  if (err instanceof SessionEndedError) return translate("error.sessionEnded");
  if (err instanceof SessionCheckUnavailableError)
    return translate("error.sessionCheckFailed");
  if (err instanceof ApiRequestError) {
    // 限频：服务端说了还要等几秒就照说（负责人 2026-10-07 iPhone 2.6 实测：只说「太频繁」用户不知道要等多久）
    if (err.code === "RATE_LIMITED" && err.retryAfterSec) {
      return rateLimitedMessage(err.retryAfterSec);
    }
    // 「手机号或密码不正确」只属于登录接口；带着会话的请求被 401 是登录状态没核对上
    if (err.code === "UNAUTHORIZED" && err.withSession)
      return translate("error.sessionCheckFailed");
    const key = own(MESSAGE_KEYS, err.code);
    if (!key) return translate("error.unknown", { code: err.code });
    // 上限类文案的数字以服务端 details.limit 为准（旧服务端没给时用默认值），不再写死
    const fallback = own(LIMIT_DEFAULTS, key);
    if (fallback !== undefined) {
      const given = err.details?.limit;
      return translate(key, {
        limit: typeof given === "number" ? given : fallback,
      });
    }
    return translate(key);
  }
  // 请求超时（client.ts 的 AbortController）：与断网区分，给用户可执行的提示
  if (err instanceof Error && err.name === "AbortError") {
    return translate("error.timeout");
  }
  // fetch 网络层失败（后端没起 / 无网络）
  return translate("error.network");
}

/**
 * 换手机号页的错误文案。新号已被别的账号注册时服务端回 PHONE_ALREADY_REGISTERED，通用文案是给注册页的
 * 「该手机号已注册，请直接登录」——用户此刻已经登录、在换号，「请直接登录」说不通（2026-10-16 模拟器）。
 * 其余错误同 toUserMessage。
 */
export function changePhoneErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError && err.code === "PHONE_ALREADY_REGISTERED")
    return translate("auth.phoneUsedByOther");
  return toUserMessage(err);
}

/** 会话已被服务端否定、界面正被送回登录页：这时不再弹失败提示（登录页顶部自有说明） */
export const isSessionEnded = (err: unknown): boolean =>
  err instanceof SessionEndedError;

/**
 * 这次失败是不是「原样再来一次可能就行」：没连上服务器（断网、超时）、被限频、服务器自己出错。
 * 服务端明确说不行的（绑定码不对、已被绑定……）不算——同样的请求再发多少次结果都一样。
 */
export function isTransientFailure(err: unknown): boolean {
  if (err instanceof SessionEndedError) return false;
  if (!(err instanceof ApiRequestError)) return true;
  return err.status === 429 || err.status >= 500;
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
