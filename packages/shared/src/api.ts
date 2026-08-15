// REST API Contract（docs/API.md 已实现部分落型）。全部为线上格式：
// 时间字段一律 ISO 8601 UTC 字符串（后端内部用 Date，由序列化层转换）。
import type { CoordinateSystem } from './events';

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

// —— §5 位置与轨迹（已实现） ——

/** 轨迹点/位置对象（与 EVENTS.md 4.2 对齐；timestamp 为设备侧时间，receivedAt 为服务器接收时间） */
export interface LocationPoint {
  latitude: number;
  longitude: number;
  coordinateSystem: CoordinateSystem;
  accuracy: number;
  speed: number;
  heading: number;
  altitude: number | null;
  timestamp: string;
  receivedAt: string;
}

/** GET /devices/{id}/locations/latest：设备存在但尚无位置数据时 location 为 null */
export interface LatestLocationResponse {
  location: LocationPoint | null;
}

// —— §11 WebSocket（App 实时通道） ——

export type WsMessageType =
  | 'device_status'
  | 'location_update'
  | 'sos_update'
  | 'risk_event'
  | 'device_event';

/** WS 是加速通道不是可靠通道：重连后须用 REST 拉取兜底（API.md §11） */
export interface WsMessage<T = unknown> {
  type: WsMessageType;
  data: T;
  sentAt: string;
}

/** type=location_update 的 data：轨迹点 + 设备号（一个连接可能收到多台绑定设备的消息） */
export interface WsLocationData extends LocationPoint {
  deviceId: string;
}

/** type=device_status 的 data：§4 status 对象 + 设备号 */
export interface WsDeviceStatusData extends DeviceStatus {
  deviceId: string;
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
