// 设备可远程设置项 Contract（API.md §8 / EVENTS.md §6 / DEVICE_PROTOCOL §7；决策 #43）。
// 来源：硬件 BLE 协议 v0.6 内存控制表 0x20–0x2D（docs/hardware/BLE通信协议手册-v0.6.html §2.0）。
// 键名四端共用（App 设置页 / 后端入口校验 / Mock 回执 / Admin 展示）；寄存器地址只归 App 的 BLE 层。
// 与 events.ts 不同，这里带一个薄校验函数：后端与 Mock 用同一份取值范围，不各写一遍。

export type DeviceSettingKind = 'bool' | 'int';

export interface DeviceSettingSpec {
  kind: DeviceSettingKind;
  /** kind=int 时的闭区间 */
  min?: number;
  max?: number;
  unit?: string;
  /** 头盔出厂默认（手册 §2.0 默认值列） */
  default: number | boolean;
  /** 说明与档位含义（括号内为头盔内存表首地址，仅供对照） */
  description: string;
}

export const DEVICE_SETTINGS = {
  heartbeatPeriod: {
    kind: 'int',
    min: 1,
    max: 255,
    unit: 's',
    default: 60,
    description: '心跳状态上报周期（0x20）',
  },
  locationPeriodMoving: {
    kind: 'int',
    min: 1,
    max: 255,
    unit: 's',
    default: 5,
    description: '运动状态定位周期（0x21）',
  },
  locationPeriodStill: {
    kind: 'int',
    min: 1,
    max: 255,
    unit: 's',
    default: 30,
    description: '静止状态定位周期（0x22）',
  },
  buzzer: {
    kind: 'bool',
    default: true,
    description: '蜂鸣器声音提醒开关（0x23）',
  },
  volume: {
    kind: 'int',
    min: 1,
    max: 100,
    unit: '%',
    default: 80,
    description: '蜂鸣器音量（0x24）',
  },
  vibration: {
    kind: 'int',
    min: 0,
    max: 3,
    default: 2,
    description: '振动马达提醒挡位：0 关 / 1 弱 / 2 中 / 3 强（0x25）',
  },
  light: {
    kind: 'int',
    min: 0,
    max: 3,
    default: 0,
    description: '前照明大灯挡位：0 关 / 1 低亮 / 2 高亮 / 3 爆闪（0x26，头盔侧不掉电保存）',
  },
  fallDetect: {
    kind: 'bool',
    default: true,
    description: '跌倒检测算法使能（0x27）',
  },
  fallSensitivity: {
    kind: 'int',
    min: 1,
    max: 3,
    default: 2,
    description: '跌倒检测灵敏度：1 低 / 2 标准 / 3 灵敏（0x28）',
  },
  radar: {
    kind: 'bool',
    default: true,
    description: '后置毫米波雷达防碰撞使能（0x29）',
  },
  radarDistance: {
    kind: 'int',
    min: 5,
    max: 30,
    unit: 'm',
    default: 15,
    description: '后方碰撞预警距离门限（0x2A）',
  },
  obstacleWarn: {
    kind: 'bool',
    default: true,
    description: '前方障碍物预警使能（0x2B）',
  },
  sosButton: {
    kind: 'bool',
    default: true,
    description: 'SOS 物理按键使能：关闭=防误触（0x2C）',
  },
  disconnectBeep: {
    kind: 'bool',
    default: false,
    description: 'BLE 断连本地蜂鸣提醒（0x2D）',
  },
} as const satisfies Record<string, DeviceSettingSpec>;

export type DeviceSettingKey = keyof typeof DEVICE_SETTINGS;
export type DeviceSettingValue = number | boolean;
/** 一次下发的设置子集；PUT /devices/{id}/settings 的 settings 字段按此校验 */
export type DeviceSettings = Partial<Record<DeviceSettingKey, DeviceSettingValue>>;

export const DEVICE_SETTING_KEYS = Object.keys(DEVICE_SETTINGS) as DeviceSettingKey[];

export const isDeviceSettingKey = (key: string): key is DeviceSettingKey =>
  Object.prototype.hasOwnProperty.call(DEVICE_SETTINGS, key);

export type DeviceSettingCheck =
  | { ok: true; key: DeviceSettingKey; value: DeviceSettingValue }
  | { ok: false; reason: 'unknown_key' | 'type' | 'range'; message: string };

/**
 * 校验单个设置项：未知键 / 类型不符 / 越界三种失败原因。
 * 类型是严格的（bool 只收 boolean，int 只收整数 number）——App 设置页发的就是这两种，
 * 字符串形式的 "80" / "on" 一律拒绝，避免同一个值在不同端被解释成不同东西。
 */
export function checkDeviceSetting(key: string, value: unknown): DeviceSettingCheck {
  if (!isDeviceSettingKey(key)) {
    return {
      ok: false,
      reason: 'unknown_key',
      message: `未知设置项：${key}（可用：${DEVICE_SETTING_KEYS.join('、')}）`,
    };
  }
  const spec: DeviceSettingSpec = DEVICE_SETTINGS[key];
  if (spec.kind === 'bool') {
    if (typeof value !== 'boolean') {
      return { ok: false, reason: 'type', message: `设置项 ${key} 需要布尔值` };
    }
    return { ok: true, key, value };
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, reason: 'type', message: `设置项 ${key} 需要整数` };
  }
  const min = spec.min ?? Number.MIN_SAFE_INTEGER;
  const max = spec.max ?? Number.MAX_SAFE_INTEGER;
  if (value < min || value > max) {
    return {
      ok: false,
      reason: 'range',
      message: `设置项 ${key} 取值范围 ${min}–${max}${spec.unit ?? ''}`,
    };
  }
  return { ok: true, key, value };
}

/**
 * 头盔执行回执的错误码标识（BLE 协议 v0.6 §3.0）。cmd_ack.errorCode / relay-ack.errorCode 用这些名字，
 * App 中转侧会追加 `:<key>` 指明是哪个设置项（如 `ERR_PARAM_VALUE:volume`）。
 * 另有两个 App/Mock 侧自定义码：UNSUPPORTED_SETTING（键不在本表）、EMPTY_PARAMS。
 */
export const HELMET_ERROR_CODES = [
  'ERR_LENGTH',
  'ERR_INSTRUCTION',
  'ERR_ADDR_RANGE',
  'ERR_EPROM_LOCKED',
  'ERR_PARAM_VALUE',
  'ERR_BATTERY_LOW',
  'ERR_HARDWARE_FAULT',
] as const;
export type HelmetErrorCode = (typeof HELMET_ERROR_CODES)[number];
