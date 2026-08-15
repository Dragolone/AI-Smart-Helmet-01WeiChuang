// REST API Contract（docs/API.md 已实现部分落型）。全部为线上格式：
// 时间字段一律 ISO 8601 UTC 字符串（后端内部用 Date，由序列化层转换）。

// —— §1 通用约定 ——

/** 统一错误格式；客户端只依赖 code 不依赖 message，错误码只增不改 */
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId: string;
}

/** 统一分页响应（pageSize 默认 20，最大 100） */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// —— §2 认证与用户（已实现） ——

export interface RegisterRequest {
  phone: string;
  password: string;
  nickname?: string;
}

export interface LoginRequest {
  phone: string;
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

/** user 对象；密码任何接口不回传 */
export interface UserProfile {
  id: string;
  phone: string;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

/** access 15 分钟 / refresh 30 天，refresh 轮换制（API.md §2 定稿） */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/** register / login 的响应 */
export interface AuthResponse extends AuthTokens {
  user: UserProfile;
}

export interface UpdateMeRequest {
  nickname?: string;
  avatarUrl?: string;
}

// —— §4 设备（已实现） ——

export interface BindDeviceRequest {
  deviceId: string;
  bindCode: string;
}

/** 设备实时状态（online 由服务端按 90s 窗口计算，App 不自行判断） */
export interface DeviceStatus {
  online: boolean;
  lastSeenAt: string | null;
  battery: number | null;
  charging: boolean | null;
  signalLevel: number | null;
  sleeping: boolean;
  firmwareVersion: string | null;
}

/** 设备列表/详情项（含状态快照） */
export interface DevicePublic extends DeviceStatus {
  deviceId: string;
  boundAt: string | null;
  createdAt: string;
}

// —— §10 Admin（已实现子集） ——

export interface AdminLoginRequest {
  username: string;
  password: string;
}

export interface AdminInfo {
  id: string;
  username: string;
}

/** admin accessToken 12 小时，无 refresh（API.md §10 定稿） */
export interface AdminLoginResponse {
  admin: AdminInfo;
  accessToken: string;
}

export interface AdminUserRow {
  id: string;
  phone: string;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: string;
  deviceCount: number;
}

export interface AdminDeviceRow extends DevicePublic {
  bindUser: { id: string; phone: string; nickname: string | null } | null;
}
