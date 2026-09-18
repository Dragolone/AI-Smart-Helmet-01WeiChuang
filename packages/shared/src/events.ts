// 事件 Contract（docs/EVENTS.md 落型）。字段只增不改不删（DECISIONS #18）；
// 本文件不做运行时校验，只提供编译期约束——服务端校验仍在 backend Ingest 层。

/** 当前事件结构版本（EVENTS.md §1） */
export const CURRENT_SCHEMA_VERSION = 1;

/** MVP 事件类型总表（EVENTS.md §3） */
export const EVENT_TYPES = [
  'device_status',
  'location_update',
  'possible_fall',
  'manual_sos',
  'collision_risk',
  'obstacle_risk',
  'risk_cleared',
  'sleep_entered',
  'sleep_exited',
  'bluetooth_lost',
  'video_ready',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** 蓝牙版 MVP 第一期允许经 App 中转的事件类型（DEVICE_PROTOCOL §1.1，决策 #31）：
 *  保命链路 + 危险留档完整；其余 4 种（video_ready、sleep 两种、bluetooth_lost）下一版本 */
export const BLE_RELAY_EVENT_TYPES = [
  'device_status',
  'location_update',
  'possible_fall',
  'manual_sos',
  'collision_risk',
  'obstacle_risk',
  'risk_cleared',
] as const satisfies readonly EventType[];

/** 坐标必须显式携带坐标系，不允许隐含约定（EVENTS.md §2.4） */
export type CoordinateSystem = 'wgs84' | 'gcj02';

/** ⚠️ 分级口径与档位数待算法确认（EVENTS.md 4.5） */
export type RiskLevel = 'low' | 'medium' | 'high';
/** ⚠️ 集合待算法确认；未知值按 unknown 落库并告警 */
export type RiskObjectType = 'vehicle' | 'pedestrian' | 'obstacle' | 'unknown';
/** ⚠️ 待算法确认 */
export type RiskDirection = 'front' | 'rear' | 'left' | 'right';
/** ⚠️ 集合待硬件确认（EVENTS.md 4.7） */
export type SleepReason = 'inactivity' | 'manual' | 'low_battery';

/** 4.1 device_status */
export interface DeviceStatusPayload {
  /** 0–100（%） */
  battery: number;
  charging?: boolean;
  /** 4G 信号强度 0–4（⚠️ 分级口径待硬件确认） */
  signalLevel?: number;
  sleeping?: boolean;
}

/** 4.2 location_update（全字段必填版，上报专用） */
export interface LocationUpdatePayload {
  /** -90 ~ 90（°） */
  latitude: number;
  /** -180 ~ 180（°） */
  longitude: number;
  coordinateSystem: CoordinateSystem;
  /** ≥0（m），水平定位精度（68% 置信半径） */
  accuracy: number;
  /** ≥0（m/s） */
  speed: number;
  /** 0 ~ 360（°），正北为 0 顺时针 */
  heading: number;
  /** 海拔（m） */
  altitude?: number;
}

/** 事件内嵌位置快照（EVENTS.md 4.3）：经纬度+坐标系必填，其余选填 */
export interface LocationSnapshot {
  latitude: number;
  longitude: number;
  coordinateSystem: CoordinateSystem;
  accuracy?: number;
  speed?: number;
  heading?: number;
  altitude?: number;
}

/** 4.3 possible_fall（触发 SOS 状态机） */
export interface PossibleFallPayload {
  /** 0 ~ 1，算法置信度，原样落库不参与软件判断 */
  confidence?: number;
  algorithmVersion?: string;
  /** 冲击力（g），v0.6 载荷；App 中转附上，原样落库 */
  impactG?: number;
  /** 倾角（°），v0.6 载荷；原样落库 */
  tiltDeg?: number;
  location?: LocationSnapshot;
}

/** 4.4 manual_sos（触发 SOS 状态机） */
export interface ManualSosPayload {
  /** v0.6 触发方式：1 长按 / 2 双击 */
  triggerMode?: 'long_press' | 'double_click';
  /** 按键时长（ms），v0.6 uint16 */
  pressDurationMs?: number;
  location?: LocationSnapshot;
}

/** 4.5 collision_risk / obstacle_risk（两类结构相同） */
export interface RiskEventPayload {
  riskLevel: RiskLevel;
  objectType?: RiskObjectType;
  direction?: RiskDirection;
  /** ≥0（m），目标距离 */
  distance?: number;
  /** 预测碰撞时间（s），v0.6 载荷；原样落库 */
  ttcSeconds?: number;
  /** 目标逼近速度（km/h），v0.6 载荷；原样落库 */
  approachSpeedKmh?: number;
  confidence?: number;
  algorithmVersion?: string;
  location?: LocationSnapshot;
}

/** 4.6 risk_cleared */
export interface RiskClearedPayload {
  /** 缺省表示解除该设备当前全部危险状态 */
  clearedEventId?: string;
}

/** 4.7 sleep_entered / sleep_exited（两类结构相同） */
export interface SleepPayload {
  reason?: SleepReason;
  /** 0–100（%），进入/退出时电量快照 */
  battery?: number;
}

/** 4.8 bluetooth_lost */
export interface BluetoothLostPayload {
  /** ≥0（s），触发上报时已断开时长 */
  disconnectDuration?: number;
}

/** 4.9 video_ready */
export interface VideoReadyPayload {
  videoId: string;
  relatedEventId?: string;
  /** 片段时长（s） */
  duration?: number;
  sizeBytes?: number;
  /** ⚠️ 上传方式待硬件确认后定稿 */
  storageKey?: string;
}

/** eventType → payload 的映射，供泛型窄化 */
export interface EventPayloadMap {
  device_status: DeviceStatusPayload;
  location_update: LocationUpdatePayload;
  possible_fall: PossibleFallPayload;
  manual_sos: ManualSosPayload;
  collision_risk: RiskEventPayload;
  obstacle_risk: RiskEventPayload;
  risk_cleared: RiskClearedPayload;
  sleep_entered: SleepPayload;
  sleep_exited: SleepPayload;
  bluetooth_lost: BluetoothLostPayload;
  video_ready: VideoReadyPayload;
}

/**
 * 统一事件 envelope 的线上格式（EVENTS.md §1）——设备/Mock/算法 Webhook 发出的原始形态。
 * timestamp 为设备侧事件发生时间（ISO 8601 UTC 字符串）；receivedAt/source 由服务端生成，不在此内。
 */
export interface EventEnvelope<T extends EventType = EventType> {
  schemaVersion: number;
  /** 设备/算法侧生成（UUID），服务端幂等去重依据 */
  eventId: string;
  deviceId: string;
  eventType: T;
  timestamp: string;
  firmwareVersion: string;
  payload: EventPayloadMap[T];
}

// —— §6 命令与回执（云→设备 cmd / 设备→云 cmd_ack）——

/** ⚠️ 是否需要 request_status 等其他命令待硬件确认 */
export type DeviceCommandType = 'set_config';

export interface DeviceCommand {
  /** 服务端生成（UUID），回执按此关联 */
  commandId: string;
  type: DeviceCommandType;
  /** set_config 的参数键值对；⚠️ 允许的参数清单与取值范围待硬件定稿 */
  params: Record<string, unknown>;
  /** ISO 8601 UTC，服务端下发时间 */
  issuedAt: string;
}

export type CommandResult = 'success' | 'failed';

export interface CommandAck {
  commandId: string;
  result: CommandResult;
  /** ⚠️ 码表待硬件提供 */
  errorCode?: string;
  /** ISO 8601 UTC，设备执行时间 */
  executedAt: string;
}
