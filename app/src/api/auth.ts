// Auth / 用户接口（docs/API.md §2；backend/src/auth、users 已实现并核对）
import type {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
  SmsCodeRequest,
  UpdateMeRequest,
  UserProfile,
} from '@helmet/shared';
import { api } from './client';

export const authApi = {
  /** 下发短信验证码（注册 / 找回密码）；60s 内重发 429 SMS_CODE_TOO_FREQUENT */
  sendSmsCode: (body: SmsCodeRequest) =>
    api<void>('/auth/sms-code', { method: 'POST', body, auth: false }),

  register: (body: RegisterRequest) =>
    api<AuthResponse>('/auth/register', { method: 'POST', body, auth: false }),

  login: (body: LoginRequest) =>
    api<AuthResponse>('/auth/login', { method: 'POST', body, auth: false }),

  /** 找回密码：成功后服务端撤销该用户全部会话，需重新登录 */
  resetPassword: (body: ResetPasswordRequest) =>
    api<void>('/auth/reset-password', { method: 'POST', body, auth: false }),

  /** 服务端作废该 refreshToken；本地清理由 auth-store 负责 */
  logout: (refreshToken: string) =>
    api<void>('/auth/logout', {
      method: 'POST',
      body: { refreshToken },
      auth: false,
    }),

  me: () => api<UserProfile>('/users/me'),

  updateMe: (body: UpdateMeRequest) =>
    api<UserProfile>('/users/me', { method: 'PATCH', body }),
};
