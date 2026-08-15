import { Test } from '@nestjs/testing';
import { IngestService } from './ingest.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { validateEnvelope } from './envelope';

const validMessage = JSON.stringify({
  schemaVersion: 1,
  eventId: '018f6b2a-7c3e-7000-8000-000000000001',
  deviceId: 'helmet_001',
  eventType: 'location_update',
  timestamp: '2026-08-14T03:00:00Z',
  firmwareVersion: '1.0.3',
  payload: { latitude: 31.2, longitude: 121.4 },
});

describe('validateEnvelope', () => {
  it('接受合法 envelope', () => {
    const r = validateEnvelope(validMessage, 'helmet_001');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.eventId).toBe('018f6b2a-7c3e-7000-8000-000000000001');
      expect(r.envelope.timestamp.toISOString()).toBe(
        '2026-08-14T03:00:00.000Z',
      );
    }
  });

  it('拒绝非法 JSON', () => {
    const r = validateEnvelope('{not json', 'helmet_001');
    expect(r).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('拒绝 topic 与 envelope 的 deviceId 不一致（防冒名上报）', () => {
    const r = validateEnvelope(validMessage, 'helmet_999');
    expect(r).toEqual({ ok: false, reason: 'device_id_mismatch_with_topic' });
  });

  it.each([
    ['schemaVersion', 'schema_version_missing_or_not_integer'],
    ['eventId', 'event_id_missing'],
    ['eventType', 'event_type_missing'],
    ['timestamp', 'timestamp_missing'],
    ['firmwareVersion', 'firmware_version_missing'],
    ['payload', 'payload_missing_or_not_object'],
  ])('缺失必填字段 %s 时拒绝', (field, reason) => {
    const msg = JSON.parse(validMessage) as Record<string, unknown>;
    delete msg[field];
    const r = validateEnvelope(JSON.stringify(msg), 'helmet_001');
    expect(r).toEqual({ ok: false, reason });
  });

  it.each([
    ['not-a-date'],
    ['2026-08-14T03:00:00'],
    ['8/14/2026'],
    ['2026-08-14 03:00:00Z'],
  ])('拒绝无时区或非 ISO 8601 的 timestamp：%s', (ts) => {
    const msg = JSON.parse(validMessage) as Record<string, unknown>;
    msg.timestamp = ts;
    const r = validateEnvelope(JSON.stringify(msg), 'helmet_001');
    expect(r).toEqual({
      ok: false,
      reason: 'timestamp_not_iso8601_with_timezone',
    });
  });

  it('接受带偏移量时区的 timestamp', () => {
    const msg = JSON.parse(validMessage) as Record<string, unknown>;
    msg.timestamp = '2026-08-14T11:00:00+08:00';
    const r = validateEnvelope(JSON.stringify(msg), 'helmet_001');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.timestamp.toISOString()).toBe(
        '2026-08-14T03:00:00.000Z',
      );
    }
  });

  it('拒绝超过大小上限的消息', () => {
    const huge = JSON.stringify({ x: 'a'.repeat(70_000) });
    const r = validateEnvelope(huge, 'helmet_001');
    expect(r).toEqual({ ok: false, reason: 'payload_too_large' });
  });
});

describe('IngestService', () => {
  const create = jest.fn();
  let service: IngestService;

  beforeEach(async () => {
    create.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        IngestService,
        { provide: PrismaService, useValue: { rawEvent: { create } } },
      ],
    }).compile();
    service = moduleRef.get(IngestService);
  });

  it('合法事件落库 → stored', async () => {
    create.mockResolvedValue({});
    await expect(service.ingestRaw(validMessage, 'helmet_001')).resolves.toBe(
      'stored',
    );
    expect(create).toHaveBeenCalledTimes(1);
    const arg = (create.mock.calls[0] as [{ data: { eventId: string } }])[0];
    expect(arg.data.eventId).toBe('018f6b2a-7c3e-7000-8000-000000000001');
  });

  it('重复 eventId（唯一约束冲突）→ duplicate，只存一次', async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.ingestRaw(validMessage, 'helmet_001')).resolves.toBe(
      'duplicate',
    );
  });

  it('校验失败事件按 _invalid 落库 → stored_invalid（不丢弃）', async () => {
    create.mockResolvedValue({});
    await expect(service.ingestRaw('{broken', 'helmet_002')).resolves.toBe(
      'stored_invalid',
    );
    const arg = (
      create.mock.calls[0] as [
        { data: { eventType: string; deviceId: string; payload: unknown } },
      ]
    )[0];
    expect(arg.data.eventType).toBe('_invalid');
    expect(arg.data.deviceId).toBe('helmet_002');
  });

  it('数据库其他异常向上抛（由调用方记日志）', async () => {
    create.mockRejectedValue(new Error('db down'));
    await expect(service.ingestRaw(validMessage, 'helmet_001')).rejects.toThrow(
      'db down',
    );
  });
});
