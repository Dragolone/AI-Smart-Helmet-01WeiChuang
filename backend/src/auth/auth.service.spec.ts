import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuthService（单测，mock 数据层）', () => {
  const prismaMock = {
    user: { findUnique: jest.fn(), create: jest.fn() },
    refreshToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  let service: AuthService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: JwtService,
          useValue: { signAsync: jest.fn().mockResolvedValue('signed.jwt') },
        },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('注册重复手机号 → PHONE_ALREADY_REGISTERED', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1' });
    await expect(
      service.register('13800138000', 'password123'),
    ).rejects.toMatchObject({
      response: { code: 'PHONE_ALREADY_REGISTERED' },
    });
  });

  it('登录：手机号不存在与密码错误报同一错误', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(
      service.login('13800138000', 'x'.repeat(8)),
    ).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
  });

  it('refresh：token 不存在 → UNAUTHORIZED', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue(null);
    await expect(service.refresh('nope')).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
  });

  it('refresh：已撤销 token 复用 → 撤销该用户全部会话', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      userId: 'u1',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    });
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 2 });
    await expect(service.refresh('stolen')).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', revokedAt: null },
      }),
    );
  });

  it('refresh：过期 token → UNAUTHORIZED 且不轮换', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      userId: 'u1',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(service.refresh('expired')).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
    expect(prismaMock.refreshToken.update).not.toHaveBeenCalled();
  });
});
