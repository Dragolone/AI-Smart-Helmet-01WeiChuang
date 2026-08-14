import { randomUUID } from 'node:crypto';

/** 与 docs/EVENTS.md §1 完全一致的事件 envelope——对 Backend 而言 Mock 与真机不可区分。 */
export interface EventEnvelope {
  schemaVersion: 1;
  eventId: string;
  deviceId: string;
  eventType: string;
  timestamp: string;
  firmwareVersion: string;
  payload: Record<string, unknown>;
}

export function buildEnvelope(
  deviceId: string,
  firmwareVersion: string,
  eventType: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    deviceId,
    eventType,
    // timestamp = 设备侧事件发生时间（EVENTS.md）；receivedAt 由服务端生成
    timestamp: new Date().toISOString(),
    firmwareVersion,
    payload,
  };
}
