// 全局 JWT 守卫：@Public 跳过、Bearer 解析、验签失败 / admin token / 注销账号一律 401，通过后挂 req.user。
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const ctxFor = (req: Record<string, unknown>) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('JwtAuthGuard', () => {
  let isPublic: boolean | undefined;
  const verifyAsync = jest.fn();
  const findUnique = jest.fn();
  const guard = new JwtAuthGuard(
    { getAllAndOverride: () => isPublic } as unknown as Reflector,
    { verifyAsync } as unknown as JwtService,
    { user: { findUnique } } as unknown as PrismaService,
  );

  beforeEach(() => {
    isPublic = undefined;
    verifyAsync.mockReset().mockResolvedValue({ sub: 'u1' });
    findUnique.mockReset().mockResolvedValue({ deletedAt: null });
  });

  const fail = async (req: Record<string, unknown>) => {
    const err = await guard.canActivate(ctxFor(req)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    return (err as UnauthorizedException).getResponse();
  };

  it('@Public：不看 token 直接放行', async () => {
    isPublic = true;
    await expect(guard.canActivate(ctxFor({ headers: {} }))).resolves.toBe(
      true,
    );
    expect(verifyAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['没有 Authorization', {}],
    ['不是 Bearer', { authorization: 'Basic abc' }],
    ['Bearer 后为空', { authorization: 'Bearer ' }],
  ])('%s：401 缺少访问令牌', async (_n, headers) => {
    expect(await fail({ headers })).toEqual({
      code: 'UNAUTHORIZED',
      message: '缺少访问令牌',
    });
  });

  it('验签失败：401 访问令牌无效或已过期', async () => {
    verifyAsync.mockRejectedValue(new Error('jwt expired'));
    expect(await fail({ headers: { authorization: 'Bearer t' } })).toEqual({
      code: 'UNAUTHORIZED',
      message: '访问令牌无效或已过期',
    });
  });

  it('typ=admin 的 token（两套密钥被误配成同值时）：同样 401，不查库', async () => {
    verifyAsync.mockResolvedValue({ sub: 'admin1', typ: 'admin' });
    expect(
      await fail({ headers: { authorization: 'Bearer t' } }),
    ).toMatchObject({ message: '访问令牌无效或已过期' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('账号已注销（token 还没过期）：401 ACCOUNT_DELETED（另一台手机据此写「账号已注销」，O15）', async () => {
    findUnique.mockResolvedValue({ deletedAt: new Date() });
    expect(await fail({ headers: { authorization: 'Bearer t' } })).toEqual({
      code: 'ACCOUNT_DELETED',
      message: '账号已注销',
    });
  });

  it('通过：挂上 req.user；用户行不存在时也放行（交给接口按 404）', async () => {
    const req: Record<string, unknown> = {
      headers: { authorization: 'Bearer good' },
    };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(verifyAsync).toHaveBeenCalledWith('good');
    expect(req.user).toEqual({ userId: 'u1' });
    findUnique.mockResolvedValue(null);
    const req2: Record<string, unknown> = {
      headers: { authorization: 'Bearer good' },
    };
    await expect(guard.canActivate(ctxFor(req2))).resolves.toBe(true);
  });
});
