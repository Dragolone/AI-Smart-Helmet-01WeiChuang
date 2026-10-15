import { Test } from '@nestjs/testing';
import { BindingScopeService } from './binding-scope.service';
import { DevicesService } from './devices.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DevicesService（单测，mock 数据层）', () => {
  // $transaction：回调式直接用同一个 mock 当 tx，数组式 Promise.all
  const prismaMock: {
    $transaction: jest.Mock;
    deviceBinding: { create: jest.Mock; updateMany: jest.Mock };
    device: Record<string, jest.Mock>;
  } = {
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prismaMock)
        : Promise.all(arg as Promise<unknown>[]),
    ),
    deviceBinding: { create: jest.fn(), updateMany: jest.fn() },
    device: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
  };
  let service: DevicesService;

  const baseDevice = {
    deviceId: 'helmet_001',
    bindCode: '12345678',
    bindUserId: null as string | null,
    boundAt: null,
    lastSeenAt: null,
    battery: null,
    charging: null,
    signalLevel: null,
    sleeping: false,
    firmwareVersion: null,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    // resetAllMocks 会清掉 $transaction 的实现，这里重挂
    prismaMock.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prismaMock)
        : Promise.all(arg as Promise<unknown>[]),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        DevicesService,
        BindingScopeService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = moduleRef.get(DevicesService);
  });

  it('绑定不存在的设备 → DEVICE_NOT_FOUND', async () => {
    prismaMock.device.findUnique.mockResolvedValue(null);
    await expect(service.bind('u1', 'ghost', '12345678')).rejects.toMatchObject(
      { response: { code: 'DEVICE_NOT_FOUND' } },
    );
  });

  it('绑定码错误 → BIND_CODE_INVALID，且不更新数据', async () => {
    prismaMock.device.findUnique.mockResolvedValue({ ...baseDevice });
    await expect(
      service.bind('u1', 'helmet_001', 'wrong-code'),
    ).rejects.toMatchObject({ response: { code: 'BIND_CODE_INVALID' } });
    expect(prismaMock.device.update).not.toHaveBeenCalled();
  });

  it('设备已被他人绑定 → DEVICE_ALREADY_BOUND', async () => {
    prismaMock.device.findUnique.mockResolvedValue({
      ...baseDevice,
      bindUserId: 'someone-else',
    });
    await expect(
      service.bind('u1', 'helmet_001', '12345678'),
    ).rejects.toMatchObject({ response: { code: 'DEVICE_ALREADY_BOUND' } });
  });

  it('重复绑定自己的设备 → 幂等成功，不再写库', async () => {
    prismaMock.device.findUnique.mockResolvedValue({
      ...baseDevice,
      bindUserId: 'u1',
    });
    const result = await service.bind('u1', 'helmet_001', '12345678');
    expect(result.deviceId).toBe('helmet_001');
    expect(prismaMock.device.update).not.toHaveBeenCalled();
  });

  it('首次绑定成功 → 条件更新（bindUserId 仍为空）写入 bindUserId 与 boundAt', async () => {
    prismaMock.device.findUnique.mockResolvedValue({ ...baseDevice });
    prismaMock.device.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.device.findUniqueOrThrow.mockResolvedValue({
      ...baseDevice,
      bindUserId: 'u1',
      boundAt: new Date(),
    });
    const result = await service.bind('u1', 'helmet_001', '12345678');
    expect(result.deviceId).toBe('helmet_001');
    expect(prismaMock.device.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: 'helmet_001', bindUserId: null },
        data: expect.objectContaining({ bindUserId: 'u1' }),
      }),
    );
  });

  it('并发绑定输家（条件更新命中 0 行、重读是别人）→ DEVICE_ALREADY_BOUND', async () => {
    prismaMock.device.findUnique.mockResolvedValue({ ...baseDevice });
    prismaMock.device.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.device.findUniqueOrThrow.mockResolvedValue({
      ...baseDevice,
      bindUserId: 'someone-else',
    });
    await expect(
      service.bind('u1', 'helmet_001', '12345678'),
    ).rejects.toMatchObject({
      response: { code: 'DEVICE_ALREADY_BOUND' },
    });
  });

  it('并发绑定输家但重读已是自己（同一账号连点，边界测试 B10）→ 幂等返回，不开第二段绑定区间', async () => {
    prismaMock.device.findUnique.mockResolvedValue({ ...baseDevice });
    prismaMock.device.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.device.findUniqueOrThrow.mockResolvedValue({
      ...baseDevice,
      bindUserId: 'u1',
      boundAt: new Date(),
    });
    await expect(
      service.bind('u1', 'helmet_001', '12345678'),
    ).resolves.toMatchObject({ deviceId: 'helmet_001' });
    expect(prismaMock.deviceBinding.create).not.toHaveBeenCalled();
  });

  it('查看非本人设备 → DEVICE_NOT_FOUND（不泄露存在性）', async () => {
    prismaMock.device.findUnique.mockResolvedValue({
      ...baseDevice,
      bindUserId: 'someone-else',
    });
    await expect(service.getOwned('u1', 'helmet_001')).rejects.toMatchObject({
      response: { code: 'DEVICE_NOT_FOUND' },
    });
  });

  it('在线判定：90 秒内在线，超过离线', async () => {
    prismaMock.device.findUnique.mockResolvedValue({
      ...baseDevice,
      bindUserId: 'u1',
      lastSeenAt: new Date(Date.now() - 30_000),
    });
    await expect(service.status('u1', 'helmet_001')).resolves.toMatchObject({
      online: true,
    });

    prismaMock.device.findUnique.mockResolvedValue({
      ...baseDevice,
      bindUserId: 'u1',
      lastSeenAt: new Date(Date.now() - 120_000),
    });
    await expect(service.status('u1', 'helmet_001')).resolves.toMatchObject({
      online: false,
    });
  });
});
