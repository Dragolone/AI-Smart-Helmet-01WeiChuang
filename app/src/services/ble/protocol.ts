// BLE 协议纯函数层（Contract：docs/hardware/BLE通信协议手册-v0.6.html，速查 DEVICE_PROTOCOL §1.2）。
// 只做字节 ⇄ 结构 ⇄ EVENTS.md envelope 的翻译，不碰蓝牙栈、不做任何业务判断
// （软件绝不基于原始传感器数据做算法决策——CLAUDE.md 核心原则）。
import type {
  DeviceSettingKey,
  DeviceSettings,
  EventEnvelope,
  EventType,
  RiskDirection,
  RiskLevel,
  RiskObjectType,
} from "@helmet/shared";
import {
  CURRENT_SCHEMA_VERSION,
  DEVICE_SETTINGS,
  checkDeviceSetting,
} from "@helmet/shared";

import {
  HELMET_BLE_NAMESPACE,
  asciiZ,
  readI16,
  readI32,
  readU16,
  readU32,
  uuidV5,
  writeU16,
  writeU32,
} from "./bytes";

export const SERVICE_UUID = "0000fee0-0000-1000-8000-00805f9b34fb";
/** 特征值 A：头盔 → App（Notify：应答 / 事件 / 补传） */
export const CHAR_NOTIFY_UUID = "0000fee1-0000-1000-8000-00805f9b34fb";
/** 特征值 B：App → 头盔（Write：指令 / ACK） */
export const CHAR_WRITE_UUID = "0000fee2-0000-1000-8000-00805f9b34fb";
export const ADV_NAME_PREFIX = "Helmet-";
export const REQUEST_MTU = 247;

export const Ins = {
  PING: 0x01,
  READ: 0x02,
  WRITE: 0x03,
  TIME_SYNC: 0x04,
  EVENT: 0x05,
  ACK: 0x06,
  RESEND_QUERY: 0x07,
  RESEND_DATA: 0x08,
  RECOVERY: 0x09,
  RESET: 0x0a,
} as const;

/** 内存控制表首地址（手册 §2.0） */
export const Reg = {
  FW_MAJOR: 0x00,
  FW_MINOR: 0x01,
  FW_PATCH: 0x02,
  HEARTBEAT_PERIOD: 0x20,
  LOC_PERIOD_MOVING: 0x21,
  LOC_PERIOD_STILL: 0x22,
  BUZZER_ENABLED: 0x23,
  BUZZER_VOLUME: 0x24,
  VIBRATION: 0x25,
  LIGHT: 0x26,
  FALL_DETECT: 0x27,
  FALL_SENSITIVITY: 0x28,
  RADAR: 0x29,
  RADAR_DISTANCE: 0x2a,
  OBSTACLE_WARN: 0x2b,
  SOS_BUTTON: 0x2c,
  DISCONNECT_BEEP: 0x2d,
  EVENT_SEQ_BASE: 0x34,
  DEVICE_ID: 0x40,
} as const;

/** 手册 §3.0 错误码 → 回执 errorCode 标识符（云端 cmd_ack.errorCode 原样落库） */
export const ERROR_NAMES: Record<number, string> = {
  0x00: "STATUS_OK",
  0x01: "ERR_LENGTH",
  0x02: "ERR_INSTRUCTION",
  0x03: "ERR_ADDR_RANGE",
  0x04: "ERR_EPROM_LOCKED",
  0x05: "ERR_PARAM_VALUE",
  0x06: "ERR_BATTERY_LOW",
  0x07: "ERR_HARDWARE_FAULT",
};

export const EVENT_CODE_TO_TYPE: Record<number, EventType> = {
  0x01: "possible_fall",
  0x02: "manual_sos",
  0x03: "collision_risk",
  0x04: "obstacle_risk",
  0x05: "risk_cleared",
  0x06: "location_update",
  0x07: "device_status",
};
/** 高危四类必 ACK（手册 §1.3）；周期事件不 ACK */
export const HIGH_RISK_CODES = new Set([0x01, 0x02, 0x03, 0x04]);

