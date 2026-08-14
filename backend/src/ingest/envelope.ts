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

export type EnvelopeResult =
  { ok: true; envelope: ValidEnvelope } | { ok: false; reason: string };

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
    payload: { reason, raw: raw.slice(0, 4096) },
  };
}

export function validateEnvelope(
  raw: string,
  topicDeviceId: string,
): EnvelopeResult {
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
  const ts = new Date(o.timestamp);
  if (Number.isNaN(ts.getTime())) {
    return { ok: false, reason: 'timestamp_unparseable' };
  }
  if (
    o.firmwareVersion !== undefined &&
    typeof o.firmwareVersion !== 'string'
  ) {
    return { ok: false, reason: 'firmware_version_not_string' };
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
      firmwareVersion: o.firmwareVersion ?? null,
      payload: payload as Record<string, unknown>,
    },
  };
}
