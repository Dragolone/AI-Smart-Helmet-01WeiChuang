// 媒体换链接（API.md §9）：归属 = 当前绑定 + 登记时间在本人绑定区间内；未就绪 409；保留前缀不签；成功带时效。
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { BindingScopeService } from '../devices/binding-scope.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MediaService, isSignableStorageKey } from './media.service';

describe('isSignableStorageKey', () => {
  it.each([
    ['media/helmet_001/v1.mp4', true],
    ['mock/helmet_001/v1.mp4', true],
    ['backups/helmet_20261016T030000Z.dump', false],
    ['/backups/x.dump', false],
    ['///backups/x.dump', false],
    ['media/../backups/x.dump', false],
    ['..', false],
    ['media/v..1.mp4', true], // 只拦整段 ..，文件名里的点不算
    ['backupsx/y', true],
  ])('%p → %p', (key, ok) => {
    expect(isSignableStorageKey(key)).toBe(ok);
  });

  it.each([
    ['./backups/x.dump'],
    ['.//backups/x.dump'],
    ['././backups/x.dump'],
    ['/./backups/x.dump'],
    ['media/./v1.mp4'],
  ])(
    '%p 含 . 段 → 不签：COS SDK 的 simplifyPath（对齐服务端对象键合并规则）会把它归一成 /backups/…（BC2 已修）',
    (key) => {
      expect(isSignableStorageKey(key)).toBe(false);
    },
  );

  it('文件名里的点、以点开头的文件名不算 . 段', () => {
    expect(isSignableStorageKey('media/h1/.v1.mp4')).toBe(true);
    expect(isSignableStorageKey('media/h1/v1.mp4.')).toBe(true);
  });
});

describe('MediaService.getUrl', () => {
  const prisma = {
    media: { findUnique: jest.fn() },
    device: { findUnique: jest.fn() },
    deviceBinding: { findMany: jest.fn() },
  };
  const getSignedUrl = jest.fn();
  const svc = new MediaService(
    prisma as unknown as PrismaService,
    new BindingScopeService(prisma as unknown as PrismaService),
    { getSignedUrl },
  );
  const saved = process.env.MEDIA_URL_TTL_SECONDS;
  const media = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    deviceId: 'helmet_001',
    storageKey: 'media/helmet_001/v1.mp4',
    createdAt: new Date('2026-10-16T00:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MEDIA_URL_TTL_SECONDS;
    prisma.media.findUnique.mockResolvedValue(media());
    prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u1' });
    prisma.deviceBinding.findMany.mockResolvedValue([
      { boundAt: new Date('2026-10-01T00:00:00Z'), unboundAt: null },
    ]);
    getSignedUrl.mockResolvedValue('https://cos.example/signed');
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (saved === undefined) delete process.env.MEDIA_URL_TTL_SECONDS;
    else process.env.MEDIA_URL_TTL_SECONDS = saved;
  });

  const expect404 = async () => {
    const err = await svc.getUrl('u1', 'm1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toEqual({
      code: 'NOT_FOUND',
      message: '媒体不存在',
    });
    expect(getSignedUrl).not.toHaveBeenCalled();
  };

  it('成功：默认 10 分钟时效，expiresAt = 现在 + TTL', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-16T08:00:00Z') });
    await expect(svc.getUrl('u1', 'm1')).resolves.toEqual({
      url: 'https://cos.example/signed',
      expiresAt: '2026-10-16T08:10:00.000Z',
    });
    expect(getSignedUrl).toHaveBeenCalledWith('media/helmet_001/v1.mp4', 600);
  });

  it('MEDIA_URL_TTL_SECONDS 覆盖时效', async () => {
    process.env.MEDIA_URL_TTL_SECONDS = '30';
    await svc.getUrl('u1', 'm1');
    expect(getSignedUrl).toHaveBeenCalledWith(expect.any(String), 30);
  });

  it('媒体不存在：404', async () => {
    prisma.media.findUnique.mockResolvedValue(null);
    await expect404();
  });

  it('设备不归本人（或设备行没了）：404，连绑定区间都不查', async () => {
    prisma.device.findUnique.mockResolvedValue({ bindUserId: 'u2' });
    await expect404();
    prisma.device.findUnique.mockResolvedValue(null);
    await expect404();
    expect(prisma.deviceBinding.findMany).not.toHaveBeenCalled();
  });

  it('媒体登记在本人绑定之前（前主期间的视频）：404', async () => {
    prisma.media.findUnique.mockResolvedValue(
      media({ createdAt: new Date('2026-09-01T00:00:00Z') }),
    );
    await expect404();
  });

  it('还没 storageKey：409 MEDIA_NOT_READY', async () => {
    prisma.media.findUnique.mockResolvedValue(media({ storageKey: null }));
    const err = await svc.getUrl('u1', 'm1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'MEDIA_NOT_READY',
    });
  });

  it('storageKey 指向备份前缀：按不存在 404 并告警，不签名', async () => {
    prisma.media.findUnique.mockResolvedValue(
      media({ storageKey: 'backups/helmet_20261016T030000Z.dump' }),
    );
    await expect404();
  });

  it('存储签名失败：原样抛出（统一过滤器转 500）', async () => {
    getSignedUrl.mockRejectedValue(new Error('COS 签名链接生成失败'));
    await expect(svc.getUrl('u1', 'm1')).rejects.toThrow(
      'COS 签名链接生成失败',
    );
  });
});