// —— 下行指令构造（§1.1：[指令码][Seq][参数…]） ——
export const buildPing = (seq: number): Uint8Array =>
  Uint8Array.from([Ins.PING, seq & 255]);
export const buildRead = (seq: number, addr: number, len: number): Uint8Array =>
  Uint8Array.from([Ins.READ, seq & 255, addr & 255, len & 255]);
export const buildWrite = (
  seq: number,
  addr: number,
  data: number[],
): Uint8Array =>
  Uint8Array.from([
    Ins.WRITE,
    seq & 255,
    addr & 255,
    ...data.map((d) => d & 255),
  ]);
export const buildTimeSync = (seq: number, utcSeconds: number): Uint8Array =>
  Uint8Array.from([Ins.TIME_SYNC, seq & 255, ...writeU32(utcSeconds)]);
export const buildResendQuery = (seq: number): Uint8Array =>
  Uint8Array.from([Ins.RESEND_QUERY, seq & 255]);
export const buildResendData = (
  seq: number,
  offset: number,
  count: number,
): Uint8Array =>
  Uint8Array.from([
    Ins.RESEND_DATA,
    seq & 255,
    ...writeU16(offset),
    count & 255,
  ]);
/** ACK 无流水号：[0x06][Event_Code][Event_Seq 4B][0x00]（§1.3） */
export const buildAck = (eventCode: number, eventSeq: number): Uint8Array =>
  Uint8Array.from([Ins.ACK, eventCode & 255, ...writeU32(eventSeq), 0x00]);

// —— 上行解析（§1.2 应答 / §1.3 事件） ——
export type InboundResponse = {
  kind: "response";
  ins: number;
  seq: number;
  error: number;
  data: Uint8Array;
};
export type InboundEvent = {
  kind: "event";
  code: number;
  eventSeq: number;
  /** UTC 秒；0 = 头盔未校时（云端按接收时间兜底） */
  timestamp: number;
  payload: Uint8Array;
};
export type Inbound = InboundResponse | InboundEvent;

export function parseInbound(bytes: Uint8Array): Inbound | null {
  if (bytes.length < 2) return null;
  if (bytes[0] === Ins.EVENT) {
    if (bytes.length < 10) return null;
    return {
      kind: "event",
      code: bytes[1],
      eventSeq: readU32(bytes, 2),
      timestamp: readU32(bytes, 6),
      payload: bytes.subarray(10),
    };
  }
  if (bytes.length < 3) return null;
  return {
    kind: "response",
    ins: bytes[0],
    seq: bytes[1],
    error: bytes[2],
    data: bytes.subarray(3),
  };
}

export const firmwareFromBytes = (b: Uint8Array): string =>
  b.length >= 3 ? `${b[0]}.${b[1]}.${b[2]}` : "unknown";
export const deviceIdFromBytes = (b: Uint8Array): string => asciiZ(b);

/** eventId 确定性派生：同一头盔同一 Event_Seq 永远得到同一 UUID（重发/补传天然幂等） */
export const eventIdFor = (deviceId: string, eventSeq: number): string =>
  uuidV5(HELMET_BLE_NAMESPACE, `${deviceId}:${eventSeq}`);

const RISK_LEVEL: Record<number, RiskLevel> = {
  1: "low",
  2: "medium",
  3: "high",
};
const OBJECT_TYPE: Record<number, RiskObjectType> = {
  0: "unknown",
  1: "vehicle",
  2: "pedestrian",
  3: "obstacle",
};
const DIRECTION: Record<number, RiskDirection> = {
  1: "front",
  2: "rear",
  3: "left",
  4: "right",
};

const coord = (b: Uint8Array, o: number) => ({
  latitude: readI32(b, o) / 1e6,
  longitude: readI32(b, o + 4) / 1e6,
  coordinateSystem: "wgs84" as const,
});

