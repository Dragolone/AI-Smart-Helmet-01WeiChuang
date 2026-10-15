// 行程推导的边界补测（2026-10-16）：月份翻页的年头年尾、闰年二月、月历行数、日期键、时长 / 时速的边、
// 轨迹窗口 24 小时临界、「那一刻」落在哪一趟的前后临界、事件落点与分组的极端输入、链接里的 ?at=。
// 时间一律用本地时区的构造函数造，换时区跑结果不变。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@jest/globals";
import type { RideSummary } from "@helmet/shared";

import {
  AFTER_RIDE_MS,
  MAX_EVENT_GROUPS,
  currentRideWindow,
  dayKeyIn,
  dayKeyOf,
  durationParts,
  eventNear,
  filterRides,
  groupByDay,
  groupEvents,
  isDayInMonth,
  isMonthBefore,
  isSameMonth,
  mergeRides,
  momentWindowOf,
  monthGrid,
  monthWindow,
  nearestIndex,
  newerMonth,
  noonOfDayKey,
  olderMonth,
  parseMomentParam,
  placeEvents,
  rideAt,
  rideAtWindow,
  rideAvgKmh,
  rideSeconds,
  ridesByDay,
  trackWindowOf,
  type PlacedEvent,
} from "../rides";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const local = (
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
  s = 0,
  ms = 0,
) => new Date(y, mo, d, h, mi, s, ms);
const ride = (
  start: Date,
  minutes: number,
  over: Partial<RideSummary> = {},
): RideSummary => ({
  startAt: start.toISOString(),
  endAt: new Date(start.getTime() + minutes * MIN).toISOString(),
  distanceMeters: 5000,
  movingSeconds: minutes * 50,
  maxSpeed: 8,
  ongoing: false,
  ...over,
});
const span = (startMs: number, endMs: number) => ({
  startAt: new Date(startMs).toISOString(),
  endAt: new Date(endMs).toISOString(),
});

describe("月份翻页：年头年尾", () => {
  it("1 月往前是去年 12 月，12 月往后是明年 1 月；连翻 24 次回到原处", () => {
    expect(olderMonth({ year: 2026, month: 0 })).toEqual({
      year: 2025,
      month: 11,
    });
    expect(newerMonth({ year: 2026, month: 11 })).toEqual({
      year: 2027,
      month: 0,
    });
    let c = { year: 2026, month: 5 };
    for (let i = 0; i < 24; i += 1) c = olderMonth(c);
    expect(c).toEqual({ year: 2024, month: 5 });
    for (let i = 0; i < 24; i += 1) c = newerMonth(c);
    expect(c).toEqual({ year: 2026, month: 5 });
  });

  it("先后比较跨年：去年 12 月早于今年 1 月；同一个月不算早于自己", () => {
    expect(
      isMonthBefore({ year: 2025, month: 11 }, { year: 2026, month: 0 }),
    ).toBe(true);
    expect(
      isMonthBefore({ year: 2026, month: 0 }, { year: 2025, month: 11 }),
    ).toBe(false);
    expect(
      isMonthBefore({ year: 2026, month: 3 }, { year: 2026, month: 3 }),
    ).toBe(false);
    expect(
      isSameMonth({ year: 2026, month: 3 }, { year: 2025, month: 3 }),
    ).toBe(false);
  });
});

describe("monthWindow 的边", () => {
  it("过完的 12 月：到次年 1 月 1 日零点", () => {
    const { from, to } = monthWindow(
      { year: 2025, month: 11 },
      local(2026, 5, 1),
    );
    expect(from).toEqual(local(2025, 11, 1));
    expect(to).toEqual(local(2026, 0, 1));
  });

  it("闰年二月 29 天、平年 28 天（按本地日历，不按 24 小时乘天数）", () => {
    const now = local(2027, 0, 1);
    const leap = monthWindow({ year: 2024, month: 1 }, now);
    expect(leap.to).toEqual(local(2024, 2, 1));
    expect(new Date(leap.to.getTime() - 1).getDate()).toBe(29);
    const common = monthWindow({ year: 2025, month: 1 }, now);
    expect(new Date(common.to.getTime() - 1).getDate()).toBe(28);
  });

  it("这个月最后一分钟里：截到此刻后一分钟会越过下月 1 日，就用下月 1 日零点", () => {
    const now = local(2026, 9, 31, 23, 59, 30);
    expect(monthWindow({ year: 2026, month: 9 }, now).to).toEqual(
      local(2026, 10, 1),
    );
  });

  it("这个月第一分钟里：从 1 日零点到此刻后一分钟", () => {
    const now = local(2026, 9, 1, 0, 0, 10);
    const { from, to } = monthWindow({ year: 2026, month: 9 }, now);
    expect(from).toEqual(local(2026, 9, 1));
    expect(to.getTime()).toBe(now.getTime() + MIN);
  });

  it("将来的月份：to 比 from 还早（现状；月历的「下个月」在当月就禁用，不会这样调）", () => {
    const now = local(2026, 9, 16);
    const { from, to } = monthWindow({ year: 2026, month: 10 }, now);
    expect(to.getTime()).toBeLessThan(from.getTime());
  });
});

