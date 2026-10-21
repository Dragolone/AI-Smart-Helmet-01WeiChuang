// 全局 JWT 守卫：@Public 跳过、Bearer 解析、验签失败 / admin token / 注销账号一律 401，通过后挂 req.user；
// 顺带按 X-Client-Timezone 记下手机时区（O13）。
import {
  Logger,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
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
  const updateMany = jest.fn();
  const guard = new JwtAuthGuard(
    { getAllAndOverride: () => isPublic } as unknown as Reflector,
    { verifyAsync } as unknown as JwtService,
    { user: { findUnique, updateMany } } as unknown as PrismaService,
  );

  beforeEach(() => {
    isPublic = undefined;
    verifyAsync.mockReset().mockResolvedValue({ sub: 'u1' });
    findUnique
      .mockReset()
      .mockResolvedValue({ deletedAt: null, timeZone: null });
    updateMany.mockReset().mockResolvedValue({ count: 1 });
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

  describe('手机时区（X-Client-Timezone，O13）', () => {
    const pass = (timeZone?: unknown) =>
      guard.canActivate(
        ctxFor({
          headers: {
            authorization: 'Bearer good',
            ...(timeZone !== undefined
              ? { 'x-client-timezone': timeZone }
              : {}),
          },
        }),
      );

    it('和记下的不同：写一次（规范化后的名字，只写未注销的账号）', async () => {
      await expect(pass('asia/shanghai')).resolves.toBe(true);
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { deletedAt: true, timeZone: true },
      });
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 'u1', deletedAt: null },
        data: { timeZone: 'Asia/Shanghai' },
      });
    });

    it('和记下的相同 / 没带 / 不合法 / 用户行不存在：不写', async () => {
      findUnique.mockResolvedValue({
        deletedAt: null,
        timeZone: 'Asia/Shanghai',
      });
      await pass('Asia/Shanghai');
      await pass();
      findUnique.mockResolvedValue({ deletedAt: null, timeZone: null });
      await pass('Mars/Base');
      await pass(['Asia/Shanghai', 'Asia/Tokyo']);
      findUnique.mockResolvedValue(null);
      await pass('Asia/Tokyo');
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('已注销：照样 401，不写时区', async () => {
      findUnique.mockResolvedValue({ deletedAt: new Date(), timeZone: null });
      await expect(pass('Asia/Shanghai')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('写库失败：只记 warn，请求照常放行', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      updateMany.mockRejectedValue(new Error('db down'));
      await expect(pass('Australia/Sydney')).resolves.toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
      warn.mockRestore();
    });
  });
});
