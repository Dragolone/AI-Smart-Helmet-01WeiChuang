import { randomUUID } from 'node:crypto';
import {
  CURRENT_SCHEMA_VERSION,
  type EventEnvelope,
  type EventPayloadMap,
  type EventType,
} from '@helmet/shared';

/** envelope 结构与类型来自 @helmet/shared（EVENTS.md §1）——对 Backend 而言 Mock 与真机不可区分。 */
export function buildEnvelope<T extends EventType>(
  deviceId: string,
  firmwareVersion: string,
  eventType: T,
  payload: EventPayloadMap[T],
): EventEnvelope<T> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    deviceId,
    eventType,
    // timestamp = 设备侧事件发生时间（EVENTS.md）；receivedAt 由服务端生成
    timestamp: new Date().toISOString(),
    firmwareVersion,
    payload,
  };
}
