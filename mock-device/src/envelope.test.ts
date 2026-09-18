import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CURRENT_SCHEMA_VERSION } from '@helmet/shared';
import { buildEnvelope } from './envelope.ts';

describe('envelope：与 EVENTS.md §1 统一 envelope 对齐', () => {
  it('字段齐全：schemaVersion 取 shared 常量、eventId 为 UUID、timestamp 为 ISO 8601 UTC、payload 原样', () => {
    const before = Date.now();
    const e = buildEnvelope('helmet_test', '1.0.3', 'device_status', {
      battery: 88,
      charging: false,
      sleeping: false,
    });
    assert.equal(e.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(e.deviceId, 'helmet_test');
    assert.equal(e.firmwareVersion, '1.0.3');
    assert.equal(e.eventType, 'device_status');
    assert.match(e.eventId, /^[0-9a-f-]{36}$/);
    assert.match(e.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Date.parse(e.timestamp) >= before - 1000);
    assert.deepEqual(e.payload, { battery: 88, charging: false, sleeping: false });
  });

  it('每次生成新的 eventId（幂等去重依据不能重复）', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () =>
        buildEnvelope('helmet_test', '1.0.3', 'manual_sos', {}).eventId,
      ),
    );
    assert.equal(ids.size, 50);
  });
});