export interface TranslateContext {
  deviceId: string;
  firmwareVersion: string;
  /** App 收到帧的时刻，未校时（timestamp=0）时作为事件时间兜底 */
  receivedAt: Date;
}

/**
 * 事件帧 → EVENTS.md envelope（DEVICE_PROTOCOL §1.2 翻译规则）。
 * 返回 null 表示该帧不进云端：未知事件码、载荷长度不符、无定位的位置包（0xFF 精度）。
 * 原始字节字段（冲击力/倾角/TTC/按键时长/触发方式）原样附在 payload 里落库，供未来 AI 服务读取。
 */
export function translateEvent(
  ev: InboundEvent,
  ctx: TranslateContext,
): EventEnvelope | null {
  const eventType = EVENT_CODE_TO_TYPE[ev.code];
  if (!eventType) return null;
  const p = ev.payload;
  let payload: Record<string, unknown> | null = null;

  switch (ev.code) {
    // 摔倒 / 求救（各 11B）：载荷不全也要上云，能解的字段照填、缺的省略（EVENTS.md 里这些字段都是选填，
    // 服务端只凭事件类型建 SOS 单）。原来不足 11 字节就整条丢弃，而这两类帧连头 21 字节，
    // MTU 没协商上去（Notify 最多带 20 字节）或固件少发一个字节时正好少一截——App 已经回了 ACK，
    // 头盔据此擦除，这次摔倒就永远没人知道了（2026-10-05 评审）。
    case 0x01: // possible_fall
      payload = {
        ...(p.length >= 1 ? { confidence: p[0] / 100 } : {}),
        ...(p.length >= 2 ? { impactG: p[1] / 10 } : {}),
        ...(p.length >= 3 ? { tiltDeg: p[2] } : {}),
        ...(p.length >= 11 ? { location: coord(p, 3) } : {}),
      };
      break;
    case 0x02: // manual_sos
      payload = {
        ...(p.length >= 1
          ? { triggerMode: p[0] === 2 ? "double_click" : "long_press" }
          : {}),
        ...(p.length >= 3 ? { pressDurationMs: readU16(p, 1) } : {}),
        ...(p.length >= 11 ? { location: coord(p, 3) } : {}),
      };
      break;
    case 0x03: // collision_risk 15B
    case 0x04: // obstacle_risk 15B
      if (p.length < 15) return null;
      payload = {
        riskLevel: RISK_LEVEL[p[0]] ?? "high",
        objectType: OBJECT_TYPE[p[1]] ?? "unknown",
        direction: DIRECTION[p[2]],
        distance: readU16(p, 3) / 10,
        ttcSeconds: p[5] / 10,
        approachSpeedKmh: p[6],
        location: coord(p, 7),
      };
      break;
    case 0x05: {
      // risk_cleared 4B：0 = 清除全部
      if (p.length < 4) return null;
      const clearedSeq = readU32(p, 0);
      payload =
        clearedSeq === 0
          ? {}
          : { clearedEventId: eventIdFor(ctx.deviceId, clearedSeq) };
      break;
    }
    case 0x06: {
      // location_update 15B
      if (p.length < 15) return null;
      const accuracy = p[12];
      if (accuracy === 0xff) return null; // 无定位：不往云端塞无效坐标
      const heading = readU16(p, 10);
      const altitude = readI16(p, 13);
      payload = {
        ...coord(p, 0),
        speed: readU16(p, 8) / 10,
        heading: heading === 0xffff ? 0 : heading / 10,
        accuracy,
        ...(altitude !== 0x7fff ? { altitude } : {}),
      };
      break;
    }
    case 0x07: // device_status 2B
      if (p.length < 2) return null;
      payload = { battery: p[0], charging: p[1] === 1 };
      break;
    default:
      return null;
  }

  const timestamp =
    ev.timestamp === 0
      ? ctx.receivedAt.toISOString()
      : new Date(ev.timestamp * 1000).toISOString();
  const envelope = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: eventIdFor(ctx.deviceId, ev.eventSeq),
    deviceId: ctx.deviceId,
    eventType,
    timestamp,
    firmwareVersion: ctx.firmwareVersion,
    payload,
  };
  return envelope as unknown as EventEnvelope;
}

