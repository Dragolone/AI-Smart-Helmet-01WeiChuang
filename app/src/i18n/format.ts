// 相对时间 / 日期的本地化格式（各页共用，避免每页各写一套中文口径）
import { translate, LOCALE_TAGS, type Locale } from "./index";

/** 认不出的时间戳在日期 / 时间位置上的占位（与 maskPhone 的空值占位同一个符号） */
const INVALID_TIME = "—";

export function relativeTime(iso: string | null, locale?: Locale): string {
  if (!iso) return translate("common.never", undefined, locale);
  const at = new Date(iso).getTime();
  // 认不出的时间按没有时间处理，不显示「NaN 天前」
  if (Number.isNaN(at)) return translate("common.never", undefined, locale);
  const diffSec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (diffSec < 45) return translate("common.justNow", undefined, locale);
  if (diffSec < 3600)
    return translate(
      "common.minutesAgo",
      { n: Math.max(1, Math.floor(diffSec / 60)) },
      locale,
    );
  if (diffSec < 86400)
    return translate(
      "common.hoursAgo",
      { n: Math.floor(diffSec / 3600) },
      locale,
    );
  return translate(
    "common.daysAgo",
    { n: Math.floor(diffSec / 86400) },
    locale,
  );
}

/** 短日期：09-10 / Sep 10 */
export function shortDate(iso: string, locale: Locale): string {
  const at = new Date(iso);
  // Intl 对 Invalid Date 直接抛 RangeError，会把整页带崩
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    month: "short",
    day: "numeric",
  }).format(at);
}

/** 短时间：08:31 */
export function shortTime(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

/** 完整日期时间（记录详情用，带年份和秒）：2026年10月6日 08:42:15 / Oct 6, 2026, 08:42:15 */
export function fullDateTime(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(at);
}

/**
 * 日期标题（行程列表按天分组用）：今天 / 昨天 / 10月4日 周日；不是今年的带上年份。
 * 「今天」按本地日历日算，不是按 24 小时。
 */
export function dayTitle(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  const now = new Date(Date.now());
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // 夏令时切换那天一天不是 24 小时，四舍五入到整天
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days === 0) return translate("common.today", undefined, locale);
  if (days === 1) return translate("common.yesterday", undefined, locale);
  const tag = LOCALE_TAGS[locale];
  const date = new Intl.DateTimeFormat(tag, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(at);
  const weekday = new Intl.DateTimeFormat(tag, { weekday: "short" }).format(at);
  return translate("common.dateWithWeekday", { date, weekday }, locale);
}

/** 月份标题（月历上用）：2026年10月 / October 2026 */
export function monthTitle(
  year: number,
  month: number,
  locale: Locale,
): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    year: "numeric",
    month: "long",
  }).format(new Date(year, month, 1));
}

/** 一周七天的单字名，周一起（月历的表头）：一 二 三 四 五 六 日 / M T W T F S S */
export function weekdayInitials(locale: Locale): string[] {
  const fmt = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    weekday: "narrow",
  });
  // 2024 年 1 月 1 日是周一
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(2024, 0, 1 + i)),
  );
}

/** 当天的只给时间（08:31），不是当天的带上日期（9月17日 08:31）——留在界面上的旧时间不会被读成今天 */
export function timeWithDateIfNotToday(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  const now = new Date(Date.now());
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay
    ? shortTime(iso, locale)
    : `${shortDate(iso, locale)} ${shortTime(iso, locale)}`;
}

/**
 * 里程数字（单位 km 另外显示）：1000 km 以下保留一位小数，1000 以上整数——
 * 统计卡每格宽度只容四五个字符，「6547.4」会被截成「65…」（2026-10-07 华为 REGRESSION 3.1）
 */
export function formatKm(meters: number): string {
  const km = meters / 1000;
  if (!Number.isFinite(km) || km < 0) return "0.0";
  return km >= 1000 ? Math.round(km).toString() : km.toFixed(1);
}
