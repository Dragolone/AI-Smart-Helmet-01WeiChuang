// 位置点入库：逐字段值域校验（EVENTS.md 4.2）、时钟错乱按收到时间、重复 eventId 幂等、其他失败只告警不抛。
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { ValidEnvelope } from '../ingest/envelope';
import type { PrismaService } from '../prisma/prisma.service';
import { LocationRecorderService } from './location-recorder.service';

const goodPayload = {
  latitude: 22.5431,
  longitude: 114.0579,
  coordinateSystem: 'gcj02',
  accuracy: 5,
  speed: 3.2,
  heading: 90,
  altitude: 12.5,
};

const env = (
  payload: Record<string, unknown>,
  timestamp = new Date(),
): ValidEnvelope => ({
  schemaVersion: 1,
  eventId: 'loc-1',
  deviceId: 'helmet_001',
  eventType: 'location_update',
  timestamp,
  firmwareVersion: '1.0.0',
  payload,
});

describe('LocationRecorderService', () => {
  const create = jest.fn();
  let svc: LocationRecorderService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    create
      .mockReset()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'p1', ...data }),
      );
    svc = new LocationRecorderService({
      locationPoint: { create },
    } as unknown as PrismaService);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('合法点：入库并返回线上格式（时间转 ISO 字符串）', async () => {
    const ts = new Date(Date.now() - 1_000);
    const p = await svc.record(env(goodPayload, ts));
    expect(p).toMatchObject({
      latitude: 22.5431,
      longitude: 114.0579,
      coordinateSystem: 'gcj02',
      altitude: 12.5,
      timestamp: ts.toISOString(),
    });
    expect(typeof p?.receivedAt).toBe('string');
  });

  it('altitude 缺失或非有限数：入库为 null，不拒整点', async () => {
    const { altitude: _drop, ...noAlt } = goodPayload;
    void _drop;
    await expect(svc.record(env(noAlt))).resolves.toMatchObject({
      altitude: null,
    });
    await expect(
      svc.record(env({ ...goodPayload, altitude: 'high' })),
    ).resolves.toMatchObject({ altitude: null });
  });

  it.each([
    ['latitude 缺失', { latitude: undefined }],
    ['latitude 是字符串', { latitude: '22.5' }],
    ['latitude 超 90', { latitude: 90.0001 }],
    ['latitude 低于 -90', { latitude: -91 }],
    ['latitude 是 NaN', { latitude: NaN }],
    ['longitude 超 180', { longitude: 180.5 }],
    ['longitude 低于 -180', { longitude: -181 }],
    ['longitude 是 Infinity', { longitude: Infinity }],
    ['coordinateSystem 未知', { coordinateSystem: 'bd09' }],
    ['coordinateSystem 缺失', { coordinateSystem: undefined }],
    ['accuracy 为负', { accuracy: -1 }],
    ['accuracy 缺失', { accuracy: undefined }],
    ['speed 为负', { speed: -0.1 }],
    ['heading 超 360', { heading: 361 }],
    ['heading 为负', { heading: -1 }],
    ['heading 缺失', { heading: undefined }],
  ])('%s：不入位置表，告警，返回 null', async (_n, patch) => {
    const r = await svc.record(env({ ...goodPayload, ...patch }));
    expect(r).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'location_update payload 不合法，不入位置表（raw 已留档）：loc-1',
    );
  });

  it.each([
    [
      '边界 latitude=±90 / longitude=±180 / heading=0 与 360',
      { latitude: -90, longitude: 180, heading: 360 },
    ],
    [
      'wgs84 坐标系',
      { coordinateSystem: 'wgs84', latitude: 90, longitude: -180, heading: 0 },
    ],
    ['accuracy / speed 为 0', { accuracy: 0, speed: 0 }],
  ])('%s：合法', async (_n, patch) => {
    await expect(
      svc.record(env({ ...goodPayload, ...patch })),
    ).resolves.not.toBeNull();
  });

  it('精确 (0,0)（「没定到位」的哨兵）现状：照常入轨迹表——与 SOS 快照把它当缺失的口径不一致，见 coverage-findings-1016.md BC1', async () => {
    await expect(
      svc.record(env({ ...goodPayload, latitude: 0, longitude: 0 })),
    ).resolves.toMatchObject({ latitude: 0, longitude: 0 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('头盔时钟报 1970：轨迹表按收到时间入库（设备原始时间只在 raw 留档）', async () => {
    const before = Date.now();
    await svc.record(env(goodPayload, new Date(0)));
    const data = (
      create.mock.calls[0] as [{ data: { timestamp: Date; receivedAt: Date } }]
    )[0].data;
    expect(data.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.timestamp).toEqual(data.receivedAt);
  });

  it('重复 eventId（P2002）：幂等返回 null，不告警', async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(svc.record(env(goodPayload))).resolves.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('其他入库失败：只告警（副表失败不影响主流程），返回 null', async () => {
    create.mockRejectedValue(new Error('numeric field overflow'));
    await expect(svc.record(env(goodPayload))).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      '位置点入库失败（raw 已留档）loc-1：numeric field overflow',
    );
  });
});
