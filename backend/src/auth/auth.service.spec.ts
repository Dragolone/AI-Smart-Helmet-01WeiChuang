import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsCodeService } from './sms-code.service';

describe('AuthService（单测，mock 数据层）', () => {
  const prismaMock = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    refreshToken: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const smsCodesMock = {
    issue: jest.fn(),
    verifyAndConsume: jest.fn(),
  };
  let service: AuthService;

  beforeEach(async () => {
    jest.resetAllMocks();
    prismaMock.$transaction.mockImplementation((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: SmsCodeService, useValue: smsCodesMock },
        {
          provide: JwtService,
          useValue: { signAsync: jest.fn().mockResolvedValue('signed.jwt') },
        },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('注册重复手机号 → PHONE_ALREADY_REGISTERED，且不消费验证码', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1' });
    await expect(
      service.register('13800138000', '123456', 'password123'),
    ).rejects.toMatchObject({
      response: { code: 'PHONE_ALREADY_REGISTERED' },
    });
    expect(smsCodesMock.verifyAndConsume).not.toHaveBeenCalled();
  });

  it('注册：验证码错误 → 透传 SMS_CODE_INVALID，不建用户', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    smsCodesMock.verifyAndConsume.mockRejectedValue(
      Object.assign(new Error('bad'), {
        response: { code: 'SMS_CODE_INVALID' },
      }),
    );
    await expect(
      service.register('13800138000', '000000', 'password123'),
    ).rejects.toMatchObject({ response: { code: 'SMS_CODE_INVALID' } });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('注册：验证码通过 → 建用户并签发 token 对', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    smsCodesMock.verifyAndConsume.mockResolvedValue(undefined);
    prismaMock.user.create.mockResolvedValue({
      id: 'u1',
      phone: '13800138000',
      nickname: null,
      avatarUrl: null,
      createdAt: new Date(),
    });
    prismaMock.refreshToken.create.mockResolvedValue({});
    const res = await service.register('13800138000', '123456', 'password123');
    expect(smsCodesMock.verifyAndConsume).toHaveBeenCalledWith(
      '13800138000',
      'register',
      '123456',
    );
    expect(res.user.phone).toBe('13800138000');
    expect(res.accessToken).toBe('signed.jwt');
    expect(res.refreshToken).toBeTruthy();
  });

  it('sendSmsCode：register 用途拒绝已注册号；reset_password 用途拒绝未注册号', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1' });
    await expect(
      service.sendSmsCode('13800138000', 'register'),
    ).rejects.toMatchObject({
      response: { code: 'PHONE_ALREADY_REGISTERED' },
    });
    prismaMock.user.findUnique.mockResolvedValue(null);
    await expect(
      service.sendSmsCode('13800138000', 'reset_password'),
    ).rejects.toMatchObject({
      response: { code: 'PHONE_NOT_REGISTERED' },
    });
    expect(smsCodesMock.issue).not.toHaveBeenCalled();
  });

  it('sendSmsCode：状态匹配 → 交给 SmsCodeService 下发', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    smsCodesMock.issue.mockResolvedValue(undefined);
    await service.sendSmsCode('13800138000', 'register');
    expect(smsCodesMock.issue).toHaveBeenCalledWith('13800138000', 'register');
  });

  it('resetPassword：改密并撤销全部会话', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1' });
    smsCodesMock.verifyAndConsume.mockResolvedValue(undefined);
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 3 });
    await service.resetPassword('13800138000', '123456', 'newpassword1');
    expect(smsCodesMock.verifyAndConsume).toHaveBeenCalledWith(
      '13800138000',
      'reset_password',
      '123456',
    );
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' } }),
    );
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', revokedAt: null } }),
    );
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

  it('refresh：已撤销 token 过了并发窗口再复用 → 撤销该用户全部会话', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      userId: 'u1',
      revokedAt: new Date(Date.now() - 60_000),
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
