// 工程模式的帧描述（纯函数，可单测）：把一帧字节翻成硬件工程师一眼能对的一句话。
// 只做展示、不进业务；解析口径与 protocol.ts 一致——字节流为准（手册十进制标注有误处以字节为准，
// DEVICE_PROTOCOL §10 第 6 条）。
import type { DeviceSettingKey } from "@helmet/shared";
import { DEVICE_SETTINGS } from "@helmet/shared";

import { asciiZ, bytesToHex, readI32, readU16, readU32 } from "./bytes";
import {
  ERROR_NAMES,
  EVENT_CODE_TO_TYPE,
  HIGH_RISK_CODES,
  Ins,
  Reg,
  SETTING_REGISTER,
  parseInbound,
  translateEvent,
} from "./protocol";

export const INS_NAMES: Record<number, string> = {
  [Ins.PING]: "PING",
  [Ins.READ]: "READ",
  [Ins.WRITE]: "WRITE",
  [Ins.TIME_SYNC]: "TIME SYNC",
  [Ins.EVENT]: "EVENT",
  [Ins.ACK]: "ACK",
  [Ins.RESEND_QUERY]: "RESEND QUERY",
  [Ins.RESEND_DATA]: "RESEND DATA",
  [Ins.RECOVERY]: "RECOVERY",
  [Ins.RESET]: "RESET",
};

/** 内存控制表地址 → 名称（手册 §2.0）；0x20–0x2D 直接用设置键名 */
const REG_NAMES = new Map<number, string>([
  [Reg.FW_MAJOR, "fwMajor"],
  [Reg.FW_MINOR, "fwMinor"],
  [Reg.FW_PATCH, "fwPatch"],
  [0x10, "battery"],
  [0x11, "charging"],
  [0x12, "latitude"],
  [0x16, "longitude"],
  [Reg.EVENT_SEQ_BASE, "eventSeqBase"],
  [Reg.DEVICE_ID, "deviceId"],
  [0x50, "deviceSecret"],
]);
for (const key of Object.keys(SETTING_REGISTER) as DeviceSettingKey[]) {
  REG_NAMES.set(SETTING_REGISTER[key], key);
}

const hex2 = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

export const regName = (addr: number): string =>
  REG_NAMES.get(addr) ?? hex2(addr);

export const eventName = (code: number): string =>
  EVENT_CODE_TO_TYPE[code] ?? `未知事件 ${hex2(code)}`;

const isoOf = (utcSeconds: number) =>
  new Date(utcSeconds * 1000).toISOString().replace(".000Z", "Z");

/** 一段寄存器字节 → `key=值` 列表（0x20–0x2D 之外的地址按 hex 名） */
function describeRegisters(addr: number, data: Uint8Array): string {
  return Array.from(data, (b, i) => `${regName(addr + i)}=${b}`).join(" ");
}

/** App → 头盔（§1.1 [指令码][Seq][参数…]） */
export function describeOutbound(bytes: Uint8Array): string {
  if (bytes.length < 2) return `帧太短（${bytes.length} 字节）`;
  const [ins, seq] = bytes;
  const p = bytes.subarray(2);
  switch (ins) {
    case Ins.PING:
      return `PING seq=${seq}`;
    case Ins.READ:
      // 短帧正是测头盔 ERR_LENGTH 要发的东西，描述不能先于头盔倒下
      if (p.length < 2) return `READ seq=${seq}（参数不足 2 字节）`;
      return `READ ${hex2(p[0])} ${regName(p[0])} 长度 ${p[1]}`;
    case Ins.WRITE: {
      if (p.length < 1) return `WRITE seq=${seq}（缺寄存器地址）`;
      const data = p.subarray(1);
      if (data.length === 0)
        return `WRITE ${hex2(p[0])} ${regName(p[0])}（无数据）`;
      const multi = data.length > 1 ? `（连写 ${data.length} 字节）` : "";
      return `WRITE ${hex2(p[0])} ${describeRegisters(p[0], data)}${multi}`;
    }
    case Ins.TIME_SYNC: {
      if (p.length < 4) return `TIME SYNC seq=${seq}（参数不足 4 字节）`;
      const utc = readU32(p, 0);
      return `TIME SYNC ${utc}（${isoOf(utc)}）`;
    }
    case Ins.ACK:
      // ACK 无流水号：[0x06][Event_Code][Event_Seq 4B][0x00]
      if (bytes.length < 7) return "ACK（帧长不足 7 字节）";
      return `ACK ${eventName(bytes[1])} seq=${readU32(bytes, 2)}`;
    case Ins.RESEND_QUERY:
      return `RESEND QUERY seq=${seq}`;
    case Ins.RESEND_DATA:
      return `RESEND DATA 偏移 ${readU16(p, 0)} 条数 ${p[2] ?? 0}`;
    case Ins.RECOVERY:
      return `RECOVERY seq=${seq}（恢复出厂参数）`;
    case Ins.RESET:
      return `RESET seq=${seq}${p.length ? ` 参数 ${hex2(p[0])}` : ""}`;
    default:
      return `未知指令 ${hex2(ins)} seq=${seq}`;
  }
}

export interface InboundDescription {
  kind: "response" | "event" | "unknown";
  text: string;
  /** 应答帧的 ERROR 字节（0 = OK） */
  error?: number;
  eventCode?: number;
  eventSeq?: number;
  highRisk?: boolean;
}

