// REST API Contract（docs/API.md 已实现部分落型）。全部为线上格式：
// 时间字段一律 ISO 8601 UTC 字符串（后端内部用 Date，由序列化层转换）。
import type {
  CommandResult,
  CoordinateSystem,
  DeviceCommand,
} from './events';
import type { DeviceSettingKey } from './settings';

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

/** 验证码用途：注册 / 找回密码 / 换绑手机号（API.md §2；change_phone 的 phone 为新号，2026-09-11） */
export type SmsCodePurpose = 'register' | 'reset_password' | 'change_phone';

/** POST /auth/sms-code → 204；60s 内重发 429 SMS_CODE_TOO_FREQUENT，日上限 429 SMS_CODE_DAILY_LIMIT */
export interface SmsCodeRequest {
  phone: string;
  purpose: SmsCodePurpose;
}

export interface RegisterRequest {
  phone: string;
  /** 6 位短信验证码（purpose=register）；错误/过期/已用 → 400 SMS_CODE_INVALID */
  code: string;
  password: string;
  nickname?: string;
}

/** POST /auth/reset-password → 204，成功后该用户全部会话失效 */
export interface ResetPasswordRequest {
  phone: string;
  /** purpose=reset_password 的验证码 */
  code: string;
  newPassword: string;
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

/** POST /auth/change-password → 204（需登录）；旧密码错误 → 400 PASSWORD_INCORRECT。
 *  成功后撤销该用户其他全部会话；带上当前设备的 refreshToken 可让本设备保持登录 */
export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
  refreshToken?: string;
}

/** POST /auth/change-phone → 200 返回更新后的 user（需登录）；code 为 purpose=change_phone、发往 newPhone 的验证码；
 *  password 为当前密码（2026-10-14 加：持有会话不等于本人）。密码错误 → 400 PASSWORD_INCORRECT（不消费验证码）；
 *  newPhone 已注册 → 409 PHONE_ALREADY_REGISTERED；验证码错误 → 400 SMS_CODE_INVALID */
export interface ChangePhoneRequest {
  newPhone: string;
  code: string;
  password: string;
}

/** DELETE /users/me → 204（需登录）：注销账号（软删除）；密码错误 → 400 PASSWORD_INCORRECT；
 *  本账号还有进行中的求救 → 409 SOS_IN_PROGRESS（什么都不改，2026-10-22 O15）。
 *  成功后全部会话作废、设备全部解绑、紧急联系人全部删除，原手机号可重新注册（原号不保留）；
 *  残留的 access token / refresh token 之后一律 401 ACCOUNT_DELETED */
