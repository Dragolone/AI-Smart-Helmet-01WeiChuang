import { Test } from '@nestjs/testing';
import { IngestService } from './ingest.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeviceSnapshotService } from '../devices/device-snapshot.service';
import { LocationRecorderService } from '../locations/location-recorder.service';
import { MediaRecorderService } from '../media/media-recorder.service';
import { RealtimePushService } from '../realtime/realtime-push.service';
import { SosTriggerService } from '../sos/sos-trigger.service';
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

  const withField = (field: string, value: unknown): string => {
    const msg = JSON.parse(validMessage) as Record<string, unknown>;
    msg[field] = value;
    return JSON.stringify(msg);
  };

  it('大小上限按 UTF-8 字节算：恰好 65536 字节通过，多 1 字节拒绝', () => {
    const base = withField('payload', { x: '' });
    const pad = 65_536 - Buffer.byteLength(base, 'utf-8');
    const exact = withField('payload', { x: 'a'.repeat(pad) });
    expect(Buffer.byteLength(exact, 'utf-8')).toBe(65_536);
    expect(validateEnvelope(exact, 'helmet_001').ok).toBe(true);
    const over = withField('payload', { x: 'a'.repeat(pad + 1) });
    expect(validateEnvelope(over, 'helmet_001')).toEqual({
      ok: false,
      reason: 'payload_too_large',
    });
    // 3 字节的汉字按字节计：字符数没超、字节数超了同样拒绝
    const cjk = withField('payload', { x: '盔'.repeat(22_000) });
    expect(cjk.length).toBeLessThan(65_536);
    expect(validateEnvelope(cjk, 'helmet_001')).toEqual({
      ok: false,
      reason: 'payload_too_large',
    });
  });

  it('NUL 判定只认真正的 NUL 转义：成对反斜杠后的 u0000 是字面量', () => {
    // JSON 文本里：\u0000 = NUL；\\u0000 = 反斜杠 + "u0000" 六个可见字符；\\\u0000 = 反斜杠 + NUL
    const nul = withField('payload', { note: 'a\u0000b' });
    const literal = withField('payload', { note: 'a\\u0000b' });
    const backslashThenNul = withField('payload', { note: 'a\\\u0000b' });
    expect(validateEnvelope(nul, 'helmet_001')).toEqual({
      ok: false,
      reason: 'contains_nul_character',
    });
    expect(validateEnvelope(literal, 'helmet_001').ok).toBe(true);
    expect(validateEnvelope(backslashThenNul, 'helmet_001')).toEqual({
      ok: false,
      reason: 'contains_nul_character',
    });
    // 键名里的 NUL 同样拦
    const nulKey = withField('payload', { 'k\u0000': 1 });
    expect(validateEnvelope(nulKey, 'helmet_001')).toEqual({
      ok: false,
      reason: 'contains_nul_character',
    });
  });

  it.each([
    ['null', 'not_an_object'],
    ['[]', 'not_an_object'],
    ['"text"', 'not_an_object'],
    ['123', 'not_an_object'],
    ['', 'invalid_json'],
    ['\ufeff' + validMessage, 'invalid_json'],
  ])('顶层不是对象 / 空文本 / 带 BOM：%s → %s', (raw, reason) => {
    expect(validateEnvelope(raw, 'helmet_001')).toEqual({ ok: false, reason });
  });

  it.each([
    ['2024-02-29T00:00:00Z', true],
    ['2025-02-29T00:00:00Z', false],
    ['2100-02-29T00:00:00Z', false],
    ['2000-02-29T00:00:00Z', true],
    ['2026-04-31T00:00:00Z', false],
    ['2026-00-10T00:00:00Z', false],
    ['2026-01-00T00:00:00Z', false],
    ['1969-12-31T23:59:59Z', false],
    ['1970-01-01T00:00:00Z', true],
  ])(
    '日历严格校验（闰年 / 月末 / 0 月 0 日 / epoch 边界）：%s → %s',
    (ts, ok) => {
      const r = validateEnvelope(withField('timestamp', ts), 'helmet_001');
      expect(r.ok).toBe(ok);
      if (!r.ok) expect(r.reason).toBe('timestamp_out_of_range');
    },
  );

  it.each([
    ['2026-08-14T23:59:60Z'],
    ['2026-08-14T25:00:00Z'],
    ['2026-08-14T03:00:00+99:00'],
  ])('时分秒 / 偏移量越界（含闰秒 60）：%s → timestamp_unparseable', (ts) => {
    expect(validateEnvelope(withField('timestamp', ts), 'helmet_001')).toEqual({
      ok: false,
      reason: 'timestamp_unparseable',
    });
  });

  it.each([
    [-1, 'schema_version_out_of_range'],
    [2_147_483_648, 'schema_version_out_of_range'],
    [1.5, 'schema_version_missing_or_not_integer'],
    ['1', 'schema_version_missing_or_not_integer'],
    [null, 'schema_version_missing_or_not_integer'],
  ])('schemaVersion=%p → %s', (value, reason) => {
    expect(
      validateEnvelope(withField('schemaVersion', value), 'helmet_001'),
    ).toEqual({ ok: false, reason });
  });

  it('schemaVersion 上下界（0 与 int4 最大值）结构合法：是否进业务由版本白名单另判', () => {
    expect(
      validateEnvelope(withField('schemaVersion', 0), 'helmet_001').ok,
    ).toBe(true);
    expect(
      validateEnvelope(withField('schemaVersion', 2_147_483_647), 'helmet_001')
        .ok,
    ).toBe(true);
  });

  it.each([
    ['eventId', 123, 'event_id_missing'],
    ['eventId', '', 'event_id_missing'],
    ['deviceId', ['helmet_001'], 'device_id_missing'],
    ['eventType', {}, 'event_type_missing'],
    ['timestamp', 1_786_000_000, 'timestamp_missing'],
    ['firmwareVersion', '', 'firmware_version_missing'],
    ['payload', [], 'payload_missing_or_not_object'],
    ['payload', null, 'payload_missing_or_not_object'],
    ['payload', 'x', 'payload_missing_or_not_object'],
  ])('字段类型不对：%s=%p → %s', (field, value, reason) => {
    expect(validateEnvelope(withField(field, value), 'helmet_001')).toEqual({
      ok: false,
      reason,
    });
  });

  it('payload 里的 __proto__ / constructor 键只是普通数据，不污染原型', () => {
    const raw = validMessage.replace(
      '"payload":{',
      '"payload":{"__proto__":{"polluted":true},"constructor":1,',
    );
    const r = validateEnvelope(raw, 'helmet_001');
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (r.ok) {
      expect(Object.keys(r.envelope.payload)).toEqual(
        expect.arrayContaining(['__proto__', 'constructor']),
      );
    }
  });
});

