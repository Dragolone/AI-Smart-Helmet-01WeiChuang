import { UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

/**
 * 因账号已注销而拒绝的 401 一律用这个码（API.md §1.1，O15）：另一台手机据此写「账号已注销」，
 * 不再按普通 401 说成「登录已失效，密码可能已在别处修改」。HTTP 状态仍是 401，旧版 App 的刷新 / 登出流程不受影响
 */
export const ACCOUNT_DELETED = 'ACCOUNT_DELETED';

/** 与 JWT 守卫同一个错误：请求过守卫时账号还在，写库前已被注销 */
export const accountDeleted = (): UnauthorizedException =>
  new UnauthorizedException({ code: ACCOUNT_DELETED, message: '账号已注销' });

/**
 * 在写事务里给用户行加共享锁，返回账号是否还在（不存在也算不在）。要在提交前调用。注销事务第一句就更新用户行，
 * FOR SHARE 与它的 NO KEY UPDATE 互斥（FOR KEY SHARE 不互斥，见 auth.service lockUserRow），两边因此串行：
 * 注销先提交 → 这里看到 deleted_at；这里先提交 → 注销随后清理关联数据（或检查进行中的求救）时能看到这次写入。
 */
export async function lockUserIfLive(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM users WHERE id = ${userId} FOR SHARE`;
  return !!row && !row.deleted_at;
}

/**
 * 同上，账号已不在就抛 401 让整个写入回滚。
 * 不加的话，注销前一刻通过守卫的请求会在注销清理完之后才落库，数据挂在已注销账号上（10-17 评审）。
 */
export async function lockLiveUser(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  if (!(await lockUserIfLive(tx, userId))) throw accountDeleted();
}
