// AuthService 剩余分支：注册 / 换号撞唯一约束与其他数据库错误、找回密码未注册、校验密码的三种失败、改密是否保留当前设备。
import { Logger } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { SmsCodeService } from './sms-code.service';

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('AuthService：剩余分支', () => {
  const prisma = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    refreshToken: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((arg: unknown): Promise<unknown> =>
      typeof arg === 'function'
        ? (arg as (t: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  const smsCodes = { verifyAndConsume: jest.fn() };
  let svc: AuthService;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await bcrypt.hash('old-password', 4);
  });

  beforeEach(() => {
    for (const fn of [
      ...Object.values(prisma.user),
      ...Object.values(prisma.refreshToken),
      smsCodes.verifyAndConsume,
    ])
      fn.mockReset();
    prisma.$transaction.mockClear();
    prisma.refreshToken.updateMany.mockImplementation((arg: unknown) =>
      Promise.resolve(arg),
    );
    prisma.user.update.mockImplementation((arg: unknown) =>
      Promise.resolve(arg),
    );
    svc = new AuthService(
      prisma as unknown as PrismaService,
      {
        signAsync: jest.fn(() => Promise.resolve('jwt')),
      } as unknown as JwtService,
      smsCodes as unknown as SmsCodeService,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('register', () => {
    beforeEach(() => prisma.user.findUnique.mockResolvedValue(null));

    it('先查没占用、建用户时撞唯一约束（并发注册同号）：409 PHONE_ALREADY_REGISTERED 而不是 500', async () => {
      prisma.user.create.mockRejectedValue(p2002());
      await expect(
        svc.register('13800138000', '123456', 'password123'),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'PHONE_ALREADY_REGISTERED' },
      });
    });

    it('建用户遇到其他数据库错误：原样抛出', async () => {
      prisma.user.create.mockRejectedValue(new Error('db down'));
      await expect(
        svc.register('13800138000', '123456', 'password123'),
      ).rejects.toThrow('db down');
    });
  });

  describe('resetPassword', () => {
    it('手机号未注册：404 PHONE_NOT_REGISTERED，不消费验证码', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        svc.resetPassword('13800138000', '123456', 'newpass123'),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'PHONE_NOT_REGISTERED' },
      });
      expect(smsCodes.verifyAndConsume).not.toHaveBeenCalled();
    });
  });

  describe('verifyPassword', () => {
    it.each([
      ['用户不存在', null],
      ['已注销', { passwordHash: 'x', deletedAt: new Date() }],
    ])('%s：401（残留 access token）', async (_n, row) => {
      prisma.user.findUnique.mockResolvedValue(row);
      await expect(svc.verifyPassword('u1', 'whatever')).rejects.toMatchObject({
        status: 401,
      });
    });

    it('密码不对：400 PASSWORD_INCORRECT', async () => {
      prisma.user.findUnique.mockResolvedValue({
        passwordHash,
        deletedAt: null,
      });
      await expect(svc.verifyPassword('u1', 'wrong')).rejects.toMatchObject({
        status: 400,
        response: { code: 'PASSWORD_INCORRECT' },
      });
    });
  });

  describe('changePassword', () => {
    beforeEach(() =>
      prisma.user.findUnique.mockResolvedValue({
        passwordHash,
        deletedAt: null,
      }),
    );

    it('没带当前设备的 refresh token：撤销本人全部未撤销会话（条件里不排除任何 token）', async () => {
      await svc.changePassword('u1', 'old-password', 'new-password');
      const revoke = prisma.refreshToken.updateMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(revoke[0].where).toEqual({ userId: 'u1', revokedAt: null });
    });

    it('带了当前设备的 refresh token：只保留这一张（按哈希排除），补发链路同时清空', async () => {
      await svc.changePassword('u1', 'old-password', 'new-password', 'rt-keep');
      const [revoke, unlink] = prisma.refreshToken.updateMany.mock
        .calls as Array<
        [{ where: Record<string, unknown>; data: Record<string, unknown> }]
      >;
      expect(revoke[0].where).toEqual({
        userId: 'u1',
        revokedAt: null,
        tokenHash: {
          not: createHash('sha256').update('rt-keep').digest('hex'),
        },
      });
      expect(unlink[0]).toEqual({
        where: { userId: 'u1', replacedById: { not: null } },
        data: { replacedById: null },
      });
    });

    it('旧密码不对：不改密、不撤销', async () => {
      await expect(
        svc.changePassword('u1', 'nope', 'new-password'),
      ).rejects.toMatchObject({ response: { code: 'PASSWORD_INCORRECT' } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it.each([
      ['手机号不存在', null],
      ['账号已注销', { id: 'u1', deletedAt: new Date(), passwordHash: 'x' }],
    ])(
      '%s：401「手机号或密码错误」（与密码错误同一响应），不签发',
      async (_n, row) => {
        prisma.user.findUnique.mockResolvedValue(row);
        await expect(
          svc.login('13800138000', 'old-password'),
        ).rejects.toMatchObject({
          status: 401,
          response: { code: 'UNAUTHORIZED', message: '手机号或密码错误' },
        });
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      },
    );

    it('成功：返回安全用户对象（不含密码哈希）与 token 对，refresh 只存哈希', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        phone: '13800138000',
        nickname: null,
        avatarUrl: null,
        createdAt: new Date(0),
        deletedAt: null,
        passwordHash,
      });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt1' });
      const r = await svc.login('13800138000', 'old-password');
      expect(r.user).toEqual({
        id: 'u1',
        phone: '13800138000',
        nickname: null,
        avatarUrl: null,
        createdAt: new Date(0),
      });
      expect(r.accessToken).toBe('jwt');
      const data = (
        prisma.refreshToken.create.mock.calls[0] as [
          { data: { tokenHash: string; expiresAt: Date } },
        ]
      )[0].data;
      expect(data.tokenHash).toBe(
        createHash('sha256').update(r.refreshToken).digest('hex'),
      );
      expect(data.tokenHash).not.toBe(r.refreshToken);
      const ttl = data.expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(29 * 24 * 3_600_000);
      expect(ttl).toBeLessThanOrEqual(30 * 24 * 3_600_000);
    });
  });

  describe('refresh / logout', () => {
    it('同一 token 并发刷新、事务里条件轮换没抢到：401「已被使用」，不签发、不触发全局撤销', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt1',
        userId: 'u1',
        revokedAt: null,
        replacedById: null,
        expiresAt: new Date(Date.now() + 3_600_000),
        user: { deletedAt: null },
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.refresh('rt-raw')).rejects.toMatchObject({
        response: { message: 'refresh token 已被使用，请用最新的 token' },
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    });

    it('logout：按哈希作废（幂等，不存在也不报错）', async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.logout('rt-raw')).resolves.toBeUndefined();
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: createHash('sha256').update('rt-raw').digest('hex'),
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe('changePhone', () => {
    beforeEach(() => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ passwordHash, deletedAt: null }) // verifyPassword
        .mockResolvedValueOnce(null); // 新号未占用
    });

    it('改号时撞唯一约束（并发有人注册了这个号）：409', async () => {
      prisma.user.update.mockRejectedValue(p2002());
      await expect(
        svc.changePhone('u1', '13900000000', '123456', 'old-password'),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'PHONE_ALREADY_REGISTERED' },
      });
    });

    it('改号遇到其他数据库错误：原样抛出', async () => {
      prisma.user.update.mockRejectedValue(new Error('timeout'));
      await expect(
        svc.changePhone('u1', '13900000000', '123456', 'old-password'),
      ).rejects.toThrow('timeout');
    });

    it('新号已被占用：409，不消费验证码', async () => {
      prisma.user.findUnique.mockReset();
      prisma.user.findUnique
        .mockResolvedValueOnce({ passwordHash, deletedAt: null })
        .mockResolvedValueOnce({ id: 'other' });
      await expect(
        svc.changePhone('u1', '13900000000', '123456', 'old-password'),
      ).rejects.toMatchObject({ status: 409 });
      expect(smsCodes.verifyAndConsume).not.toHaveBeenCalled();
    });
  });
});