describe("currentRideWindow：月初", () => {
  it("1 日凌晨：往前一整天落到上个月最后一天的零点", () => {
    const now = local(2026, 9, 1, 0, 30);
    const { from, to } = currentRideWindow(now);
    expect(from).toEqual(local(2026, 8, 30));
    expect(to.getTime()).toBe(now.getTime() + MIN);
  });

  it("1 月 1 日凌晨：落到去年 12 月 31 日零点", () => {
    expect(currentRideWindow(local(2027, 0, 1, 0, 5)).from).toEqual(
      local(2026, 11, 31),
    );
  });
});

describe("monthGrid：各种起始星期与天数", () => {
  it("2021 年 2 月：周一开始、28 天，正好四行没有空格", () => {
    const g = monthGrid({ year: 2021, month: 1 });
    expect(g).toHaveLength(4);
    expect(g.flat().every((d) => d !== null)).toBe(true);
  });

  it("2026 年 2 月：周日开始，前面空六格，五行", () => {
    const g = monthGrid({ year: 2026, month: 1 });
    expect(g[0]).toEqual([null, null, null, null, null, null, 1]);
    expect(g).toHaveLength(5);
  });

  it("2024 年闰二月有 29 号；2026 年 8 月（周六开始、31 天）六行", () => {
    expect(monthGrid({ year: 2024, month: 1 }).flat()).toContain(29);
    expect(monthGrid({ year: 2025, month: 1 }).flat()).not.toContain(29);
    expect(monthGrid({ year: 2026, month: 7 })).toHaveLength(6);
  });

  it("任意一年的每个月：每行 7 格，1 号落在正确的星期，日子连续一天不少", () => {
    for (let m = 0; m < 12; m += 1) {
      const g = monthGrid({ year: 2028, month: m });
      const flat = g.flat();
      expect(g.every((row) => row.length === 7)).toBe(true);
      const days = flat.filter((d): d is number => d !== null);
      expect(days).toEqual(
        Array.from(
          { length: new Date(2028, m + 1, 0).getDate() },
          (_, i) => i + 1,
        ),
      );
      expect(flat.indexOf(1)).toBe((new Date(2028, m, 1).getDay() + 6) % 7);
    }
  });
});

describe("日期键", () => {
  it("一位数的月和日补零；1 月不会被误认成 10–12 月", () => {
    expect(dayKeyIn({ year: 2026, month: 0 }, 5)).toBe("2026-01-05");
    expect(dayKeyIn({ year: 2026, month: 11 }, 31)).toBe("2026-12-31");
    expect(isDayInMonth("2026-10-05", { year: 2026, month: 0 })).toBe(false);
    expect(isDayInMonth("2026-01-05", { year: 2026, month: 0 })).toBe(true);
    expect(isDayInMonth("2025-01-05", { year: 2026, month: 0 })).toBe(false);
  });

  it("dayKeyOf 认不出的时间：给出 NaN 键，不抛；它不属于任何一个月（现状）", () => {
    const key = dayKeyOf("garbage");
    expect(key).toBe("NaN-NaN-NaN");
    expect(isDayInMonth(key, { year: 2026, month: 9 })).toBe(false);
  });

  it("noonOfDayKey：闰日是当天正午；平年写了 2 月 29 日会进位到 3 月 1 日（现状，键都由 dayKeyOf 生成不会这样）", () => {
    expect(noonOfDayKey("2024-02-29")).toEqual(local(2024, 1, 29, 12));
    expect(noonOfDayKey("2025-02-29")).toEqual(local(2025, 2, 1, 12));
    expect(Number.isNaN(noonOfDayKey("abc").getTime())).toBe(true);
  });

  it("本地 23:59:59.999 出发的算当天，00:00:00.000 出发的算次日", () => {
    expect(dayKeyOf(local(2026, 9, 31, 23, 59, 59, 999).toISOString())).toBe(
      "2026-10-31",
    );
    expect(dayKeyOf(local(2026, 10, 1).toISOString())).toBe("2026-11-01");
  });
});

