// 设备状态 / 频道字段的规整（优化清单 8）：服务端只在自己出错时才会给出越界、错类型的值，但原来照单全收——
// 电量「—%」「-50%」、成员数「undefined 位」、字符串 "no" 当成「充电中」（10-22 改写应答实测）。
// 在数据进缓存的入口（接口返回、实时通道推送）规整一次，页面不用每处各防一遍。合法的值原样保留。
import type { DevicePublic, DeviceStatus, VoiceChannel } from "@helmet/shared";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? v
    : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const time = (v: unknown): string | null =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;

/** 状态字段：电量 0–100、信号非负、在线 / 休眠只认 true、充电只认布尔、时间认得出才留 */
export function normalizeStatus<T extends object>(s: T): T & DeviceStatus {
  const r = s as Record<string, unknown>;
  return {
    ...s,
    online: r.online === true,
    lastSeenAt: time(r.lastSeenAt),
    battery: num(r.battery, 0, 100),
    charging: typeof r.charging === "boolean" ? r.charging : null,
    signalLevel: num(r.signalLevel, 0, Number.MAX_SAFE_INTEGER),
    sleeping: r.sleeping === true,
    firmwareVersion: str(r.firmwareVersion),
  };
}

/** 一顶头盔（列表项 / 详情）：没有字符串设备号的不是头盔，返回 null 由调用方丢掉 */
export function normalizeDevice(d: unknown): DevicePublic | null {
  if (!isObj(d) || typeof d.deviceId !== "string" || d.deviceId === "")
    return null;
  return {
    ...normalizeStatus(d),
    deviceId: d.deviceId,
    name: str(d.name),
    bindCode: str(d.bindCode),
    boundAt: time(d.boundAt),
    createdAt: typeof d.createdAt === "string" ? d.createdAt : "",
  };
}

/** 频道：成员数不是非负整数时按 0（只影响「n 位成员」那行字），其余原样 */
export function normalizeChannel(c: VoiceChannel): VoiceChannel {
  const n = c.memberCount;
  return {
    ...c,
    memberCount: typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0,
  };
}

export const isShapedObject = isObj;
