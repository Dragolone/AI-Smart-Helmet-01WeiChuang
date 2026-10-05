// 相对时间 / 日期的本地化格式（各页共用，避免每页各写一套中文口径）
import { translate, LOCALE_TAGS, type Locale } from './index';

/** 认不出的时间戳在日期 / 时间位置上的占位（与 maskPhone 的空值占位同一个符号） */
const INVALID_TIME = '—';

export function relativeTime(iso: string | null, locale?: Locale): string {
  if (!iso) return translate('common.never', undefined, locale);
  const at = new Date(iso).getTime();
  // 认不出的时间按没有时间处理，不显示「NaN 天前」
  if (Number.isNaN(at)) return translate('common.never', undefined, locale);
  const diffSec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (diffSec < 45) return translate('common.justNow', undefined, locale);
  if (diffSec < 3600) return translate('common.minutesAgo', { n: Math.max(1, Math.floor(diffSec / 60)) }, locale);
  if (diffSec < 86400) return translate('common.hoursAgo', { n: Math.floor(diffSec / 3600) }, locale);
  return translate('common.daysAgo', { n: Math.floor(diffSec / 86400) }, locale);
}

/** 短日期：09-10 / Sep 10 */
export function shortDate(iso: string, locale: Locale): string {
  const at = new Date(iso);
  // Intl 对 Invalid Date 直接抛 RangeError，会把整页带崩
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { month: 'short', day: 'numeric' }).format(at);
}

/** 短时间：08:31 */
export function shortTime(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}
