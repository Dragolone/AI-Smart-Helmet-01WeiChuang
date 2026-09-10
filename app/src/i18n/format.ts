// 相对时间 / 日期的本地化格式（各页共用，避免每页各写一套中文口径）
import { translate, LOCALE_TAGS, type Locale } from './index';

export function relativeTime(iso: string | null, locale?: Locale): string {
  if (!iso) return translate('common.never', undefined, locale);
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 45) return translate('common.justNow', undefined, locale);
  if (diffSec < 3600) return translate('common.minutesAgo', { n: Math.max(1, Math.floor(diffSec / 60)) }, locale);
  if (diffSec < 86400) return translate('common.hoursAgo', { n: Math.floor(diffSec / 3600) }, locale);
  return translate('common.daysAgo', { n: Math.floor(diffSec / 86400) }, locale);
}

/** 短日期：09-10 / Sep 10 */
export function shortDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { month: 'short', day: 'numeric' }).format(
    new Date(iso),
  );
}

/** 短时间：08:31 */
export function shortTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
