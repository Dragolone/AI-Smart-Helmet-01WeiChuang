// 地图页「行程」的几个推导（纯函数）：按月翻页的查询范围、按天分组、一趟的小结、
// 轨迹上的事件落在哪个点、「在地图上查看该时刻」落在哪一趟。
import type { RideSummary } from "@helmet/shared";

import { plausibleSpeed } from "@/components/map/coords";

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** 轨迹接口单次最多取 24 小时（API.md §5） */
const TRACK_MAX_MS = DAY_MS;
/**
 * 事件比这一趟最后一次在动晚这么久以内，仍算这一趟路上的事：人摔了之后是停着的，
 * 求救往往是停下之后才按。和服务器切行程的 15 分钟是同一个数，两趟之间不会互相够着。
 */
export const AFTER_RIDE_MS = 15 * MIN_MS;
/** 事件比这一趟的起点早这么久以内也算（起点是「开始动的前一个点」，事件可能略早） */
const BEFORE_RIDE_MS = 2 * MIN_MS;
/** 那一刻不在任何一趟里时，看它前后各这么久 */
const MOMENT_HALF_MS = 30 * MIN_MS;

/** 本地时区的某个月：month 为 0–11 */
export interface MonthCursor {
  year: number;
  month: number;
}

export const monthOf = (at: Date): MonthCursor => ({
  year: at.getFullYear(),
  month: at.getMonth(),
});

export const olderMonth = (c: MonthCursor): MonthCursor =>
  c.month === 0
    ? { year: c.year - 1, month: 11 }
    : { year: c.year, month: c.month - 1 };

export const newerMonth = (c: MonthCursor): MonthCursor =>
  c.month === 11
    ? { year: c.year + 1, month: 0 }
    : { year: c.year, month: c.month + 1 };

export const isMonthBefore = (a: MonthCursor, b: MonthCursor): boolean =>
  a.year * 12 + a.month < b.year * 12 + b.month;

export const isSameMonth = (a: MonthCursor, b: MonthCursor): boolean =>
  a.year === b.year && a.month === b.month;

/**
 * 这个月的查询范围：本地 1 日零点到下月 1 日零点；还没过完的月截到此刻之后一分钟
 *（刚动起来、起点就在这几秒里的那一趟也要算进来）。
 * from 一律是本地零点：服务器切超长行程的基准是 from（API.md §5），各处的 from 对齐，同一趟才对得上。
 */
export function monthWindow(
  c: MonthCursor,
  now: Date,
): { from: Date; to: Date } {
  const from = new Date(c.year, c.month, 1);
  const next = new Date(c.year, c.month + 1, 1);
  const cap = new Date(now.getTime() + MIN_MS);
  return { from, to: next.getTime() <= cap.getTime() ? next : cap };
}

/**
 * 与 at 所在那个月的查询（monthWindow）同一个网格上的时刻：月初零点起每 24 小时一格，
 * 取「at 往前至少 daysBack 整天」的那一格。
 * 为什么不直接取「本地零点」：服务器切超长行程的网格是 from + n × 24 小时，夏令时切换之后
 * 本地零点和月初零点差一个小时，两个查询切出来的就不是同一趟了，列表里会多出一条重叠的。
 */
function monthGridBefore(at: Date, daysBack: number): Date {
  const monthStart = new Date(at.getFullYear(), at.getMonth(), 1).getTime();
  const cell = Math.floor((at.getTime() - monthStart) / DAY_MS) - daysBack;
  return new Date(monthStart + cell * DAY_MS);
}

/** 「现在这一趟」的查询范围：往前至少一整天——跨零点还在骑的那一趟，起点在昨天 */
export function currentRideWindow(now: Date): { from: Date; to: Date } {
  return {
    from: monthGridBefore(now, 1),
    to: new Date(now.getTime() + MIN_MS),
  };
}

/**
 * 几次查询的结果合成一份：同一趟（起点相同）只留一条，最新在前。
 * 同一趟出现在多份里时留**排在前面那份**的——调用方把更新鲜的那份放前面
 *（「进行中」的那趟在两次查询之间往前走了，或者已经结束了）。
 */
