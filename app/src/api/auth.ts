// Auth / 用户接口（docs/API.md §2；backend/src/auth、users 已实现并核对）
import type {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
  UpdateMeRequest,
  UserProfile,
} from '@helmet/shared';
import { api } from './client';

export const authApi = {
  register: (body: RegisterRequest) =>
    api<AuthResponse>('/auth/register', { method: 'POST', body, auth: false }),

  login: (body: LoginRequest) =>
    api<AuthResponse>('/auth/login', { method: 'POST', body, auth: false }),

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
