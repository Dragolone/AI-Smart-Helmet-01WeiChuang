import {
  isISO8601,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

/** 能被 new Date() 解析的 ISO 8601 时间 */
export const isParsableIsoDateTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  isISO8601(value, { strict: true }) &&
  !Number.isNaN(new Date(value).getTime());

/**
 * 查询参数里的时间（API.md §1：ISO 8601 UTC）。只用 IsISO8601 不够：它也认周日期（2026-W41）、
 * 序数日期（2026-280）、紧凑写法（20261007），new Date() 把这些都解析成 Invalid Date，
 * 服务层的先后 / 跨度校验遇到 NaN 全部判假，最后由 Prisma 拒绝查询，变成 500 和一条 ERROR 栈。
 */
export function IsIsoDateTime(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isIsoDateTime',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} 必须是 ISO 8601 时间（如 2026-10-14T00:00:00Z）`,
        ...options,
      },
      validator: { validate: isParsableIsoDateTime },
    });
  };
}
