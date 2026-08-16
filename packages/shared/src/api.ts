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

// —— §3 紧急联系人（已实现） ——

/** 紧急联系人：SOS 通知（SMS）的发送对象；每用户上限 5 个（API.md §3 定稿） */
export interface EmergencyContact {
  id: string;
  name: string;
  phone: string;
  relation: string | null;
  createdAt: string;
}

export interface CreateEmergencyContactRequest {
  name: string;
  phone: string;
  relation?: string;
}

export interface UpdateEmergencyContactRequest {
  name?: string;
  phone?: string;
  relation?: string;
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

// —— §6 事件查询（已实现） ——

/** 事件详情里的关联媒体（§9 媒体模块落地前恒为空数组） */
export interface MediaRef {
  mediaId: string;
  status: string;
  duration: number | null;
}

/** 事件历史列表项（§6）：summary 为服务端生成的一句话摘要，App 可自行渲染忽略之 */
export interface EventListItem {
  eventId: string;
  deviceId: string;
  eventType: string;
  timestamp: string;
  receivedAt: string;
  summary: string;
}

/** 事件详情：追加原样 payload 与关联媒体 */
export interface EventDetail extends EventListItem {
  payload: Record<string, unknown>;
  media: MediaRef[];
}

// —— §8 设备设置下发（已实现） ——

/** 命令状态机（DEVICE_PROTOCOL §7）：未回执绝不显示成功；offline=回执超时（设备离线或未执行） */
export type CommandStatus =
  | 'pending'
  | 'delivered'
  | 'success'
  | 'failed'
  | 'offline';

export interface PutSettingsRequest {
  /** 扁平键值（标量），参数清单与取值范围待硬件定稿（⚠️） */
  settings: Record<string, string | number | boolean>;
}

export interface CommandPublic {
  commandId: string;
  deviceId: string;
  type: string;
  params: Record<string, unknown>;
  status: CommandStatus;
  issuedAt: string;
  deliveredAt: string | null;
  ackResult: 'success' | 'failed' | null;
  errorCode: string | null;
  executedAt: string | null;
}

/** GET /devices/{id}/settings：当前生效设置（仅 success 回执写入）+ 最近一次下发 */
export interface SettingsResponse {
  settings: Record<string, unknown>;
  lastCommand: CommandPublic | null;
}

// —— §9 媒体（已实现） ——

/** GET /media/{id}/url：有时效预签名 URL（10 分钟，✅ 定稿）；过期后重新换取 */
export interface MediaUrlResponse {
  url: string;
  expiresAt: string;
}

// —— §7 SOS / 事故记录（已实现） ——

export type SosTriggerType = 'possible_fall' | 'manual_sos';

/** 服务端权威状态机（决策 #8）：pending → notified | cancelled；App 仅渲染 */
export type SosStatus = 'pending' | 'notified' | 'cancelled';

/** sos 对象（API.md §7）：App 收到后按 deadline 本地倒计时渲染，不自行计时判断超时 */
export interface Sos {
  sosId: string;
  deviceId: string;
  triggerEventId: string;
  triggerType: SosTriggerType;
  status: SosStatus;
  deadline: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /devices/{id}/sos/active：无进行中 SOS 时 sos 为 null（与 locations/latest 同口径，定稿） */
export interface ActiveSosResponse {
  sos: Sos | null;
}

/** 事故位置快照（口径见 DECISIONS #26）：event=触发事件内嵌位置 / last_point=最新轨迹点回落 */
export interface AccidentLocation {
  latitude: number;
  longitude: number;
  coordinateSystem: CoordinateSystem;
  accuracy: number | null;
  source: 'event' | 'last_point';
}

/** 事故记录列表项（= SOS 单，含已取消供留档） */
export interface AccidentListItem extends Sos {
  location: AccidentLocation | null;
}

/** 通知发送记录；target 已脱敏（手机号打码），联系人以 contactName 辨识 */
export interface SosNotificationPublic {
  id: string;
  channel: 'sms' | 'push';
  target: string;
  contactName: string | null;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}

/** 事故详情：触发事件原始 payload（raw 留档，可能为 null）+ 通知发送记录 */
export interface AccidentDetail extends AccidentListItem {
  triggerPayload: Record<string, unknown> | null;
  notifications: SosNotificationPublic[];
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

/** type=sos_update 的 data：§7 sos 对象（创建/取消/确认/超时通知四个时机都推） */
export type WsSosData = Sos;

/** type=risk_event 的 data：collision_risk / obstacle_risk / risk_cleared 的事件详情（当前危险状态由 App 从事件流推导，决策 #27） */
export type WsRiskEventData = EventDetail;

/** type=device_event 的 data：sleep_* / bluetooth_lost / video_ready 的事件列表项 */
export type WsDeviceEventData = EventListItem;

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

/** GET /admin/accidents 列表项：事故 + 归属用户（建单时固化，解绑不失联） */
export interface AdminAccidentRow extends AccidentListItem {
  user: { id: string; phone: string; nickname: string | null } | null;
}
