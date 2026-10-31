// Auth / 用户接口（docs/API.md §2；backend/src/auth、users 已实现并核对）
// 请求 / 响应类型都来自 packages/shared（账号安全三接口：改密 / 换手机号 / 注销，以及 change_phone 用途也已同步），
// 这里不再自己定型。
import type {
  AuthResponse,
  ChangePasswordRequest,
  ChangePhoneRequest,
  DeleteAccountRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  SmsCodeRequest,
  UpdateMeRequest,
  UserProfile,
} from "@helmet/shared";
import { api, currentRefreshToken } from "./client";

/** 带上本机 refreshToken：服务端撤销其他会话时保留本机登录态。shared 里它是选填，这里发出去的一定带 */
type ChangePasswordBody = ChangePasswordRequest &
  Required<Pick<ChangePasswordRequest, "refreshToken">>;

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

  /**
   * 修改密码（已登录）：旧密码错 → 400 PASSWORD_INCORRECT。
   * refreshToken 在每次发请求时现取（服务端凭它「保留本机、撤销其余」）：提交那一刻 access token
   * 若刚好过期，请求先 401 → 静默刷新把 refresh token 轮换掉 → 重试。重试带的要是新的那把，
   * 否则服务端保留的是已作废的旧 token、把新的撤销——页面提示修改成功，15 分钟内本机被静默登出。
   */
  changePassword: (body: Omit<ChangePasswordRequest, "refreshToken">) =>
    api<void>("/auth/change-password", {
      method: "POST",
      body: (): ChangePasswordBody => ({
        ...body,
        refreshToken: currentRefreshToken(),
      }),
    }),

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