export interface DeleteAccountRequest {
  password: string;
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

/** 电量历史点（API.md §4 GET /devices/{id}/battery-history）：10 分钟桶，取桶内最后一条心跳 */
export interface BatteryHistoryPoint {
  timestamp: string;
  battery: number;
  charging: boolean | null;
}

export interface BatteryHistoryResponse {
  from: string;
  to: string;
  points: BatteryHistoryPoint[];
}

/** 设备列表/详情项（含状态快照）。bindCode 仅经归属校验的端点返回（本人可见，供详情展示） */
export interface DevicePublic extends DeviceStatus {
  deviceId: string;
  /** 用户自定义设备名；null 时 App 显示 deviceId */
  name: string | null;
  bindCode: string | null;
  boundAt: string | null;
  createdAt: string;
}

/** PATCH /devices/{id}：目前仅支持重命名；name trim 后空串视为清除（回退显示 deviceId） */
export interface UpdateDeviceRequest {
  name?: string | null;
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

/** GET /devices/{id}/locations/summary?from&to（API.md §5）：区间轨迹统计，服务端按相邻点累加；无点时 maxSpeed/firstAt/lastAt 为 null */
export interface LocationSummaryResponse {
  /** 米 */
  distanceMeters: number;
  /** 秒，只累计相邻点间隔 ≤10 min 且平均速度 ≥0.5 m/s 的段 */
  movingSeconds: number;
  /** m/s，与 location.speed 同单位 */
  maxSpeed: number | null;
  pointCount: number;
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * 一趟行程的摘要（GET /devices/{id}/rides，API.md §5）。
 * 「一趟」是展示用的分段：相邻定位点断档超过 15 分钟，或停住不动超过 15 分钟，就算上一趟结束；
 * 不是骑行状态判断，不触发任何业务流程。startAt 同时是这一趟的标识。
 */
export interface RideSummary {
  /** 这一趟第一个点的时间（ISO 8601 UTC） */
  startAt: string;
  /** 这一趟最后一个在动的点的时间；进行中的一趟是目前收到的最后一个点 */
  endAt: string;
  /** 米 */
  distanceMeters: number;
  /** 秒，口径同 LocationSummaryResponse.movingSeconds */
  movingSeconds: number;
  /** m/s，与 location.speed 同单位 */
  maxSpeed: number | null;
  /** 还没结束：距这一趟最后一次在动不超过 15 分钟 */
  ongoing: boolean;
}

/** GET /devices/{id}/rides?from&to：起点落在 [from, to) 内的行程，最新在前 */
export interface RidesResponse {
  rides: RideSummary[];
}

/** GET /devices/{id}/locations/track?from&to&maxPoints：抽稀后的轨迹 + 用全部点算出的统计 */
export interface TrackResponse {
  /** 按 timestamp 升序；点数超过 maxPoints 时等间隔抽稀，首尾两点一定保留 */
  points: LocationPoint[];
  /** 抽稀前的点数 */
  total: number;
  /** 用全部点算的统计，不受抽稀影响 */
  summary: LocationSummaryResponse;
}

// —— §6 事件查询（已实现） ——

/** 事件详情里的关联媒体（§9；该事件没有关联媒体时为空数组） */
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
  /** 业务时间（决策 #59）：设备时钟可信时 = 设备时间，时钟错乱时 = 收到时间；列表按它排序，App 按它显示 */
  timestamp: string;
  /** 设备上报的原始时间（时钟错乱时可能是 1970 / 2099，仅供排查） */
  deviceTimestamp: string;
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
  /**
   * 扁平键值。✅ 参数清单定稿（决策 #43）：键名/类型/取值范围以 settings.ts 的 DEVICE_SETTINGS 为准，
   * 服务端对未知键、类型不符、越界一律 400 VALIDATION_FAILED，不下发。
   * 线上类型保持宽松（string 仍在联合里）只为不破坏调用方现有签名；想要编译期约束用 DeviceSettings。
   */
  settings: Record<string, string | number | boolean>;
}

/** PUT /devices/{id}/settings 响应：命令已创建、尚未送达（状态流转见 CommandPublic.status） */
export interface PutSettingsResponse {
  commandId: string;
  status: 'pending';
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

/**
 * POST /devices/{id}/settings/reported（决策 #45）：App 在每次 BLE 握手后读回头盔 0x20–0x2D，
 * 把实际设置上报，让云端显示与头盔一致（例：大灯挡位掉电不保存，重启后回到关）。
 */
export interface ReportSettingsRequest {
  settings: Record<string, number | boolean>;
}

/** invalid = 不在清单或类型/范围不合法；recent_command = 该键有未完成或 30 s 内刚成功的命令，以命令为准 */
export type ReportSettingsSkipReason = 'invalid' | 'recent_command';

export interface ReportSettingsResponse {
  /** 合入后的当前生效设置 */
  settings: Record<string, unknown>;
  /** 本次被采纳的键 */
  applied: DeviceSettingKey[];
  skipped: { key: string; reason: ReportSettingsSkipReason; message: string }[];
}

/** GET /devices/{id}/settings：当前生效设置（success 回执或头盔上报的实际值，决策 #45）+ 最近一次下发 */
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
  /**
   * 触发事件在头盔上发生的时间（事件 envelope 的 timestamp）。离线补传的旧事件它会明显早于 createdAt，
   * App 据此在锁屏通知与倒计时页写明「约 3 小时前的事件，刚补传到」（决策 #52）——此前这句只在服务端的
   * 远程推送正文里，iOS 为避免与本地通知叠在一起会撤掉远程那条，这句话就跟着没了（2026-10-07 iPhone 4.14 实测）。
   * 服务端填；旧数据 / 旧服务端可缺省，缺省时不显示这句。
   */
  triggeredAt?: string;
}

/** GET /devices/{id}/sos/active：无进行中 SOS 时 sos 为 null（与 locations/latest 同口径，定稿） */
export interface ActiveSosResponse {
  sos: Sos | null;
}

/**
 * GET /users/me/sos/active 的列表项（2026-10-17，上线清单 B 线第 12 项）：本账号所有进行中的 SOS，按 deadline 升序、统一分页。
 * deviceName = 头盔当前名字（服务端已整理），**只在头盔仍绑在本人名下且起过名时**有值，否则 null（App 显示设备号）——
 * 头盔转给别人后，新主人起的名字不该让前主人看到
 */
export interface ActiveSosItem extends Sos {
  deviceName: string | null;
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
  | 'device_event'
  | 'device_command'
  | 'voice_taken_over';

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

/** type=device_command 的 data（决策 #36，BLE 下行链）：新命令实时推 + 连接建立时补推 pending/delivered 存量；
 *  commandId 幂等——App/头盔重复收到不重复执行 */
export interface WsDeviceCommandData extends DeviceCommand {
  deviceId: string;
}

/** type=voice_taken_over 的 data（决策 #62）：本账号在 clientId 那台手机上进了对讲（POST /voice/channels/{id}/token
 *  带 purpose=enter）。clientId 不是自己、自己又在通话里（或已拿到凭证正在进房）的 App 退房并提示「被另一台手机接管」 */
export interface WsVoiceTakenOverData {
  channelId: string;
  clientId: string;
}

/** POST /devices/{id}/commands/{cid}/relay-ack 请求体（决策 #36）：
 *  delivered = App 已把命令写入头盔（蓝牙版的"送达"，对应 4G 版 PUBACK）；
 *  executed = 转发头盔执行结果（executedAt 缺省由服务端取当前时间） */
export type RelayAckRequest =
  | { stage: 'delivered' }
  | {
      stage: 'executed';
      result: CommandResult;
      errorCode?: string;
      executedAt?: string;
    };

/** relay-ack 响应：更新后的命令状态（幂等重复提交返回当前状态，不报错） */
export interface RelayAckResponse {
  commandId: string;
  status: CommandStatus;
}

// —— §13 网络对讲（已实现） ——

/** 频道对象（决策 #27⑤：6 位邀请码、TRTC 房间号=roomId、成员上限 20） */
export interface VoiceChannel {
  channelId: string;
  name: string;
  roomId: number;
  inviteCode: string;
  ownerId: string;
  memberCount: number;
  createdAt: string;
}

export interface CreateChannelRequest {
  name: string;
}

export interface JoinChannelRequest {
  inviteCode: string;
}

/** 成员列表项：phone 已脱敏；avatarUrl 同频道成员互相可见（2026-08-17） */
export interface VoiceChannelMemberPublic {
  userId: string;
  nickname: string | null;
  avatarUrl: string | null;
  phone: string;
  joinedAt: string;
}

/**
 * POST /voice/channels/{id}/token 请求体（决策 #62，可整个省略——旧包不带，行为同从前）：
 * - clientId：App 进程启动时随机生成的本机标识（8–64 位字母 / 数字 / _ / -），只用来区分同一账号的几台手机；
 * - purpose：enter = 用户主动进房，服务端记下这台为本账号当前通话的手机，并经 WS 通知同账号其他连接；
 *   renew = 在房续钥匙、断线后自动重进（都是接着自己原来的通话，不抢别人的），若本账号已被另一台手机接管则
 *   409 VOICE_TAKEN_OVER（WS 通知漏收时的兜底）。
 *   带 purpose 时 clientId 必填。
 */
export interface VoiceTokenRequest {
  clientId?: string;
  purpose?: 'enter' | 'renew';
}

/** 进房凭证：App 端用 TRTC SDK 携此进房（roomId + privateMapKey）+ PTT */
export interface VoiceTokenResponse {
  sdkAppId: number;
  userId: string;
  roomId: number;
  userSig: string;
  /**
   * 房间权限钥匙（TRTC PrivateMapKey，决策 #56）：只对这个 roomId 有效、默认 10 分钟——进房前现取 /token，
   * 填进 TRTCParams.privateMapKey。TRTC 控制台开启「高级权限控制」后不带它进不了房
   */
  privateMapKey: string;
  /** userSig 到期时间（privateMapKey 更短，不单独下发） */
  expiresAt: string;
}

// —— §12.1 App 中转入口（蓝牙版，已实现） ——

/** 蓝牙版：App 中转模块批量提交从 BLE 收到的事件（断线补传友好，单批 ≤100） */
export interface AppRelayRequest {
  deviceId: string;
  /** EVENTS.md §1 envelope 原样透传，App 不修改内容 */
  envelopes: unknown[];
}

/** 重复与校验失败不报错（补传无需关心哪些已传过），只给计数 */
export interface AppRelayResponse {
  accepted: number;
  duplicate: number;
  invalid: number;
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
  /** 已注销时间；列表默认不含已注销账号，`includeDeleted=true` 时才出现（口径 2026-09-15） */
  deletedAt: string | null;
  deviceCount: number;
}

/** GET /admin/devices 列表项（API.md §10.1）：状态字段同 DevicePublic，但不含用户自定义名与绑定码 */
export interface AdminDeviceRow extends Omit<DevicePublic, 'name' | 'bindCode'> {
  bindUser: { id: string; phone: string; nickname: string | null } | null;
}

/** GET /admin/accidents 列表项：事故 + 归属用户（建单时固化，解绑不失联） */
export interface AdminAccidentRow extends AccidentListItem {
  user: { id: string; phone: string; nickname: string | null } | null;
}

/**
 * GET /admin/events 列表项：Admin 是排查工具，带业务接口不可见的 source/clockSkew。
 * 这里的 timestamp 是设备上报的原值（不是 App 接口的业务时间，决策 #59），配合 clockSkew 排查时钟问题
 */
export interface AdminEventRow extends Omit<EventListItem, 'deviceTimestamp'> {
  payload: Record<string, unknown>;
  source: string;
  clockSkew: boolean;
  schemaVersion: number;
}

/** GET /admin/devices/{id}：设备详情 + 最近事件（含 _invalid，排查用） */
export interface AdminDeviceDetail extends AdminDeviceRow {
  /** 当前生效设置（§8：success 回执写入；另由头盔握手时读回上报纠正，决策 #45） */
  settings: Record<string, unknown>;
  recentEvents: AdminEventRow[];
}

/** GET /admin/stats/overview：指标集定稿（2026-08-16）；「今日」= UTC+8 自然日，事件数不含校验失败留档 */
export interface AdminStatsOverview {
  deviceTotal: number;
  deviceOnline: number;
  userTotal: number;
  todayEvents: number;
  activeSos: number;
  generatedAt: string;
}