describe("ridesByDay / filterRides / groupByDay 的月边界", () => {
  const oct = { year: 2026, month: 9 };
  const lastMoment = ride(local(2026, 9, 31, 23, 59), 30, {
    distanceMeters: 100,
  });
  const firstOfNov = ride(local(2026, 10, 1, 0, 0), 30, {
    distanceMeters: 200,
  });
  const firstOfOct = ride(local(2026, 9, 1, 0, 0), 30, { distanceMeters: 300 });
  const lastOfSep = ride(local(2026, 8, 30, 23, 50), 30, {
    distanceMeters: 400,
  });

  it("10 月 31 日 23:59 出发、跨进 11 月的一趟算 10 月；11 月 1 日零点出发的不算", () => {
    const stats = ridesByDay(
      [firstOfNov, lastMoment, firstOfOct, lastOfSep],
      oct,
    );
    expect([...stats.keys()].sort()).toEqual(["2026-10-01", "2026-10-31"]);
    expect(stats.get("2026-10-31")).toEqual({ rides: 1, distanceMeters: 100 });
  });

  it("只看某个月：上月最后一天跨零点进来的那趟不算", () => {
    expect(
      filterRides([lastOfSep, firstOfOct, firstOfNov], {
        kind: "month",
        month: oct,
      }),
    ).toEqual([firstOfOct]);
  });

  it("只看某一天：对不上任何一趟时是空的", () => {
    expect(
      filterRides([firstOfOct], {
        kind: "day",
        month: oct,
        dayKey: "2026-10-02",
      }),
    ).toEqual([]);
  });

  it("空列表：分组、按天统计都是空的", () => {
    expect(groupByDay([])).toEqual([]);
    expect(ridesByDay([], oct).size).toBe(0);
  });

  it("同一天的行程不相邻（输入没排序）时会分成两组同键的天——调用方先 mergeRides 排好序（现状）", () => {
    const a = ride(local(2026, 9, 5, 8), 10);
    const b = ride(local(2026, 9, 4, 8), 10);
    const c = ride(local(2026, 9, 5, 18), 10);
    expect(groupByDay([a, b, c]).map((d) => d.key)).toEqual([
      "2026-10-05",
      "2026-10-04",
      "2026-10-05",
    ]);
    expect(groupByDay(mergeRides([[a, b, c]])).map((d) => d.key)).toEqual([
      "2026-10-05",
      "2026-10-04",
    ]);
  });
});

describe("mergeRides 的边", () => {
  it("没有任何一份 / 都是空的：空列表", () => {
    expect(mergeRides([])).toEqual([]);
    expect(mergeRides([[], []])).toEqual([]);
  });

  it("同一份里起点重复：留先出现的那条", () => {
    const start = local(2026, 9, 5, 8);
    const first = ride(start, 10, { distanceMeters: 1 });
    const dup = ride(start, 20, { distanceMeters: 2 });
    expect(mergeRides([[first, dup]])).toEqual([first]);
  });
});

