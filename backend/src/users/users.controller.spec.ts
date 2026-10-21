// 「我的」接口：注销后的残留会话按未登录处理；用户行没了 404；PATCH 只改传了的字段。
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import type { PrismaService } from '../prisma/prisma.service';
import { UsersController } from './users.controller';
import type { UsersService } from './users.service';

describe('UsersController', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const users = { deleteAccount: jest.fn() };
  const ctl = new UsersController(
    prisma as unknown as PrismaService,
    users as unknown as UsersService,
  );
  const req = { user: { userId: 'u1' } } as AuthenticatedRequest;
  beforeEach(() => jest.clearAllMocks());

  it('GET /me：返回安全字段，不带 deletedAt', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      phone: '13800001111',
      nickname: null,
      avatarUrl: null,
      createdAt: new Date(0),
      deletedAt: null,
    });
    const me = await ctl.me(req);
    expect(me).toEqual({
      id: 'u1',
      phone: '13800001111',
      nickname: null,
      avatarUrl: null,
      createdAt: new Date(0),
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: {
        id: true,
        phone: true,
        nickname: true,
        avatarUrl: true,
        createdAt: true,
        deletedAt: true,
      },
    });
  });

  it('GET /me：账号已注销 → 401 ACCOUNT_DELETED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      deletedAt: new Date(),
    });
    const err = await ctl.me(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toEqual({
      code: 'ACCOUNT_DELETED',
      message: '账号已注销',
    });
  });

  it('GET /me：用户行不存在 → 404', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(ctl.me(req)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('PATCH /me：只改传了的字段；都不传就是空更新；只改未注销的账号', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    await ctl.updateMe(req, { nickname: '新昵称' });
    await ctl.updateMe(req, { avatarUrl: 'https://x/a.png' });
    await ctl.updateMe(req, {});
    const calls = prisma.user.updateMany.mock.calls.map(
      (c) => (c as [{ where: object; data: object }])[0],
    );
    expect(calls.map((c) => c.data)).toEqual([
      { nickname: '新昵称' },
      { avatarUrl: 'https://x/a.png' },
      {},
    ]);
    for (const c of calls)
      expect(c.where).toEqual({ id: 'u1', deletedAt: null });
  });

  it('PATCH /me：守卫之后账号被注销（改 0 行）→ 401，不回读', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(ctl.updateMe(req, { nickname: 'x' })).rejects.toMatchObject({
      status: 401,
      response: { code: 'ACCOUNT_DELETED', message: '账号已注销' },
    });
    expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('DELETE /me：交给服务层（带当前密码）', async () => {
    await ctl.deleteMe(req, { password: 'pw' });
    expect(users.deleteAccount).toHaveBeenCalledWith('u1', 'pw');
  });
});