describe('IngestService', () => {
  const create = jest.fn();
  const applyEvent = jest.fn();
  const record = jest.fn();
  const pushLocation = jest.fn();
  const pushDeviceStatus = jest.fn();
  const handleTrigger = jest.fn();
  const recordMedia = jest.fn();
  let service: IngestService;

  beforeEach(async () => {
    create.mockReset();
    applyEvent.mockReset().mockResolvedValue(null); // 默认未注册设备：仅 raw 留档
    record.mockReset();
    pushLocation.mockReset();
    pushDeviceStatus.mockReset();
    handleTrigger.mockReset();
    recordMedia.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        IngestService,
        {
          provide: PrismaService,
          useValue: { rawEvent: { create } },
        },
        { provide: DeviceSnapshotService, useValue: { applyEvent } },
        { provide: LocationRecorderService, useValue: { record } },
        {
          provide: RealtimePushService,
          useValue: { pushLocation, pushDeviceStatus },
        },
        { provide: SosTriggerService, useValue: { handleTrigger } },
        { provide: MediaRecorderService, useValue: { record: recordMedia } },
      ],
    }).compile();
    service = moduleRef.get(IngestService);
  });

  it('合法事件落库 → stored', async () => {
    create.mockResolvedValue({});
    await expect(
      service.ingestRaw(validMessage, 'helmet_001', 'mqtt'),
    ).resolves.toBe('stored');
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
    await expect(
      service.ingestRaw(validMessage, 'helmet_001', 'mqtt'),
    ).resolves.toBe('duplicate');
  });

  it('校验失败事件按 _invalid 落库 → stored_invalid（不丢弃）', async () => {
    create.mockResolvedValue({});
    await expect(
      service.ingestRaw('{broken', 'helmet_002', 'mqtt'),
    ).resolves.toBe('stored_invalid');
    const arg = (
      create.mock.calls[0] as [
        { data: { eventType: string; deviceId: string; payload: unknown } },
      ]
    )[0];
    expect(arg.data.eventType).toBe('_invalid');
    expect(arg.data.deviceId).toBe('helmet_002');
  });

  it('落库时写入 source 与 clock_skew（旧 timestamp 触发偏移标记）', async () => {
    create.mockResolvedValue({});
    // validMessage 的 timestamp 是固定历史时间，与"现在"偏差远超 5 分钟阈值
    await service.ingestRaw(validMessage, 'helmet_001', 'mqtt');
    const arg = (
      create.mock.calls[0] as [{ data: { source: string; clockSkew: boolean } }]
    )[0];
    expect(arg.data.source).toBe('mqtt');
    expect(arg.data.clockSkew).toBe(true);
  });

  it('新鲜 timestamp 不触发 clock_skew', async () => {
    create.mockResolvedValue({});
    const fresh = JSON.parse(validMessage) as Record<string, unknown>;
    fresh.timestamp = new Date().toISOString();
    await service.ingestRaw(JSON.stringify(fresh), 'helmet_001', 'mqtt');
    const arg = (create.mock.calls[0] as [{ data: { clockSkew: boolean } }])[0];
    expect(arg.data.clockSkew).toBe(false);
  });

  it('数据库其他异常向上抛（由调用方记日志）', async () => {
    create.mockRejectedValue(new Error('db down'));
    await expect(
      service.ingestRaw(validMessage, 'helmet_001', 'mqtt'),
    ).rejects.toThrow('db down');
  });

  it('未注册设备：仅 raw 留档，不进位置/推送', async () => {
    create.mockResolvedValue({});
    await service.ingestRaw(validMessage, 'helmet_001', 'mqtt');
    // 「注册了吗」由快照更新一并回答（未注册 → null），不再单独查一次设备
    expect(applyEvent).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
    expect(pushLocation).not.toHaveBeenCalled();
  });

  it('已注册且绑定的设备：location_update → 快照 + 位置表 + WS 推送', async () => {
    create.mockResolvedValue({});
    applyEvent.mockResolvedValue({ bindUserId: 'user_1' });
    const point = { latitude: 31.2, longitude: 121.4 };
    record.mockResolvedValue(point);
    await service.ingestRaw(validMessage, 'helmet_001', 'mqtt');
    expect(applyEvent).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(pushLocation).toHaveBeenCalledWith('user_1', 'helmet_001', point);
  });

  it('已注册但未绑定：入快照/位置表，不推送', async () => {
    create.mockResolvedValue({});
    applyEvent.mockResolvedValue({ bindUserId: null });
    record.mockResolvedValue({ latitude: 31.2 });
    await service.ingestRaw(validMessage, 'helmet_001', 'mqtt');
    expect(record).toHaveBeenCalledTimes(1);
    expect(pushLocation).not.toHaveBeenCalled();
    expect(pushDeviceStatus).not.toHaveBeenCalled();
  });

  it('位置点 payload 不合法（record 返回 null）：不推送脏数据', async () => {
    create.mockResolvedValue({});
    applyEvent.mockResolvedValue({ bindUserId: 'user_1' });
    record.mockResolvedValue(null);
    await service.ingestRaw(validMessage, 'helmet_001', 'mqtt');
    expect(pushLocation).not.toHaveBeenCalled();
  });

  it('possible_fall / manual_sos → 分发 SOS 触发器（带绑定关系）；其余事件不分发', async () => {
    create.mockResolvedValue({});
    applyEvent.mockResolvedValue({ bindUserId: 'user_1' });
    const fall = JSON.parse(validMessage) as Record<string, unknown>;
    fall.eventType = 'possible_fall';
    fall.payload = {};
    await service.ingestRaw(JSON.stringify(fall), 'helmet_001', 'mqtt');
    expect(handleTrigger).toHaveBeenCalledTimes(1);
    expect(handleTrigger.mock.calls[0][1]).toBe('user_1');

    handleTrigger.mockClear();
    await service.ingestRaw(validMessage, 'helmet_001', 'mqtt'); // location_update
    expect(handleTrigger).not.toHaveBeenCalled();
  });

  it('raw 入库只取回 id，不把整行 payload 再回传一遍', async () => {
    create.mockResolvedValue({ id: 'r1' });
    await service.ingestRaw(validMessage, 'helmet_001', 'mqtt');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true } }),
    );
  });

  it('重复 eventId 的 possible_fall：连触发器都不进（幂等在 raw 层拦截）', async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    const fall = JSON.parse(validMessage) as Record<string, unknown>;
    fall.eventType = 'possible_fall';
    await service.ingestRaw(JSON.stringify(fall), 'helmet_001', 'mqtt');
    expect(handleTrigger).not.toHaveBeenCalled();
  });
});
