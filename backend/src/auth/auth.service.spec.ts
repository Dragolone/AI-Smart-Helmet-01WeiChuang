import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsCodeService } from './sms-code.service';

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

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

  it('refresh：已撤销 token 过了 15 分钟补发窗口再复用 → 撤销该用户全部会话', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      userId: 'u1',
      revokedAt: new Date(Date.now() - 20 * 60_000),
      expiresAt: new Date(Date.now() + 1000),
      user: { deletedAt: null },
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

  it('refresh：正常轮换时在旧 token 上记下替代它的新 token', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'old',
      userId: 'u1',
      revokedAt: null,
      replacedById: null,
      expiresAt: new Date(Date.now() + 1000),
      user: { deletedAt: null },
    });
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.refreshToken.create.mockResolvedValue({ id: 'new' });
    const pair = await service.refresh('old-token');
    expect(pair.accessToken).toBe('signed.jwt');
    expect(prismaMock.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'old' },
      data: { replacedById: 'new' },
    });
  });

  it('refresh：旧 token 在补发窗口内再来，替代它的新 token 从没用过 → 作废那张、补发一对，不撤销全部会话、不再记替代者', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'old',
      userId: 'u1',
      revokedAt: new Date(Date.now() - 30_000),
      replacedById: 'child',
      expiresAt: new Date(Date.now() + 1000),
      user: { deletedAt: null },
    });
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.refreshToken.create.mockResolvedValue({ id: 'new' });
    const pair = await service.refresh('old-token');
    expect(pair.accessToken).toBe('signed.jwt');
    expect(typeof pair.refreshToken).toBe('string');
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'child', revokedAt: null } }),
    );
    expect(prismaMock.refreshToken.update).not.toHaveBeenCalled();
  });

  it('refresh：补发窗口内再来，但新 token 已被用过（或已补发过一次）→ UNAUTHORIZED，不撤销全部会话、不签发', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'old',
      userId: 'u1',
      revokedAt: new Date(Date.now() - 30_000),
      replacedById: 'child',
      expiresAt: new Date(Date.now() + 1000),
      user: { deletedAt: null },
    });
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.refresh('old-token')).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1', revokedAt: null } }),
    );
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('refresh：登出作废的 token（没有替代者）在补发窗口内再来 → UNAUTHORIZED，不补发', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'old',
      userId: 'u1',
      revokedAt: new Date(Date.now() - 30_000),
      replacedById: null,
      expiresAt: new Date(Date.now() + 1000),
      user: { deletedAt: null },
    });
    await expect(service.refresh('old-token')).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('refresh：并发窗口（10 s）内再来 → UNAUTHORIZED，既不补发也不撤销', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      id: 'old',
      userId: 'u1',
      revokedAt: new Date(Date.now() - 2_000),
      replacedById: 'child',
      expiresAt: new Date(Date.now() + 1000),
      user: { deletedAt: null },
    });
    await expect(service.refresh('old-token')).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.refreshToken.create).not.toHaveBeenCalled();
  });

  it('refresh：过期 token → UNAUTHORIZED 且不轮换', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      userId: 'u1',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      user: { deletedAt: null },
    });
    await expect(service.refresh('expired')).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
    expect(prismaMock.refreshToken.update).not.toHaveBeenCalled();
  });

  it('refresh：已注销用户的 token → UNAUTHORIZED 且不轮换', async () => {
    prismaMock.refreshToken.findUnique.mockResolvedValue({
      userId: 'u1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 1000),
      user: { deletedAt: new Date() },
    });
    await expect(service.refresh('deleted')).rejects.toMatchObject({
      response: { code: 'UNAUTHORIZED' },
    });
    expect(prismaMock.refreshToken.update).not.toHaveBeenCalled();
  });

  it('sendSmsCode：change_phone 用途下新号已注册 → PHONE_ALREADY_REGISTERED', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u2' });
    await expect(
      service.sendSmsCode('13800138000', 'change_phone'),
    ).rejects.toMatchObject({
      response: { code: 'PHONE_ALREADY_REGISTERED' },
    });
    expect(smsCodesMock.issue).not.toHaveBeenCalled();
  });

  it('changePassword：旧密码错误 → PASSWORD_INCORRECT，不改密不撤销', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      passwordHash: await bcrypt.hash('correct_pw_1', 4),
      deletedAt: null,
    });
    await expect(
      service.changePassword('u1', 'wrong_pw_1', 'new_password_1'),
    ).rejects.toMatchObject({ response: { code: 'PASSWORD_INCORRECT' } });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(prismaMock.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('changePassword：改密并撤销其他会话，保留传入的 refreshToken', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      passwordHash: await bcrypt.hash('correct_pw_1', 4),
      deletedAt: null,
    });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    await service.changePassword(
      'u1',
      'correct_pw_1',
      'new_password_1',
      'keep',
    );
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'u1',
          revokedAt: null,
          tokenHash: { not: hashToken('keep') },
        },
      }),
    );
  });

  it('changePhone：新号已注册 → PHONE_ALREADY_REGISTERED，不消费验证码', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u2' });
    await expect(
      service.changePhone('u1', '13900139000', '123456'),
    ).rejects.toMatchObject({
      response: { code: 'PHONE_ALREADY_REGISTERED' },
    });
    expect(smsCodesMock.verifyAndConsume).not.toHaveBeenCalled();
  });

  it('changePhone：验证码通过 → 改号并返回安全用户对象', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    smsCodesMock.verifyAndConsume.mockResolvedValue(undefined);
    prismaMock.user.update.mockResolvedValue({
      id: 'u1',
      phone: '13900139000',
      passwordHash: 'x',
      nickname: null,
      avatarUrl: null,
      createdAt: new Date(),
    });
    const res = await service.changePhone('u1', '13900139000', '123456');
    expect(smsCodesMock.verifyAndConsume).toHaveBeenCalledWith(
      '13900139000',
      'change_phone',
      '123456',
    );
    expect(res).toEqual(expect.objectContaining({ phone: '13900139000' }));
    expect(res).not.toHaveProperty('passwordHash');
  });
});
