import { Prisma } from '../generated/prisma/client';

/** 唯一约束冲突（P2002）：eventId 幂等、并发先查后写的统一兜底判定 */
export const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** update/delete 的目标行不存在（P2025） */
export const isRecordNotFound = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';

/**
 * 瞬时故障的 Prisma 错误码：P2024 连接池超时、P2028 事务 API、P2034 写冲突 / 死锁、P2036 / P2037 驱动适配器错误 / 连接数满。
 * adapter-pg 下没有专门映射的 SQLSTATE 一律报 P2039——要再看原始 SQLSTATE 才分得清
 */
const TRANSIENT_PRISMA_CODES = new Set([
  'P2024',
  'P2028',
  'P2034',
  'P2036',
  'P2037',
]);
/** 瞬时类 SQLSTATE：08 连接、40 事务回滚 / 死锁、53 资源不足、55 锁不可得、57 管理员关停 / 取消、58 系统、XX 内部 */
const TRANSIENT_SQLSTATE = /^(08|40|53|55|57|58|XX)/;

/**
 * 数据库对"这一条数据"的拒绝（列范围、编码、非法值）→ 返回原因码，按 _invalid 留档；
 * 瞬时故障（连接、死锁、关停、资源不足……）→ null，交给上层按真实 5xx 处理、App / MQTT 重试。
 * 原来 P1 开头以外的已知错误码一律当「这条数据被拒」：adapter-pg 把后端被杀（57P01）、死锁（40P01）、连接数满（53300）
 * 报成 P2039 / P2037，摔倒事件就被改记成随机 eventId 的 _invalid、202 回给 App（App 从队列删掉），对账也捞不到——求救永久丢失（10-17 评审）
 */
export function dbRejectionCode(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientValidationError) return 'validation';
  // 引擎报不出码的未知错误照旧按这条数据留档：一律重抛的话，一条毒数据会让 App 整批反复重传、堵住后面的摔倒（队头阻塞）
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return 'unknown';
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (err.code.startsWith('P1') || TRANSIENT_PRISMA_CODES.has(err.code)) {
    return null;
  }
  const sqlState = (
    err.meta?.driverAdapterError as
      { cause?: { originalCode?: unknown } } | undefined
  )?.cause?.originalCode;
  if (typeof sqlState === 'string' && TRANSIENT_SQLSTATE.test(sqlState)) {
    return null;
  }
  return err.code;
}
