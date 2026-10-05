import { Prisma } from '../generated/prisma/client';

/** 唯一约束冲突（P2002）：eventId 幂等、并发先查后写的统一兜底判定 */
export const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** update/delete 的目标行不存在（P2025） */
export const isRecordNotFound = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