/** 应答帧的数据段按「当初发的是什么」解释；request = 同 Seq 的下行帧（工程模式按 Seq 配对） */
function describeResponseData(
  ins: number,
  data: Uint8Array,
  request?: Uint8Array,
): string {
  if (data.length === 0) return "";
  if (ins === Ins.READ && request && request.length >= 4) {
    const addr = request[2];
    if (addr === Reg.DEVICE_ID) return `deviceId "${asciiZ(data)}"`;
    if (addr === Reg.FW_MAJOR && data.length >= 3)
      return `固件 ${data[0]}.${data[1]}.${data[2]}`;
    if (addr === 0x10 && data.length >= 10) {
      const lat = readI32(data, 2) / 1e6;
      const lon = readI32(data, 6) / 1e6;
      return `电量 ${data[0]}% ${data[1] === 1 ? "充电中" : "未充电"} 纬度 ${lat} 经度 ${lon}`;
    }
    return describeRegisters(addr, data);
  }
  if (ins === Ins.RESEND_QUERY && data.length >= 2)
    return `离线事件 ${readU16(data, 0)} 条`;
  if (ins === Ins.RESEND_DATA) return `实际 ${data[0]} 条`;
  return `数据 ${bytesToHex(data)}`;
}

const num = (v: unknown, digits = 2) =>
  typeof v === "number" ? String(Number(v.toFixed(digits))) : String(v);

function describeEventPayload(
  code: number,
  payload: Record<string, unknown> | null,
  raw: Uint8Array,
): string {
  if (!payload) return `载荷 ${bytesToHex(raw)}（未翻译：长度不符或无定位）`;
  // 摔倒 / 求救的载荷不足 11 字节时 App 照样上报（缺的字段省略），但对固件来说这是个要修的问题，联调页说清楚
  if ((code === 0x01 || code === 0x02) && raw.length < 11)
    return `载荷 ${bytesToHex(raw)}（长度不足：应为 11 字节，实收 ${raw.length}；App 仍会上报该事件，缺的字段省略）`;
  const loc = payload.location as
    { latitude: number; longitude: number } | undefined;
  const at = loc ? ` 位置 ${loc.latitude},${loc.longitude}` : "";
  switch (code) {
    case 0x01:
      return `置信度 ${num((payload.confidence as number) * 100, 0)}% 冲击 ${num(payload.impactG, 1)} g 倾角 ${payload.tiltDeg}°${at}`;
    case 0x02:
      return `${payload.triggerMode} 按压 ${payload.pressDurationMs} ms${at}`;
    case 0x03:
    case 0x04:
      return `${payload.riskLevel} ${payload.objectType} ${payload.direction ?? "?"} 距离 ${num(payload.distance, 1)} m TTC ${num(payload.ttcSeconds, 1)} s 逼近 ${payload.approachSpeedKmh} km/h${at}`;
    case 0x05:
      return payload.clearedEventId ? "清除指定事件" : "清除全部风险";
    case 0x06:
      return `${payload.latitude},${payload.longitude} 速度 ${num(payload.speed, 1)} m/s 航向 ${num(payload.heading, 1)}° 精度 ${payload.accuracy} m${payload.altitude !== undefined ? ` 海拔 ${payload.altitude} m` : ""}`;
    case 0x07:
      return `电量 ${payload.battery}% ${payload.charging ? "充电中" : "未充电"}`;
    default:
      return bytesToHex(raw);
  }
}

/** 头盔 → App（§1.2 应答 / §1.3 事件） */
export function describeInbound(
  bytes: Uint8Array,
  request?: Uint8Array,
  receivedAt: Date = new Date(),
): InboundDescription {
  const frame = parseInbound(bytes);
  if (!frame)
    return { kind: "unknown", text: `无法解析（${bytes.length} 字节）` };
  if (frame.kind === "response") {
    const name = INS_NAMES[frame.ins] ?? `未知指令 ${hex2(frame.ins)}`;
    const err = ERROR_NAMES[frame.error] ?? `ERR_${hex2(frame.error)}`;
    const data = describeResponseData(frame.ins, frame.data, request);
    return {
      kind: "response",
      error: frame.error,
      text: `应答 ${name} seq=${frame.seq} · ${err}${data ? ` · ${data}` : ""}`,
    };
  }
  const envelope = translateEvent(frame, {
    deviceId: "bench",
    firmwareVersion: "bench",
    receivedAt,
  });
  const payload = (envelope?.payload ?? null) as Record<string, unknown> | null;
  const when = frame.timestamp === 0 ? "未校时" : isoOf(frame.timestamp);
  return {
    kind: "event",
    eventCode: frame.code,
    eventSeq: frame.eventSeq,
    highRisk: HIGH_RISK_CODES.has(frame.code),
    text: `事件 ${eventName(frame.code)} seq=${frame.eventSeq} · ${when} · ${describeEventPayload(frame.code, payload, frame.payload)}`,
  };
}

/** 解析用户手输的 hex（允许空格、逗号、0x 前缀）；非法或不足 2 字节返回 null */
export function parseHexInput(input: string): Uint8Array | null {
  const clean = input.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length < 4 || clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 设置键的取值范围提示（写越界用例要知道上限） */
export const settingRange = (key: DeviceSettingKey): string => {
  const spec = DEVICE_SETTINGS[key];
  return spec.kind === "bool" ? "0/1" : `${spec.min}–${spec.max}`;
};
