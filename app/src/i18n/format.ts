// 相对时间 / 日期的本地化格式（各页共用，避免每页各写一套中文口径）
import { translate, useLocaleStore, type Locale } from "./index";

/** 认不出的时间戳在日期 / 时间位置上的占位（与 maskPhone 的空值占位同一个符号） */
const INVALID_TIME = "—";

/**
 * 日期 / 星期 / 月份不再交给 Intl 按 locale 排版：Hermes 安卓端的 Intl.DateTimeFormat 不认传入的 locale、按系统语言输出
 * （2026-10-24 Android 17 模拟器实测：App 固定简体中文，系统 en-US 时安全记录写「今天 · Oct 24」、fr-FR 写「24 oct.」，
 * 只有系统也是中文才是「10月24日」；iOS 同一段代码正常）。三种语言就这几种写法，自己拼最稳；
 * 小时 / 分钟 / 秒一律两位、24 小时制，与原来 Intl 的输出逐字一致（见 __tests__）。
 */
const EN_MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const EN_MONTH_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
/** 周日起（与 Date#getDay 同序） */
const WEEKDAY_SHORT: Record<Locale, readonly string[]> = {
  "zh-CN": ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
  "zh-TW": ["週日", "週一", "週二", "週三", "週四", "週五", "週六"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};
const WEEKDAY_NARROW: Record<Locale, readonly string[]> = {
  "zh-CN": ["日", "一", "二", "三", "四", "五", "六"],
  "zh-TW": ["日", "一", "二", "三", "四", "五", "六"],
  en: ["S", "M", "T", "W", "T", "F", "S"],
};
const two = (n: number): string => String(n).padStart(2, "0");

/** 9月10日 / 2024年10月15日 / Sep 10 / Oct 15, 2024 */
function dateText(at: Date, locale: Locale, withYear: boolean): string {
  const y = at.getFullYear();
  const m = at.getMonth();
  const d = at.getDate();
  if (locale === "en")
    return `${EN_MONTH_SHORT[m]} ${d}${withYear ? `, ${y}` : ""}`;
  return `${withYear ? `${y}年` : ""}${m + 1}月${d}日`;
}

/** 08:31 / 08:31:05（24 小时制，两位） */
function timeText(at: Date, withSeconds = false): string {
  const hm = `${two(at.getHours())}:${two(at.getMinutes())}`;
  return withSeconds ? `${hm}:${two(at.getSeconds())}` : hm;
}

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
  // 一个月以上直接写日期：「730 天前」读起来要换算（2026-10-15 边界测试），跨年时带上年份
  if (diffSec >= 30 * 86400)
    return dateMaybeYear(iso, locale ?? useLocaleStore.getState().locale);
  return translate(
    "common.daysAgo",
    { n: Math.floor(diffSec / 86400) },
    locale,
  );
}

/** 日期；不是今年的带上年份：「9月10日」/「2024年10月15日」 */
export function dateMaybeYear(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  const thisYear = at.getFullYear() === new Date(Date.now()).getFullYear();
  return dateText(at, locale, !thisYear);
}

/** 两个时间在手机本地时区是不是同一天（认不出的时间按同一天处理，不额外加「次日」） */
export function sameLocalDay(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return true;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 短日期：09-10 / Sep 10 */
export function shortDate(iso: string, locale: Locale): string {
  const at = new Date(iso);
  // 认不出的时间按占位处理，不让「Invalid Date」把整页带崩
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  return dateText(at, locale, false);
}

/** 短时间：08:31 */
export function shortTime(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  return timeText(at);
}

/** 完整日期时间（记录详情用，带年份和秒）：2026年10月6日 08:42:15 / Oct 6, 2026, 08:42:15 */
export function fullDateTime(iso: string, locale: Locale): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return INVALID_TIME;
  const date = dateText(at, locale, true);
  const time = timeText(at, true);
  return locale === "en" ? `${date}, ${time}` : `${date} ${time}`;
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
  const date = dateText(at, locale, at.getFullYear() !== now.getFullYear());
  const weekday = WEEKDAY_SHORT[locale][at.getDay()];
  return translate("common.dateWithWeekday", { date, weekday }, locale);
}

/** 月份标题（月历上用）：2026年10月 / October 2026 */
export function monthTitle(
  year: number,
  month: number,
  locale: Locale,
): string {
  // 月份越界由 Date 进位（12 → 次年 1 月，-1 → 上一年 12 月），与原来 Intl 的行为一致
  const at = new Date(year, month, 1);
  if (locale === "en")
    return `${EN_MONTH_LONG[at.getMonth()]} ${at.getFullYear()}`;
  return `${at.getFullYear()}年${at.getMonth() + 1}月`;
}

/** 一周七天的单字名，周一起（月历的表头）：一 二 三 四 五 六 日 / M T W T F S S */
export function weekdayInitials(locale: Locale): string[] {
  const names = WEEKDAY_NARROW[locale];
  // 周一到周日：getDay 的 1…6、0
  return [1, 2, 3, 4, 5, 6, 0].map((day) => names[day]);
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
  // 先按一位小数取整再判断：999.95–999.99 km 用 toFixed(1) 会进位成六个字符的「1000.0」
  const tenths = Math.round(km * 10) / 10;
  return tenths >= 1000 ? Math.round(km).toString() : tenths.toFixed(1);
}