describe("rideSeconds / rideAvgKmh / durationParts 的边", () => {
  it("结束早于出发、起止相同、认不出：时长都是 0", () => {
    const t = local(2026, 9, 5, 8).getTime();
    expect(rideSeconds(span(t, t - 60_000))).toBe(0);
    expect(rideSeconds(span(t, t))).toBe(0);
    expect(rideSeconds({ startAt: "x", endAt: "y" })).toBe(0);
  });

  it("不足一秒的零头四舍五入：0.4 秒是 0，0.5 秒是 1", () => {
    const t = local(2026, 9, 5, 8).getTime();
    expect(rideSeconds(span(t, t + 400))).toBe(0);
    expect(rideSeconds(span(t, t + 500))).toBe(1);
  });

  it("平均时速：正好 60 秒开始算；59 秒不算；里程 0 是 0 km/h", () => {
    const t = local(2026, 9, 5, 8).getTime();
    const base = {
      distanceMeters: 1000,
      movingSeconds: 60,
      maxSpeed: 5,
      ongoing: false,
    };
    expect(rideAvgKmh({ ...base, ...span(t, t + 60_000) })).toBeCloseTo(60);
    expect(rideAvgKmh({ ...base, ...span(t, t + 59_000) })).toBeNull();
    expect(
      rideAvgKmh({ ...base, distanceMeters: 0, ...span(t, t + HOUR) }),
    ).toBe(0);
  });

  it("时长拆分：0 / 29 / 30 / 89 秒都写 1 分钟，90 秒进到 2 分钟", () => {
    for (const s of [0, 29, 30, 89])
      expect(durationParts(s)).toEqual({ hours: 0, minutes: 1 });
    expect(durationParts(90)).toEqual({ hours: 0, minutes: 2 });
  });

  it("59 分 30 秒进位成 1 小时整；23:59 与 24 小时整（服务器按 24 小时切行程，最长就到这）", () => {
    expect(durationParts(59 * 60 + 30)).toEqual({ hours: 1, minutes: 0 });
    expect(durationParts(86_340)).toEqual({ hours: 23, minutes: 59 });
    expect(durationParts(86_369)).toEqual({ hours: 23, minutes: 59 });
    expect(durationParts(86_370)).toEqual({ hours: 24, minutes: 0 });
    expect(durationParts(86_400)).toEqual({ hours: 24, minutes: 0 });
  });

  it("负数、NaN、无穷：都按不足一分钟写 1 分钟，不出 NaN（现状）", () => {
    for (const s of [
      -100,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(durationParts(s)).toEqual({ hours: 0, minutes: 1 });
    }
  });

  it("超大时长照常拆，分钟始终在 0–59", () => {
    const p = durationParts(10_000 * 3600 + 59 * 60);
    expect(p).toEqual({ hours: 10_000, minutes: 59 });
  });
});

describe("trackWindowOf：24 小时临界与认不出的时间", () => {
  const t = local(2026, 9, 5, 8).getTime();

  it("正好 24 小时不裁；多 1 毫秒只取最后 24 小时", () => {
    expect(trackWindowOf(span(t, t + DAY)).clipped).toBe(false);
    const w = trackWindowOf(span(t, t + DAY + 1));
    expect(w.clipped).toBe(true);
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(DAY);
    expect(w.from).toBe(new Date(t + 1).toISOString());
  });

  it("结束早于出发：原样，不裁", () => {
    const s = span(t, t - HOUR);
    expect(trackWindowOf(s)).toEqual({
      from: s.startAt,
      to: s.endAt,
      clipped: false,
    });
  });

  // 原来认不出的结束时间会走到裁剪分支，new Date(NaN).toISOString() 抛 RangeError
  it("起止认不出：原样交给接口，不抛", () => {
    expect(() => trackWindowOf({ startAt: "x", endAt: "y" })).not.toThrow();
    expect(trackWindowOf({ startAt: "x", endAt: "y" })).toEqual({
      from: "x",
      to: "y",
      clipped: false,
    });
    const okStart = new Date(t).toISOString();
    expect(trackWindowOf({ startAt: okStart, endAt: "y" }).clipped).toBe(false);
    expect(trackWindowOf({ startAt: "x", endAt: okStart }).clipped).toBe(false);
  });
});

describe("rideAt：前后临界", () => {
  const start = local(2026, 9, 5, 8).getTime();
  const end = start + HOUR;
  const r = { ...ride(new Date(start), 60) };

  it("出发前正好 2 分钟算这一趟，再早 1 毫秒不算", () => {
    expect(rideAt([r], start - 2 * MIN)).toBe(r);
    expect(rideAt([r], start - 2 * MIN - 1)).toBeNull();
  });

  it("停下后正好 15 分钟算这一趟，再晚 1 毫秒不算", () => {
    expect(rideAt([r], end + AFTER_RIDE_MS)).toBe(r);
    expect(rideAt([r], end + AFTER_RIDE_MS + 1)).toBeNull();
  });

  it("两趟都够得着时取离得近的；一样近取列表里靠前的", () => {
    const a = ride(new Date(end + 10 * MIN), 30);
    // 那一刻在 r 结束后 4 分钟、a 出发前 6 分钟（a 的出发前只放宽 2 分钟，够不着）
    expect(rideAt([a, r], end + 4 * MIN)).toBe(r);
    const b = ride(new Date(end + 2 * MIN), 30);
    // 在 r 结束后 1 分钟、b 出发前 1 分钟：一样近，取靠前的
    expect(rideAt([b, r], end + MIN)).toBe(b);
    expect(rideAt([r, b], end + MIN)).toBe(r);
  });

  it("空列表：null", () => {
    expect(rideAt([], start)).toBeNull();
  });

  // 原来 NaN 和谁比都是 false：认不出起止的一趟会以「差 0」赢过真的那一趟
  it("起止认不出的那一趟不参与，不会抢走真的那一趟", () => {
    const broken = { ...r, startAt: "x", endAt: "y" };
    expect(rideAt([broken, r], start + MIN)).toBe(r);
    expect(rideAt([broken], start + MIN)).toBeNull();
  });
});

describe("rideAtWindow / momentWindowOf", () => {
  it("rideAtWindow：到那一刻之后 3 分钟；往前至少两整天且落在月初起的 24 小时网格上", () => {
    const at = local(2026, 9, 16, 15, 20).getTime();
    const { from, to } = rideAtWindow(at);
    expect(to.getTime()).toBe(at + 3 * MIN);
    expect(at - from.getTime()).toBeGreaterThanOrEqual(2 * DAY);
    expect(at - from.getTime()).toBeLessThan(3 * DAY);
    expect((from.getTime() - local(2026, 9, 1).getTime()) % DAY).toBe(0);
  });

  it("momentWindowOf：前后各 30 分钟，时间戳 0 也照常给", () => {
    expect(momentWindowOf(0)).toEqual({
      from: new Date(-30 * MIN).toISOString(),
      to: new Date(30 * MIN).toISOString(),
    });
  });
});

describe("parseMomentParam：地图页链接里的 ?at=", () => {
  it("没有、空串、认不出：null", () => {
    expect(parseMomentParam(undefined)).toBeNull();
    expect(parseMomentParam("")).toBeNull();
    expect(parseMomentParam("garbage")).toBeNull();
    expect(parseMomentParam("2026-13-45T99:99:99Z")).toBeNull();
  });

  it("带时区偏移、Z、毫秒的 ISO 都认，指向同一时刻", () => {
    const ms = Date.UTC(2026, 9, 15, 2, 0, 0);
    expect(parseMomentParam("2026-10-15T02:00:00Z")).toBe(ms);
    expect(parseMomentParam("2026-10-15T10:00:00+08:00")).toBe(ms);
    expect(parseMomentParam("2026-10-15T02:00:00.000Z")).toBe(ms);
  });

  it("1970 年零点是 0（不是「没有」）；头盔时钟错乱的 1970 / 2099 年时刻照常接受", () => {
    expect(parseMomentParam("1970-01-01T00:00:00Z")).toBe(0);
    expect(parseMomentParam("2099-12-31T23:59:59Z")).toBe(
      Date.UTC(2099, 11, 31, 23, 59, 59),
    );
  });

  // 原来 ?at=+275760-09-13T00:00:00Z 合法，momentWindowOf 再加 30 分钟就越界、toISOString 抛 RangeError，整页崩
  it("JS 时间能表示的边上（前后再取窗口会越界）：null", () => {
    expect(parseMomentParam("+275760-09-13T00:00:00.000Z")).toBeNull();
    expect(parseMomentParam("-271821-04-20T00:00:00.000Z")).toBeNull();
    const ok = parseMomentParam("+275000-01-01T00:00:00.000Z");
    expect(ok).not.toBeNull();
    expect(() => momentWindowOf(ok!)).not.toThrow();
    expect(() => rideAtWindow(ok!).to.toISOString()).not.toThrow();
  });
});

describe("轨迹上的事件：极端输入", () => {
  const t0 = local(2026, 9, 5, 8).getTime();
  const times = [t0, t0 + MIN, t0 + 2 * MIN, t0 + 3 * MIN];
  const ev = (ms: number, id = String(ms)) => ({
    timestamp: new Date(ms).toISOString(),
    id,
  });

  it("nearestIndex：只有一个点、点时间重复、正好在两点中间（取前一个）", () => {
    expect(nearestIndex([t0], t0 - DAY)).toBe(0);
    expect(nearestIndex([t0], t0 + DAY)).toBe(0);
    expect(nearestIndex([t0, t0, t0 + MIN], t0)).toBe(0);
    expect(nearestIndex(times, t0 + 30_000)).toBe(0);
    expect(nearestIndex(times, t0 + 30_001)).toBe(1);
  });

  it("nearestIndex：早于起点给第一个、晚于终点给最后一个；NaN 落在第一个（现状）", () => {
    expect(nearestIndex(times, t0 - HOUR)).toBe(0);
    expect(nearestIndex(times, t0 + HOUR)).toBe(3);
    expect(nearestIndex(times, Number.NaN)).toBe(0);
  });

  it("placeEvents：起点前正好 2 分钟、终点后正好 15 分钟的放上去；各再越 1 毫秒的不放", () => {
    const last = times[times.length - 1];
    const placed = placeEvents(
      [
        ev(t0 - 2 * MIN, "early-ok"),
        ev(t0 - 2 * MIN - 1, "early-out"),
        ev(last + AFTER_RIDE_MS, "late-ok"),
        ev(last + AFTER_RIDE_MS + 1, "late-out"),
      ],
      times,
    );
    expect(placed.map((p) => p.event.id)).toEqual(["early-ok", "late-ok"]);
    expect(placed.map((p) => p.index)).toEqual([0, 3]);
  });

  it("placeEvents：轨迹没有点时什么都不放；时间认不出的事件跳过", () => {
    expect(placeEvents([ev(t0)], [])).toEqual([]);
    expect(
      placeEvents([{ timestamp: "x", id: "bad" }, ev(t0, "ok")], times).map(
        (p) => p.event.id,
      ),
    ).toEqual(["ok"]);
  });

  it("placeEvents：同一时刻的几个事件保持传入的先后", () => {
    const placed = placeEvents([ev(t0 + MIN, "b"), ev(t0 + MIN, "a")], times);
    expect(placed.map((p) => p.event.id)).toEqual(["b", "a"]);
  });

  const placedAt = (indexes: number[]): PlacedEvent<{ id: number }>[] =>
    indexes.map((index, i) => ({ event: { id: i }, index, atMs: t0 + i }));

  it("groupEvents：轨迹不足两个点时不标；只分一组时全部并成一处", () => {
    expect(groupEvents(placedAt([0]), 1)).toEqual([]);
    expect(groupEvents(placedAt([0]), 0)).toEqual([]);
    const one = groupEvents(placedAt([0, 5, 9]), 10, 1);
    expect(one).toHaveLength(1);
    expect(one[0].count).toBe(3);
  });

  it("groupEvents：落在最后一个点的事件归最后一段，不会多出第 13 段", () => {
    const g = groupEvents(placedAt([0, 99]), 100);
    expect(g).toHaveLength(2);
    const all = groupEvents(
      placedAt(Array.from({ length: 100 }, (_, i) => i)),
      100,
    );
    expect(all).toHaveLength(MAX_EVENT_GROUPS);
    expect(all.reduce((n, x) => n + x.count, 0)).toBe(100);
  });

  it("groupEvents：分组数比点还多时各标各的", () => {
    expect(groupEvents(placedAt([0, 1, 2]), 3, 12)).toHaveLength(3);
  });

  it("eventNear：轨迹点很少时至少够得着前后一个点；两边一样近取先出现的", () => {
    const p = placedAt([4, 6]);
    expect(eventNear(p, 5, 0)?.index).toBe(4);
    expect(eventNear(p, 5, 10)?.index).toBe(4);
    expect(eventNear(placedAt([1]), 3, 10)).toBeNull();
    expect(eventNear([], 3, 10)).toBeNull();
  });

  it("eventNear：长轨迹按 1.2% 放宽（1000 点够得着前后 12 个点）", () => {
    const p = placedAt([500]);
    expect(eventNear(p, 512, 1000)?.index).toBe(500);
    expect(eventNear(p, 513, 1000)).toBeNull();
  });
});

describe("接线：地图页用 parseMomentParam 读 ?at=（源码不变式）", () => {
  it("不再直接 new Date(params.at)，认不出 / 越界时按没有 at 处理", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "app", "(tabs)", "map.tsx"),
      "utf8",
    );
    expect(src).toMatch(/const atMs = parseMomentParam\(params\.at\);/);
    expect(src).not.toMatch(/new Date\(params\.at\)/);
    expect(src).toMatch(/if \(atMs !== null\) \{/);
  });
});
