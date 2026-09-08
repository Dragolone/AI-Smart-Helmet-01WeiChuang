// 错误码 → 用户可读文案（API.md §1.1：客户端只依赖 code，不依赖 message）
import { ApiRequestError } from './client';

const MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: '输入格式不正确，请检查后重试',
  UNAUTHORIZED: '手机号或密码不正确',
  PHONE_ALREADY_REGISTERED: '该手机号已注册，请直接登录',
  PHONE_NOT_REGISTERED: '该手机号尚未注册',
  SMS_CODE_INVALID: '验证码错误或已失效，请重新获取',
  SMS_CODE_TOO_FREQUENT: '验证码发送太频繁，请稍后再试',
  SMS_CODE_DAILY_LIMIT: '今日验证码发送次数已达上限，请明天再试',
  SMS_SEND_FAILED: '短信发送失败，请稍后重试',
  DEVICE_NOT_FOUND: '设备不存在，请核对设备编号',
  BIND_CODE_INVALID: '绑定码不正确',
  DEVICE_ALREADY_BOUND: '该设备已被其他用户绑定',
  RATE_LIMITED: '操作太频繁，请稍后再试',
  INTERNAL_ERROR: '服务暂时不可用，请稍后再试',
};

export function toUserMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    return MESSAGES[err.code] ?? `操作失败（${err.code}）`;
  }
  // fetch 网络层失败（后端没起 / 无网络）
  return '网络连接失败，请检查网络后重试';
}
