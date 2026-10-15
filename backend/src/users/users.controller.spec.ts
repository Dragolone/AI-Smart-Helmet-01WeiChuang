// 「我的」接口：注销后的残留会话按未登录处理；用户行没了 404；PATCH 只改传了的字段。
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import type { PrismaService } from '../prisma/prisma.service';
import { UsersController } from './users.controller';
import type { UsersService } from './users.service';

describe('UsersController', () => {
  const prisma = { user: { findUnique: jest.fn(), update: jest.fn() } };
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

  it('GET /me：账号已注销 → 401「账号已注销」', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      deletedAt: new Date(),
    });
    const err = await ctl.me(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toEqual({
      code: 'UNAUTHORIZED',
      message: '账号已注销',
    });
  });

  it('GET /me：用户行不存在 → 404', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(ctl.me(req)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('PATCH /me：只改传了的字段；都不传就是空更新', async () => {
    await ctl.updateMe(req, { nickname: '新昵称' });
    await ctl.updateMe(req, { avatarUrl: 'https://x/a.png' });
    await ctl.updateMe(req, {});
    expect(
      prisma.user.update.mock.calls.map(
        (c) => (c as [{ data: object }])[0].data,
      ),
    ).toEqual([{ nickname: '新昵称' }, { avatarUrl: 'https://x/a.png' }, {}]);
  });

  it('DELETE /me：交给服务层（带当前密码）', async () => {
    await ctl.deleteMe(req, { password: 'pw' });
    expect(users.deleteAccount).toHaveBeenCalledWith('u1', 'pw');
  });
});
