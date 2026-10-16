import {
  isISO8601,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

/** 时间部分后面必须跟显式时区（Z / ±hh / ±hhmm / ±hh:mm） */
const HAS_TIME = /T/i;
const HAS_ZONE = /(Z|[+-]\d{2}(:?\d{2})?)$/i;

/**
 * 能被 new Date() 解析的 ISO 8601 时间；带时间部分的必须带显式时区。
 * 不带时区的（2026-10-01T00:00:00）JS 按服务器进程时区解析，API.md §1 写的是一律 UTC——容器是 UTC 时看不出来，
 * 开发机 / 换了 TZ 的部署上就差几个小时（观察项 3）。只有日期（2026-10-01）JS 本来就按 UTC 解析，照收
 */
export const isParsableIsoDateTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  isISO8601(value, { strict: true }) &&
  (!HAS_TIME.test(value) || HAS_ZONE.test(value)) &&
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
