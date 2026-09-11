// Auth / 用户接口（docs/API.md §2；backend/src/auth、users 已实现并核对）
// 账号安全三接口（改密 / 换手机号 / 注销）与 change_phone 用途的后端契约在另一分支并行实现，
// 请求体先在本地定型，待 packages/shared 同步后再切回共享类型。
import type {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  UpdateMeRequest,
  UserProfile,
} from "@helmet/shared";
import { api } from "./client";

export type SmsCodePurpose = "register" | "reset_password" | "change_phone";

/** change_phone 时 phone 为「新手机号」；已被占用 → 409 PHONE_ALREADY_REGISTERED */
export interface SmsCodeRequest {
  phone: string;
  purpose: SmsCodePurpose;
}

/** 带上本机 refreshToken：服务端撤销其他会话时保留本机登录态 */
export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
  refreshToken: string;
}

export interface ChangePhoneRequest {
  newPhone: string;
  code: string;
}

export interface DeleteAccountRequest {
  password: string;
}

/** 手机号脱敏展示：138****1234；非 11 位原样返回 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  return phone.length === 11
    ? `${phone.slice(0, 3)}****${phone.slice(7)}`
    : phone;
}

export const authApi = {
  /** 下发短信验证码（注册 / 找回密码 / 更换手机号）；60s 内重发 429 SMS_CODE_TOO_FREQUENT */
  sendSmsCode: (body: SmsCodeRequest) =>
    api<void>("/auth/sms-code", { method: "POST", body, auth: false }),

  register: (body: RegisterRequest) =>
    api<AuthResponse>("/auth/register", { method: "POST", body, auth: false }),

  login: (body: LoginRequest) =>
    api<AuthResponse>("/auth/login", { method: "POST", body, auth: false }),

  /** 找回密码：成功后服务端撤销该用户全部会话，需重新登录 */
  resetPassword: (body: ResetPasswordRequest) =>
    api<void>("/auth/reset-password", { method: "POST", body, auth: false }),

  /** 修改密码（已登录）：旧密码错 → 400 PASSWORD_INCORRECT */
  changePassword: (body: ChangePasswordRequest) =>
    api<void>("/auth/change-password", { method: "POST", body }),

  /** 更换手机号（已登录）：返回更新后的用户档案；409 PHONE_ALREADY_REGISTERED / 400 SMS_CODE_INVALID */
  changePhone: (body: ChangePhoneRequest) =>
    api<UserProfile>("/auth/change-phone", { method: "POST", body }),

  /** 注销账号（已登录）：密码错 → 400 PASSWORD_INCORRECT；成功后本地直接清会话，不再调 logout */
  deleteMe: (body: DeleteAccountRequest) =>
    api<void>("/users/me", { method: "DELETE", body }),

  /** 服务端作废该 refreshToken；本地清理由 auth-store 负责 */
  logout: (refreshToken: string) =>
    api<void>("/auth/logout", {
      method: "POST",
      body: { refreshToken },
      auth: false,
    }),

  me: () => api<UserProfile>("/users/me"),

  updateMe: (body: UpdateMeRequest) =>
    api<UserProfile>("/users/me", { method: "PATCH", body }),
};
