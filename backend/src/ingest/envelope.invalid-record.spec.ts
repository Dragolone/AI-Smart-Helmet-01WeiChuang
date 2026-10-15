// 校验失败事件的替身记录（EVENTS.md §2：失败也必须落库）：未知设备、NUL 转义、超长截断。
import { buildInvalidRecord } from './envelope';

describe('buildInvalidRecord', () => {
  it('拿不到设备号（如 webhook 解析不出）：deviceId 记 unknown；eventType 固定 _invalid、eventId 带 invalid_ 前缀', () => {
    const r = buildInvalidRecord(null, '{bad', 'invalid_json');
    expect(r).toMatchObject({
      schemaVersion: 0,
      deviceId: 'unknown',
      eventType: '_invalid',
      firmwareVersion: null,
      payload: { reason: 'invalid_json', raw: '{bad' },
    });
    expect(r.eventId).toMatch(/^invalid_[0-9a-f-]{36}$/);
    expect(buildInvalidRecord(null, '', 'x').eventId).not.toBe(r.eventId);
  });

  it('原文里的 NUL 改写成可见的 \\u0000（PostgreSQL text/jsonb 不收 NUL），超长原文截到 4096 字符', () => {
    const r = buildInvalidRecord('helmet_001', 'a\u0000b', 'nul');
    expect(r.payload.raw).toBe('a\\u0000b');
    const long = buildInvalidRecord(
      'helmet_001',
      'x'.repeat(10_000),
      'too_big',
    );
    expect((long.payload.raw as string).length).toBe(4096);
    expect(long.deviceId).toBe('helmet_001');
  });
});
