import { Test } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import type { ValidEnvelope } from '../ingest/envelope';
import { PrismaService } from '../prisma/prisma.service';
import {
  DeviceSnapshotService,
  normalizeDeviceStatus,
} from './device-snapshot.service';

const envelope = (over: Partial<ValidEnvelope> = {}): ValidEnvelope => ({
  schemaVersion: 1,
  eventId: 'e1',
  deviceId: 'helmet_001',
  eventType: 'device_status',
  timestamp: new Date(),
  firmwareVersion: '1.0.3',
  payload: {},
  ...over,
});

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(code, {
    code,
    clientVersion: 'test',
  });

describe('normalizeDeviceStatus（值域外按缺失，不让一个飞掉的字段拖垮整条快照）', () => {
  it.each([
    [
      { battery: 0, signalLevel: 0 },
      { battery: 0, signalLevel: 0 },
    ],
    [
      { battery: 100, signalLevel: 4 },
      { battery: 100, signalLevel: 4 },
    ],
    [{ battery: 101, signalLevel: 5 }, {}],
    [{ battery: -1, signalLevel: -1 }, {}],
    [{ battery: 55.5, signalLevel: 2.5 }, {}],
    [{ battery: '80', signalLevel: '3' }, {}],
    [{ battery: null, signalLevel: null }, {}],
    [{ charging: 1, sleeping: 'true' }, {}],
    [
      { charging: false, sleeping: true },
      { charging: false, sleeping: true },
    ],
  ])('%p → %p', (payload, expected) => {
    expect(normalizeDeviceStatus(payload)).toEqual(expected);
  });
});

describe('DeviceSnapshotService.applyEvent', () => {
  const update = jest.fn();
  const findUnique = jest.fn();
  let service: DeviceSnapshotService;

  beforeEach(async () => {
    update.mockReset();
    findUnique.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        DeviceSnapshotService,
        {
          provide: PrismaService,
          useValue: { device: { update, findUnique } },
        },
      ],
    }).compile();
    service = moduleRef.get(DeviceSnapshotService);
  });

  const dataOf = (): Record<string, unknown> =>
    (update.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;

  it('一条 update 同时刷新快照并带回绑定用户，不另查设备', async () => {
    update.mockResolvedValue({ bindUserId: 'user_1' });
    await expect(
      service.applyEvent(
        envelope({ payload: { battery: 80, charging: true, signalLevel: 3 } }),
      ),
    ).resolves.toEqual({ bindUserId: 'user_1' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: 'helmet_001' },
        select: { bindUserId: true },
      }),
    );
    expect(dataOf()).toMatchObject({
      firmwareVersion: '1.0.3',
      battery: 80,
      charging: true,
      signalLevel: 3,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('未注册设备（P2025）→ null，不建影子设备、不再查库', async () => {
    update.mockRejectedValue(prismaError('P2025'));
    await expect(service.applyEvent(envelope())).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('快照写入失败 → 退回只读查询拿绑定关系（摔倒事件的 SOS 归属不能跟着丢）', async () => {
    update.mockRejectedValue(new Error('numeric field overflow'));
    findUnique.mockResolvedValue({ bindUserId: 'user_1' });
    await expect(
      service.applyEvent(envelope({ eventType: 'possible_fall' })),
    ).resolves.toEqual({ bindUserId: 'user_1' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { deviceId: 'helmet_001' },
      select: { bindUserId: true },
    });
  });

  it('快照写入失败且设备不存在 → null', async () => {
    update.mockRejectedValue(new Error('boom'));
    findUnique.mockResolvedValue(null);
    await expect(service.applyEvent(envelope())).resolves.toBeNull();
  });

  it.each([
    ['sleep_entered', true],
    ['sleep_exited', false],
  ])('%s → sleeping=%p', async (eventType, sleeping) => {
    update.mockResolvedValue({ bindUserId: null });
    await service.applyEvent(envelope({ eventType }));
    expect(dataOf().sleeping).toBe(sleeping);
  });

  it('非 device_status 事件只刷新 lastSeenAt / 固件版本，不动电量等字段', async () => {
    update.mockResolvedValue({ bindUserId: null });
    await service.applyEvent(
      envelope({ eventType: 'location_update', payload: { battery: 5 } }),
    );
    expect(Object.keys(dataOf()).sort()).toEqual([
      'firmwareVersion',
      'lastSeenAt',
    ]);
  });
});