export function mergeRides(
  lists: readonly (readonly RideSummary[])[],
): RideSummary[] {
  const byStart = new Map<string, RideSummary>();
  for (const list of lists) {
    for (const r of list) {
      if (!byStart.has(r.startAt)) byStart.set(r.startAt, r);
    }
  }
  return [...byStart.values()].sort(
    (a, b) => Date.parse(b.startAt) - Date.parse(a.startAt),
  );
}

export interface RideDay {
  /** 本地日期 YYYY-MM-DD */
  key: string;
  /** 这一天里任意一趟的起点（给日期标题格式化用） */
  at: string;
  rides: RideSummary[];
  distanceMeters: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 本地日期键 YYYY-MM-DD；一趟算在它出发的那一天 */
export function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 这个月第 day 天的日期键，和 dayKeyOf 同一个写法 */
export const dayKeyIn = (c: MonthCursor, day: number): string =>
  `${c.year}-${pad2(c.month + 1)}-${pad2(day)}`;

/** 日期键那一天的本地正午（给日期格式化用：取正午，夏令时切换那天也不会跑到前后一天去） */
export function noonOfDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

/** 日期键是不是落在这个月里 */
export const isDayInMonth = (key: string, c: MonthCursor): boolean =>
  key.startsWith(`${c.year}-${pad2(c.month + 1)}-`);

/**
 * 月历的格子：一行一周、周一起，不属于这个月的位置是 null。
 * 只给出装得下这个月的行数（4–6 行），不补成固定 6 行。
 */
export function monthGrid(c: MonthCursor): (number | null)[][] {
  const days = new Date(c.year, c.month + 1, 0).getDate();
  // getDay：周日是 0。换成「周一是第 0 格」
  const lead = (new Date(c.year, c.month, 1).getDay() + 6) % 7;
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export interface DayStat {
  rides: number;
  distanceMeters: number;
}

/**
 * 这个月里哪几天有行程、各几趟多少米：一趟算在它出发的那一天（和列表按天分组同一个口径）。
 * 出发日不在这个月里的不算。
 */
export function ridesByDay(
  rides: readonly RideSummary[],
  c: MonthCursor,
): Map<string, DayStat> {
  const out = new Map<string, DayStat>();
  for (const r of rides) {
    const key = dayKeyOf(r.startAt);
    if (!isDayInMonth(key, c)) continue;
    const stat = out.get(key);
    if (stat) {
      stat.rides += 1;
      stat.distanceMeters += r.distanceMeters;
    } else {
      out.set(key, { rides: 1, distanceMeters: r.distanceMeters });
    }
  }
  return out;
}

/** 行程列表在看哪一段：全部、某一个月、某一天 */
export type RideFilter =
  | { kind: "all" }
  | { kind: "month"; month: MonthCursor }
  | { kind: "day"; month: MonthCursor; dayKey: string };

/** 按筛选留下该看的那几趟（出发日落在那个月 / 那一天的）；顺序原样保留 */
export function filterRides(
  rides: readonly RideSummary[],
  filter: Exclude<RideFilter, { kind: "all" }>,
): RideSummary[] {
  return rides.filter((r) => {
    const key = dayKeyOf(r.startAt);
    return filter.kind === "day"
      ? key === filter.dayKey
      : isDayInMonth(key, filter.month);
  });
}

/** 按出发那天分组；传入的顺序（最新在前）原样保留 */
export function groupByDay(rides: readonly RideSummary[]): RideDay[] {
  const days: RideDay[] = [];
  for (const r of rides) {
    const key = dayKeyOf(r.startAt);
    const last = days[days.length - 1];
    if (last && last.key === key) {
      last.rides.push(r);
      last.distanceMeters += r.distanceMeters;
    } else {
      days.push({
        key,
        at: r.startAt,
        rides: [r],
        distanceMeters: r.distanceMeters,
      });
    }
  }
  return days;
}

/**
 * 一趟从出发到结束过了多少秒（路口停着的时间也在里面）。列表和小结里的「时长」都按这个算，
 * 和页面上写的起止时间对得上；首页「今日骑行」用的是另一个数（只算在动的时间）。
 */
export function rideSeconds(r: Pick<RideSummary, "startAt" | "endAt">): number {
  const s = (Date.parse(r.endAt) - Date.parse(r.startAt)) / 1000;
  return Number.isFinite(s) ? Math.max(0, Math.round(s)) : 0;
}

/** 平均时速（km/h）= 里程 ÷ 时长；不到一分钟的不算（除出来的数没有意义） */
export function rideAvgKmh(
  r: Pick<RideSummary, "startAt" | "endAt" | "distanceMeters">,
): number | null {
  const s = rideSeconds(r);
  return s < 60 ? null : (r.distanceMeters / s) * 3.6;
}

/**
 * 行程的「最高速度」（km/h）：头盔报的最高（剔除飞点）和平均速度取较大的那个。两者来源不同——最高取头盔报的速度字段，
 * 平均按里程 ÷ 时长——GPS 抖动让里程偏大时会出现「平均 22 > 最高 18」（10-21 夜测，负责人定取较大，O25）。
 * 头盔没报出像样的最高时照旧不写（不拿平均冒充最高）
 */
export function rideMaxKmh(
  r: Pick<RideSummary, "startAt" | "endAt" | "distanceMeters" | "maxSpeed">,
): number | null {
  const reported = plausibleSpeed(r.maxSpeed);
  if (reported === null) return null;
  const avg = rideAvgKmh(r);
  return Math.max(reported * 3.6, avg ?? 0);
}

/** 时长拆成几小时几分：四舍五入到分钟，不足一分钟写 1 分钟 */
export function durationParts(seconds: number): {
  hours: number;
  minutes: number;
} {
  const total = Math.max(
    1,
    Math.round((Number.isFinite(seconds) ? seconds : 0) / 60),
  );
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/**
 * 取这一趟轨迹要查的范围。超过 24 小时的（只有不停循环的模拟设备会有，而且只有它的第一趟）
 * 只取最后 24 小时，clipped 告诉页面如实写出来。
 */
export function trackWindowOf(r: Pick<RideSummary, "startAt" | "endAt">): {
  from: string;
  to: string;
  clipped: boolean;
} {
  const end = Date.parse(r.endAt);
  // 起止认不出时原样交给接口（由它回 400），不在这里拿 NaN 去 toISOString——那会抛 RangeError 把地图页带崩
  if (!(end - Date.parse(r.startAt) > TRACK_MAX_MS)) {
    return { from: r.startAt, to: r.endAt, clipped: false };
  }
  return {
    from: new Date(end - TRACK_MAX_MS).toISOString(),
    to: r.endAt,
    clipped: true,
  };
}

/** 找「那一刻所在的行程」要查的范围：一趟最长不到 48 小时，往前看两天 */
export function rideAtWindow(atMs: number): { from: Date; to: Date } {
  return {
    from: monthGridBefore(new Date(atMs), 2),
    to: new Date(atMs + BEFORE_RIDE_MS + MIN_MS),
  };
}

/** 那一刻落在哪一趟里；都够不着返回 null（比如停着的时候按了求救） */
export function rideAt(
  rides: readonly RideSummary[],
  atMs: number,
): RideSummary | null {
  let best: RideSummary | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const r of rides) {
    const start = Date.parse(r.startAt);
    const end = Date.parse(r.endAt);
    // 起止认不出的那一趟：NaN 和谁比都是 false，不跳过的话它会以「差 0」赢过所有真的行程
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (atMs < start - BEFORE_RIDE_MS || atMs > end + AFTER_RIDE_MS) continue;
    const gap = atMs < start ? start - atMs : atMs > end ? atMs - end : 0;
    if (gap < bestGap) {
      best = r;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * JS 时间能表示的范围是 ±8.64e15 毫秒；那一刻前后还要再取几天的窗口（rideAtWindow / momentWindowOf），
 * 留一周余量，超出的按认不出处理
 */
const MAX_MOMENT_MS = 8.64e15 - 7 * DAY_MS;

/**
 * 链接参数里的「那一刻」（地图页 ?at=ISO）：认得出、且前后取窗口不会越界才算，否则 null。
 * 链接是外部输入：?at=+275760-09-13T00:00:00Z 这种合法但在边上的时间，原来会让 momentWindowOf 抛 RangeError、
 * 整页崩到错误兜底页。1970 年 / 2099 年这类头盔时钟错乱的时刻照常接受（安全记录里真有）
 */
export function parseMomentParam(raw: string | undefined): number | null {
  if (!raw) return null;
  const atMs = new Date(raw).getTime();
  return Number.isFinite(atMs) && Math.abs(atMs) <= MAX_MOMENT_MS ? atMs : null;
}

/** 那一刻不在任何一趟里：看它前后各半小时的定位 */
export function momentWindowOf(atMs: number): { from: string; to: string } {
  return {
    from: new Date(atMs - MOMENT_HALF_MS).toISOString(),
    to: new Date(atMs + MOMENT_HALF_MS).toISOString(),
  };
}

/** times 升序；返回时间最接近 atMs 的下标，空数组返回 -1 */
export function nearestIndex(times: readonly number[], atMs: number): number {
  if (times.length === 0) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < atMs) lo = mid + 1;
    else hi = mid;
  }
  // lo 是第一个不早于 atMs 的点：和它前一个比谁更近
  if (lo > 0 && atMs - times[lo - 1] <= times[lo] - atMs) return lo - 1;
  return lo;
}

export interface PlacedEvent<T> {
  event: T;
  /** 落在轨迹的第几个点 */
  index: number;
  atMs: number;
}

/**
 * 把事件放到轨迹上：每个事件落在时间最近的那个点，按时间升序。
 * 时间早于轨迹起点、或晚于终点超过 AFTER_RIDE_MS 的不放——那不是这一趟路上的事。
 */
export function placeEvents<T extends { timestamp: string }>(
  events: readonly T[],
  times: readonly number[],
): PlacedEvent<T>[] {
  if (times.length === 0) return [];
  const first = times[0] - BEFORE_RIDE_MS;
  const last = times[times.length - 1] + AFTER_RIDE_MS;
  const out: PlacedEvent<T>[] = [];
  for (const event of events) {
    const atMs = Date.parse(event.timestamp);
    if (Number.isNaN(atMs) || atMs < first || atMs > last) continue;
    out.push({ event, index: nearestIndex(times, atMs), atMs });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export interface EventGroup<T> {
  /** 这一组里最早的那个：标在它的位置，写它的时间和名字 */
  first: PlacedEvent<T>;
  /** 这一组一共几个 */
  count: number;
}

/** 一趟上最多标这么多处：再多轨迹和进度条就被盖住了 */
export const MAX_EVENT_GROUPS = 12;

/**
 * 事件多了并起来标：把轨迹按点数等分成 maxGroups 段，落在同一段里的并成一处。
 * 平时一趟只有零星几个事件，各标各的；头盔连续报警（或模拟设备每半分钟报一次）时，
 * 每段路只留一个标记和条数，轨迹还看得清。
 * @param placed 已按时间升序（placeEvents 的结果）
 */
export function groupEvents<T>(
  placed: readonly PlacedEvent<T>[],
  pointCount: number,
  maxGroups = MAX_EVENT_GROUPS,
): EventGroup<T>[] {
  if (pointCount < 2) return [];
  const out: EventGroup<T>[] = [];
  let lastSlot = -1;
  for (const p of placed) {
    const slot = Math.min(
      maxGroups - 1,
      Math.floor((p.index / (pointCount - 1)) * maxGroups),
    );
    if (slot === lastSlot) out[out.length - 1].count += 1;
    else out.push({ first: p, count: 1 });
    lastSlot = slot;
  }
  return out;
}

/**
 * 回放走到第 index 个点时，是不是正好在某个事件上：前后差不到整条轨迹的 1.2%（至少一个点）就算，
 * 有几个都够得着时取最近的。
 */
export function eventNear<T>(
  placed: readonly PlacedEvent<T>[],
  index: number,
  pointCount: number,
): PlacedEvent<T> | null {
  const reach = Math.max(1, Math.round(pointCount * 0.012));
  let best: PlacedEvent<T> | null = null;
  for (const p of placed) {
    const gap = Math.abs(p.index - index);
    if (gap > reach) continue;
    if (!best || gap < Math.abs(best.index - index)) best = p;
  }
  return best;
}
