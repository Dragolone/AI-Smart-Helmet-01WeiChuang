// 管理员登录（API.md §10）：账号不存在与密码错误同一响应；签发带 typ=admin、独立密钥、12 小时的 token。
import { Logger, UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminAuthService } from './admin-auth.service';

describe('AdminAuthService.login', () => {
  const findUnique = jest.fn();
  const signAsync = jest.fn();
  const svc = new AdminAuthService(
    { adminUser: { findUnique } } as unknown as PrismaService,
    { signAsync } as unknown as JwtService,
    'admin-secret',
  );
  let hash: string;

  beforeAll(async () => {
    hash = await bcrypt.hash('right-password', 4);
  });
  beforeEach(() => {
    findUnique.mockReset();
    signAsync.mockReset().mockResolvedValue('admin.jwt');
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('成功：返回管理员信息与 token；token 载荷 typ=admin，用独立密钥、12h', async () => {
    findUnique.mockResolvedValue({
      id: 'a1',
      username: 'ops',
      passwordHash: hash,
    });
    await expect(svc.login('ops', 'right-password')).resolves.toEqual({
      admin: { id: 'a1', username: 'ops' },
      accessToken: 'admin.jwt',
    });
    expect(signAsync).toHaveBeenCalledWith(
      { sub: 'a1', typ: 'admin' },
      { secret: 'admin-secret', expiresIn: '12h' },
    );
  });

  it.each([
    ['账号不存在', null],
    ['密码错误', { id: 'a1', username: 'ops', passwordHash: '' }],
  ])('%s：401「用户名或密码错误」（同一响应），不签发', async (_n, row) => {
    findUnique.mockResolvedValue(
      row && { ...row, passwordHash: row.passwordHash || hash },
    );
    const err = await svc
      .login('ops', 'wrong-password')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toEqual({
      code: 'UNAUTHORIZED',
      message: '用户名或密码错误',
    });
    expect(signAsync).not.toHaveBeenCalled();
  });
});
