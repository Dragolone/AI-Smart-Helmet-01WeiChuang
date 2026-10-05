/** 设备时钟偏移阈值（DEVICE_PROTOCOL §8，默认 5 分钟） */
export const CLOCK_SKEW_THRESHOLD_MS = 5 * 60_000;

/** 设备自报时间可入库的年份范围：之外只可能是时钟坏了，且 PostgreSQL 直接拒收年份 0000 */
const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

/**
 * 设备/App 转报的时间戳：解析不了、或 JS 能解析但数据库存不下时返回 null，调用方以服务器时间兜底。
 * 只判 NaN 不够——`0000-01-01T00:00:00Z` 是合法 Date，写库时才炸，回执会因此丢失。
 */
export function parseDeviceTime(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  const year = parsed.getUTCFullYear();
  return Number.isNaN(year) || year < MIN_YEAR || year > MAX_YEAR
    ? null
    : parsed;
}

/**
 * 「最新」类查询的时间上界：设备时钟跑到未来的点（超出偏移阈值）不可能是真实的最新状态，
 * 不设上界时一条 2099 年的点会永远排在最前。原始数据照常留档，只是不参与「最新」判定。
 */
export const latestPlausibleTime = (): Date =>
  new Date(Date.now() + CLOCK_SKEW_THRESHOLD_MS);