// —— 设置下发：云端 set_config 键 → 内存表寄存器 ——
// 键名/类型/取值范围只有一份，在 `@helmet/shared` 的 DEVICE_SETTINGS（决策 #43，服务端 PUT settings
// 用同一张表校验）。这里只管「键 → 寄存器地址」和「值 → 字节」，不再重复写范围。
export interface RegisterWrite {
  addr: number;
  data: number[];
}

/** 设置键 → 内存表寄存器（手册 §2.0）。14 项与 DEVICE_SETTINGS 一一对应，缺一个都编译不过 */
export const SETTING_REGISTER: Record<DeviceSettingKey, number> = {
  heartbeatPeriod: Reg.HEARTBEAT_PERIOD,
  locationPeriodMoving: Reg.LOC_PERIOD_MOVING,
  locationPeriodStill: Reg.LOC_PERIOD_STILL,
  buzzer: Reg.BUZZER_ENABLED,
  volume: Reg.BUZZER_VOLUME,
  vibration: Reg.VIBRATION,
  light: Reg.LIGHT,
  fallDetect: Reg.FALL_DETECT,
  fallSensitivity: Reg.FALL_SENSITIVITY,
  radar: Reg.RADAR,
  radarDistance: Reg.RADAR_DISTANCE,
  obstacleWarn: Reg.OBSTACLE_WARN,
  sosButton: Reg.SOS_BUTTON,
  disconnectBeep: Reg.DISCONNECT_BEEP,
};

/** 寄存器地址 → 设置键（读回 0x20–0x2D 时用） */
const REGISTER_SETTING = new Map<number, DeviceSettingKey>(
  (Object.keys(SETTING_REGISTER) as DeviceSettingKey[]).map((k) => [
    SETTING_REGISTER[k],
    k,
  ]),
);

/**
 * 返回 null = 该键不受支持、类型不符或越界（调用方回执 failed + errorCode）。
 * 校验一律走 shared checkDeviceSetting：布尔只收 boolean、整数只收整数，与服务端同口径——
 * 同一个值不会在两端被解释成不同东西。
 * 注意手册例 4 把音量与大灯连写到 0x26 是文档笔误（v0.6 遗留修正①）：音量在 0x24，
 * 本表逐键单独写，不做连续地址合并。
 */
export function settingToRegisterWrite(
  key: string,
  value: unknown,
): RegisterWrite | null {
  const checked = checkDeviceSetting(key, value);
  if (!checked.ok) return null;
  const byte =
    typeof checked.value === "boolean"
      ? checked.value
        ? 1
        : 0
      : checked.value;
  return { addr: SETTING_REGISTER[checked.key], data: [byte] };
}

/** 读回内存表用的连续区间：0x20–0x2D 共 14 字节 */
export const SETTINGS_READ_ADDR = Reg.HEARTBEAT_PERIOD;
export const SETTINGS_READ_LEN = Reg.DISCONNECT_BEEP - Reg.HEARTBEAT_PERIOD + 1;

/**
 * 头盔读回的连续字节 → 设置键值（决策 #45 上报用）。
 * 布尔寄存器 0/1 → false/true，其余原值；越界或未知地址的字节直接丢弃（头盔固件比清单新时不炸）。
 */
export function registersToSettings(
  baseAddr: number,
  bytes: number[],
): DeviceSettings {
  const out: DeviceSettings = {};
  bytes.forEach((raw, i) => {
    const key = REGISTER_SETTING.get(baseAddr + i);
    if (!key) return;
    const value = DEVICE_SETTINGS[key].kind === "bool" ? raw !== 0 : raw;
    const checked = checkDeviceSetting(key, value);
    if (checked.ok) out[key] = checked.value;
  });
  return out;
}
