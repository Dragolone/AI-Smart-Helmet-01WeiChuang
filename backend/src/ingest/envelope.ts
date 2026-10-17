import { randomUUID } from 'node:crypto';

/** 统一事件 envelope（docs/EVENTS.md §1）。业务模块只见校验后的 ValidEnvelope，不感知来源。 */
export interface ValidEnvelope {
  schemaVersion: number;
  eventId: string;
  deviceId: string;
  eventType: string;
  timestamp: Date;
  firmwareVersion: string | null;
  payload: Record<string, unknown>;
}

/** 已落库的 envelope：带上服务器生成并写进库的收到时间（WS 推送与列表按同一个值算业务时间） */
export type StoredEnvelope = ValidEnvelope & { receivedAt: Date };

export type EnvelopeResult =
  { ok: true; envelope: ValidEnvelope } | { ok: false; reason: string };

/**
 * 服务端能正确解释的事件结构版本（EVENTS.md §1「当前固定 1」）。
 * 结构合法但版本未知的事件只进原始表并告警、不进业务流程（DEVICE_PROTOCOL §9），
 * 否则未来升版本后旧后端会用错误语义处理新事件（审计 INGEST-01）。
 */
export const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

/** PostgreSQL text/jsonb 不接受原始 NUL：留档前把它改写成可见的转义形式，留档本身不能再失败（审计 INGEST-03） */
const printableRaw = (raw: string): string =>
  raw.split('\u0000').join('\\u0000');

/**
 * 校验失败的事件也必须落库（EVENTS.md §2），此处为它构造一条可入库的替身记录：
 * eventType 固定 `_invalid`，原始内容与失败原因放进 payload 供排查。
 */
export function buildInvalidRecord(
  topicDeviceId: string | null,
  raw: string,
  reason: string,
): ValidEnvelope {
  return {
    schemaVersion: 0,
    eventId: `invalid_${randomUUID()}`,
    deviceId: topicDeviceId ?? 'unknown',
    eventType: '_invalid',
    timestamp: new Date(),
    firmwareVersion: null,
    // 恶意超长消息不能整条进库，截断留证足够排查
    payload: { reason, raw: printableRaw(raw).slice(0, 4096) },
  };
}

/** 单条消息上限（EMQX 默认包上限 1MB，业务事件远小于此；超限按无效留档防 DoS） */
export const MAX_RAW_BYTES = 65_536;

/** EVENTS.md §1：timestamp 必须为 ISO 8601 且带显式时区（Z 或 ±hh:mm）。
 *  缺时区的字符串 JS 会按服务器本地时区解释，导致静默偏移数小时落库。
 *  小数秒不限 3 位：ISO 8601 允许任意位，Python isoformat / Go RFC3339Nano 默认是 6 / 9 位，
 *  只收 3 位会让这类上游的摔倒事件整条进 _invalid、不建单（边界测试 B4）；Date 解析时截到毫秒 */
const ISO8601_WITH_TZ =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** raw_events.schema_version 是 int4：超出范围的值入库必炸，在校验层挡住 */
const INT32_MAX = 2_147_483_647;
/** 设备时钟最早只可能回到 epoch（1970）；年份 0000 之类 PostgreSQL 直接拒绝 */
const MIN_YEAR = 1970;
/** PostgreSQL timestamp 能存、JS Date 能读回的上限年份 */
const MAX_YEAR = 9999;

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * JSON 文本里的 NUL 转义（反斜杠 + u0000）：PostgreSQL text/jsonb 都不接受，入库必炸。
 * 前面成对的反斜杠要先跳过——两个反斜杠 + u0000 是「字面量反斜杠后跟 u0000」六个可见字符，不是 NUL，不能误拒。
 */
const hasNul = (raw: string): boolean => /(?<!\\)(?:\\\\)*\\u0000/i.test(raw);

export function validateEnvelope(
  raw: string,
  topicDeviceId: string,
): EnvelopeResult {
  if (Buffer.byteLength(raw, 'utf-8') > MAX_RAW_BYTES) {
    return { ok: false, reason: 'payload_too_large' };
  }
  if (hasNul(raw)) {
    return { ok: false, reason: 'contains_nul_character' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_an_object' };
  }
  const o = parsed as Record<string, unknown>;

  if (
    typeof o.schemaVersion !== 'number' ||
    !Number.isInteger(o.schemaVersion)
  ) {
    return { ok: false, reason: 'schema_version_missing_or_not_integer' };
  }
  if (o.schemaVersion < 0 || o.schemaVersion > INT32_MAX) {
    return { ok: false, reason: 'schema_version_out_of_range' };
  }
  if (typeof o.eventId !== 'string' || o.eventId.length === 0) {
    return { ok: false, reason: 'event_id_missing' };
  }
  if (typeof o.deviceId !== 'string' || o.deviceId.length === 0) {
    return { ok: false, reason: 'device_id_missing' };
  }
  // 设备只能以自己的身份上报（DEVICE_PROTOCOL §4 ACL 原则的应用层兜底）
  if (o.deviceId !== topicDeviceId) {
    return { ok: false, reason: 'device_id_mismatch_with_topic' };
  }
  if (typeof o.eventType !== 'string' || o.eventType.length === 0) {
    return { ok: false, reason: 'event_type_missing' };
  }
  if (typeof o.timestamp !== 'string') {
    return { ok: false, reason: 'timestamp_missing' };
  }
  const tsMatch = ISO8601_WITH_TZ.exec(o.timestamp);
  if (!tsMatch) {
    return { ok: false, reason: 'timestamp_not_iso8601_with_timezone' };
  }
  const [year, month, day] = [tsMatch[1], tsMatch[2], tsMatch[3]].map(Number);
  // JS Date 会把 02-30 静默回滚成 03-02，设备侧日期 bug 会被掩盖；这里按日历严格校验
  if (
    year < MIN_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }
  const ts = new Date(o.timestamp);
  if (Number.isNaN(ts.getTime())) {
    return { ok: false, reason: 'timestamp_unparseable' };
  }
  // 上面按字面校验的是本地日期；换算到 UTC 后可能跨进 10000 年（9999-12-31T24:00:00Z、…23:59:59-01:00）——
  // PostgreSQL 照收，Prisma 读回来是 Invalid Date，之后这台设备的事件 / 求救 / 事故列表一读就 500，扫描循环也会被打断（10-17 评审）
  const utcYear = ts.getUTCFullYear();
  if (utcYear < MIN_YEAR || utcYear > MAX_YEAR) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }
  // EVENTS.md §1：firmwareVersion 为必填字段
  if (typeof o.firmwareVersion !== 'string' || o.firmwareVersion.length === 0) {
    return { ok: false, reason: 'firmware_version_missing' };
  }
  const payload = o.payload;
  if (
    payload === undefined ||
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return { ok: false, reason: 'payload_missing_or_not_object' };
  }

  return {
    ok: true,
    envelope: {
      schemaVersion: o.schemaVersion,
      eventId: o.eventId,
      deviceId: o.deviceId,
      eventType: o.eventType,
      timestamp: ts,
      firmwareVersion: o.firmwareVersion,
      payload: payload as Record<string, unknown>,
    },
  };
}
