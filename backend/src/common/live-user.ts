import { UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

/** 与 JWT 守卫同一个错误：请求过守卫时账号还在，写库前已被注销 */
export const accountDeleted = (): UnauthorizedException =>
  new UnauthorizedException({ code: 'UNAUTHORIZED', message: '账号已注销' });

/**
 * 在写事务里给用户行加共享锁并确认账号还在，要在提交前调用。注销事务第一句就更新用户行，
 * FOR SHARE 与它的 NO KEY UPDATE 互斥（FOR KEY SHARE 不互斥，见 auth.service lockUserRow），两边因此串行：
 * 注销先提交 → 这里看到 deleted_at，整个写入回滚；这里先提交 → 注销随后清理关联数据时能看到这次写入。
 * 不加的话，注销前一刻通过守卫的请求会在注销清理完之后才落库，数据挂在已注销账号上（10-17 评审）。
 */
export async function lockLiveUser(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const [row] = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM users WHERE id = ${userId} FOR SHARE`;
  if (!row || row.deleted_at) throw accountDeleted();
}
