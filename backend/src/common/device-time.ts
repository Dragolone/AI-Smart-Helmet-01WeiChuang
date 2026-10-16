/** 设备时钟偏移阈值（DEVICE_PROTOCOL §8，默认 5 分钟） */
export const CLOCK_SKEW_THRESHOLD_MS = 5 * 60_000;

/** 头盔离线缓存的保留上限是 48 小时（DEVICE_PROTOCOL §6）；留一点余量，再早的时间戳只可能是头盔时钟不对 */
export const MAX_PLAUSIBLE_BACKFILL_MS = 72 * 3_600_000;

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

/**
 * 业务上用哪个时间（DEVICE_PROTOCOL §8：clock_skew 且非补传时以 receivedAt 兜底）。
 * 补传暂时无法从报文识别（§6），所以按「可能是补传」的窗口判：
 * - 比收到时晚超过偏移阈值：未来的时间不可能是补传 → 用收到时间；
 * - 比收到时早超过离线缓存能保留的时长：不可能是补传 → 用收到时间（头盔 RTC 归零后报 1970 年就落在这里）；
 * - 其余（含 5 分钟到 72 小时前的正常补传）保留设备时间，补传的轨迹形状不变。
 * 设备原始时间始终在 raw_events 留档，这里只决定业务表按哪个时间排。
 */
export function businessTime(deviceTime: Date, receivedAt: Date): Date {
  const aheadMs = deviceTime.getTime() - receivedAt.getTime();
  if (aheadMs > CLOCK_SKEW_THRESHOLD_MS) return receivedAt;
  if (-aheadMs > MAX_PLAUSIBLE_BACKFILL_MS) return receivedAt;
  return deviceTime;
}

/**
 * 补传的旧事件：按业务时间（时钟错乱已兜底成收到时间）比收到时早出偏移阈值以上。
 * 它们照常入库、进历史，但不能当「现在」用：不刷新设备快照（电量 / 固件 / 在线）、不当实时位置推给 App（观察项 16）
 */
export function isBackfill(deviceTime: Date, receivedAt: Date): boolean {
  return (
    receivedAt.getTime() - businessTime(deviceTime, receivedAt).getTime() >
    CLOCK_SKEW_THRESHOLD_MS
  );
}
