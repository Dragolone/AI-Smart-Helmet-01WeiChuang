// Admin 守卫：独立密钥验签 + typ=admin 双保险；任何失败统一 401（不区分原因）。
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { AdminAuthGuard } from './admin-auth.guard';

const ctxFor = (req: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('AdminAuthGuard', () => {
  const verifyAsync = jest.fn();
  const guard = new AdminAuthGuard(
    { verifyAsync } as unknown as JwtService,
    'admin-secret',
  );
  beforeEach(() => verifyAsync.mockReset());

  const expect401 = async (req: Record<string, unknown>) => {
    const err = await guard.canActivate(ctxFor(req)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toEqual({
      code: 'UNAUTHORIZED',
      message: '管理员访问令牌无效或已过期',
    });
  };

  it('没带 / 不是 Bearer：401，不验签', async () => {
    await expect401({ headers: {} });
    await expect401({ headers: { authorization: 'Token x' } });
    expect(verifyAsync).not.toHaveBeenCalled();
  });

  it('用 admin 独立密钥验签；typ=admin 通过并挂 req.admin', async () => {
    verifyAsync.mockResolvedValue({ sub: 'a1', typ: 'admin' });
    const req: Record<string, unknown> = {
      headers: { authorization: 'Bearer tok' },
    };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(verifyAsync).toHaveBeenCalledWith('tok', { secret: 'admin-secret' });
    expect(req.admin).toEqual({ adminId: 'a1' });
  });

  it('验签通过但不是 admin token（用户 token、没有 typ）：401', async () => {
    verifyAsync.mockResolvedValue({ sub: 'u1' });
    await expect401({ headers: { authorization: 'Bearer tok' } });
    verifyAsync.mockResolvedValue({ sub: 'u1', typ: 'user' });
    await expect401({ headers: { authorization: 'Bearer tok' } });
  });

  it('验签失败：401', async () => {
    verifyAsync.mockRejectedValue(new Error('invalid signature'));
    await expect401({ headers: { authorization: 'Bearer tok' } });
  });
});
