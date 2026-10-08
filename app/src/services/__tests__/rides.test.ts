// 地图页「行程」的推导：按月翻页的范围、合并去重、按天分组、小结、轨迹上的事件、跳到某个时刻。
// 时间一律用本地时区的构造函数造，换时区跑结果不变。
import { describe, expect, it } from "@jest/globals";
import type { RideSummary } from "@helmet/shared";

import {
  AFTER_RIDE_MS,
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
  monthOf,
  monthWindow,
  nearestIndex,
  newerMonth,
  noonOfDayKey,
  olderMonth,
  placeEvents,
  rideAt,
  rideAtWindow,
  rideAvgKmh,
  rideSeconds,
  ridesByDay,
  trackWindowOf,
} from "../rides";

const MIN = 60_000;
const HOUR = 60 * MIN;
const local = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo, d, h, mi);
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

describe("按月翻页", () => {
  it("往前一个月；跨年", () => {
    expect(olderMonth({ year: 2026, month: 9 })).toEqual({
      year: 2026,
      month: 8,
    });
    expect(olderMonth({ year: 2026, month: 0 })).toEqual({
      year: 2025,
      month: 11,
    });
    expect(monthOf(local(2026, 9, 7, 22))).toEqual({ year: 2026, month: 9 });
  });

  it("比较先后", () => {
    expect(
      isMonthBefore({ year: 2025, month: 11 }, { year: 2026, month: 0 }),
    ).toBe(true);
    expect(
      isMonthBefore({ year: 2026, month: 9 }, { year: 2026, month: 9 }),
    ).toBe(false);
    expect(
      isMonthBefore({ year: 2026, month: 9 }, { year: 2026, month: 8 }),
    ).toBe(false);
  });

  it("过完的月：本地 1 日零点到下月 1 日零点", () => {
    const now = local(2026, 9, 7, 22, 30);
    const w = monthWindow({ year: 2026, month: 8 }, now);
    expect(w.from.getTime()).toBe(local(2026, 8, 1).getTime());
    expect(w.to.getTime()).toBe(local(2026, 9, 1).getTime());
    // 接口单次范围上限 32 天
    expect(w.to.getTime() - w.from.getTime()).toBeLessThanOrEqual(
      32 * 24 * HOUR,
    );
  });

  it("当月：截到此刻之后一分钟，刚出发的那一趟也在范围里", () => {
    const now = local(2026, 9, 7, 22, 30);
    const w = monthWindow({ year: 2026, month: 9 }, now);
    expect(w.from.getTime()).toBe(local(2026, 9, 1).getTime());
    expect(w.to.getTime()).toBe(now.getTime() + MIN);
  });

  it("每年 12 个月都不超过接口的 32 天", () => {
    const now = local(2030, 0, 1);
    for (let month = 0; month < 12; month++) {
      const w = monthWindow({ year: 2026, month }, now);
      expect(w.to.getTime() - w.from.getTime()).toBeLessThanOrEqual(
        32 * 24 * HOUR,
      );
    }
  });

  it("「现在这一趟」往前至少查一整天，起点和当月那一页在同一个 24 小时网格上", () => {
    const DAY = 24 * HOUR;
    // 一年里每个月挑几个时刻（含月初、月末、夏令时切换的那几天，换时区跑都要成立）
    for (let month = 0; month < 12; month++) {
      for (const [day, hour, minute] of [
        [1, 0, 10],
        [1, 8, 0],
        [4, 3, 30],
        [5, 0, 5],
        [15, 12, 0],
        [28, 23, 59],
      ]) {
        const now = local(2026, month, day, hour, minute);
        const w = currentRideWindow(now);
        const monthStart = local(2026, month, 1).getTime();
        // 同一个网格：与月初零点相差整数个 24 小时
        // 月初那天往前退到上个月，余数是 -0：取绝对值再比
        expect(Math.abs((w.from.getTime() - monthStart) % DAY)).toBe(0);
        // 往前看了一到两天
        const back = now.getTime() - w.from.getTime();
        expect(back).toBeGreaterThanOrEqual(DAY);
        expect(back).toBeLessThan(2 * DAY);
        expect(w.to.getTime()).toBe(now.getTime() + MIN);
      }
    }
  });
});

describe("合并与分组", () => {
  const a = ride(local(2026, 9, 7, 18, 5), 36);
  const b = ride(local(2026, 9, 7, 8, 12), 35);
  const c = ride(local(2026, 9, 6, 8, 15), 34);

  it("多份合成一份：最新在前，同一趟只留一条", () => {
    expect(mergeRides([[a, b], [b, c], []])).toEqual([a, b, c]);
    expect(mergeRides([[c], [a]])).toEqual([a, c]);
    expect(mergeRides([])).toEqual([]);
  });

  it("同一趟出现在两份里：留排在前面那份的（更新鲜的那份）", () => {
    const stale = ride(local(2026, 9, 7, 19, 2), 9, { ongoing: true });
    const fresh = { ...stale, distanceMeters: 6200, ongoing: false };
    expect(mergeRides([[fresh], [stale, a]])[0]).toBe(fresh);
  });

  it("按出发那天分组，每天算出几趟、共多少米", () => {
    const days = groupByDay([a, b, c]);
    expect(days.map((d) => d.key)).toEqual(["2026-10-07", "2026-10-06"]);
    expect(days[0].rides).toEqual([a, b]);
    expect(days[0].distanceMeters).toBe(10_000);
    expect(days[1].rides).toEqual([c]);
    expect(groupByDay([])).toEqual([]);
  });

  it("跨零点的一趟算在出发那天", () => {
    const late = ride(local(2026, 9, 6, 23, 50), 30);
    expect(dayKeyOf(late.startAt)).toBe("2026-10-06");
    expect(groupByDay([late])[0].key).toBe("2026-10-06");
  });
});

// 行程列表的「按日期找」：月历的格子、哪几天有行程、只看某一天 / 某个月。
describe("按日期找", () => {
  it("往后一个月；跨年。和往前一个月互为反操作", () => {
    expect(newerMonth({ year: 2026, month: 9 })).toEqual({
      year: 2026,
      month: 10,
    });
    expect(newerMonth({ year: 2026, month: 11 })).toEqual({
      year: 2027,
      month: 0,
    });
    for (let m = 0; m < 12; m += 1) {
      const c = { year: 2026, month: m };
      expect(olderMonth(newerMonth(c))).toEqual(c);
    }
    expect(
      isSameMonth({ year: 2026, month: 9 }, monthOf(local(2026, 9, 31))),
    ).toBe(true);
    expect(
      isSameMonth({ year: 2026, month: 9 }, { year: 2025, month: 9 }),
    ).toBe(false);
  });

  it("月历周一起：2026 年 10 月 1 日是周四，前面空三格", () => {
    const weeks = monthGrid({ year: 2026, month: 9 });
    expect(weeks[0]).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(weeks[weeks.length - 1]).toEqual([26, 27, 28, 29, 30, 31, null]);
    expect(weeks).toHaveLength(5);
  });

  it("行数跟着月份走：正好四周的四行，跨六周的六行；每行都是七格，日子一天不少", () => {
    // 2027 年 2 月：1 日是周一、28 天
    expect(monthGrid({ year: 2027, month: 1 })).toHaveLength(4);
    // 2026 年 8 月：1 日是周六、31 天
    expect(monthGrid({ year: 2026, month: 7 })).toHaveLength(6);
    for (let m = 0; m < 24; m += 1) {
      const c = { year: 2026 + Math.floor(m / 12), month: m % 12 };
      const weeks = monthGrid(c);
      expect(weeks.every((w) => w.length === 7)).toBe(true);
      const days = weeks.flat().filter((d): d is number => d !== null);
      const last = new Date(c.year, c.month + 1, 0).getDate();
      expect(days).toEqual(Array.from({ length: last }, (_, i) => i + 1));
    }
  });

  it("日期键换回日期：那一天的本地正午", () => {
    const noon = noonOfDayKey("2026-10-07");
    expect(noon.getTime()).toBe(local(2026, 9, 7, 12).getTime());
    expect(dayKeyOf(noon.toISOString())).toBe("2026-10-07");
    expect(dayKeyOf(noonOfDayKey("2027-01-01").toISOString())).toBe(
      "2027-01-01",
    );
  });

  it("日期键和列表分组用的是同一个写法", () => {
    const c = { year: 2026, month: 9 };
    expect(dayKeyIn(c, 7)).toBe(
      dayKeyOf(local(2026, 9, 7, 18, 5).toISOString()),
    );
    expect(isDayInMonth("2026-10-07", c)).toBe(true);
    expect(isDayInMonth("2026-09-30", c)).toBe(false);
    expect(isDayInMonth("2025-10-07", c)).toBe(false);
  });

  const a = ride(local(2026, 9, 7, 18, 5), 36);
  const b = ride(local(2026, 9, 7, 8, 12), 35, { distanceMeters: 4200 });
  const c = ride(local(2026, 9, 6, 8, 15), 34);
  const sep = ride(local(2026, 8, 30, 23, 50), 30);

  it("哪几天有行程：按出发那天算几趟多少米，别的月的不算", () => {
    const stats = ridesByDay([a, b, c, sep], { year: 2026, month: 9 });
    expect([...stats.keys()].sort()).toEqual(["2026-10-06", "2026-10-07"]);
    expect(stats.get("2026-10-07")).toEqual({
      rides: 2,
      distanceMeters: 9200,
    });
    // 9 月 30 日夜里出发、跨进 10 月的那一趟算在 9 月
    expect(ridesByDay([sep], { year: 2026, month: 9 }).size).toBe(0);
    expect(
      ridesByDay([sep], { year: 2026, month: 8 }).get("2026-09-30"),
    ).toEqual({ rides: 1, distanceMeters: 5000 });
  });

  it("只看某一天 / 某个月：留下出发日对得上的，顺序不变", () => {
    const month = { year: 2026, month: 9 };
    expect(
      filterRides([a, b, c, sep], { kind: "day", month, dayKey: "2026-10-07" }),
    ).toEqual([a, b]);
    expect(filterRides([a, b, c, sep], { kind: "month", month })).toEqual([
      a,
      b,
      c,
    ]);
    expect(
      filterRides([a, b, c], { kind: "day", month, dayKey: "2026-10-05" }),
    ).toEqual([]);
  });
});

describe("一趟的小结", () => {
  it("时长 = 结束 − 出发", () => {
    expect(rideSeconds(ride(local(2026, 9, 7, 8, 12), 35))).toBe(2100);
    expect(rideSeconds({ startAt: "x", endAt: "y" })).toBe(0);
  });

  it("平均时速 = 里程 ÷ 时长；不到一分钟不算", () => {
    const r = ride(local(2026, 9, 7, 8, 12), 30, { distanceMeters: 10_000 });
    expect(rideAvgKmh(r)).toBeCloseTo(20, 5);
    const blink = {
      ...r,
      endAt: new Date(Date.parse(r.startAt) + 30_000).toISOString(),
    };
    expect(rideAvgKmh(blink)).toBeNull();
  });

  it("时长拆成小时和分钟：四舍五入到分钟，进位不出「1 小时 60 分」", () => {
    expect(durationParts(36 * 60)).toEqual({ hours: 0, minutes: 36 });
    expect(durationParts(106 * 60)).toEqual({ hours: 1, minutes: 46 });
    expect(durationParts(7170)).toEqual({ hours: 2, minutes: 0 });
    expect(durationParts(3599)).toEqual({ hours: 1, minutes: 0 });
    expect(durationParts(20)).toEqual({ hours: 0, minutes: 1 });
    expect(durationParts(Number.NaN)).toEqual({ hours: 0, minutes: 1 });
  });

  it("取轨迹的范围：不超过 24 小时原样；超过只取最后 24 小时并标明", () => {
    const normal = ride(local(2026, 9, 7, 8, 12), 35);
    expect(trackWindowOf(normal)).toEqual({
      from: normal.startAt,
      to: normal.endAt,
      clipped: false,
    });
    const exactly = ride(local(2026, 9, 6), 24 * 60);
    expect(trackWindowOf(exactly).clipped).toBe(false);
    const endless = ride(local(2026, 9, 5, 6), 30 * 60);
    const w = trackWindowOf(endless);
    expect(w.clipped).toBe(true);
    expect(w.to).toBe(endless.endAt);
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(24 * HOUR);
  });
});

describe("轨迹上的事件", () => {
  const t0 = local(2026, 9, 7, 8, 12).getTime();
  // 每 5 秒一个点，共 101 个（8 分 20 秒）
  const times = Array.from({ length: 101 }, (_, i) => t0 + i * 5000);
  const ev = (offsetMs: number, id: string) => ({
    id,
    timestamp: new Date(t0 + offsetMs).toISOString(),
  });

  it("时间最近的点", () => {
    expect(nearestIndex([], t0)).toBe(-1);
    expect(nearestIndex(times, t0 - HOUR)).toBe(0);
    expect(nearestIndex(times, t0 + HOUR)).toBe(100);
    expect(nearestIndex(times, t0 + 12_000)).toBe(2);
    expect(nearestIndex(times, t0 + 13_000)).toBe(3);
    // 正好在两个点中间：取前一个
    expect(nearestIndex(times, t0 + 12_500)).toBe(2);
    expect(nearestIndex([t0], t0 + 99)).toBe(0);
  });

  it("事件落到最近的点上，按时间排好", () => {
    const placed = placeEvents([ev(300_000, "b"), ev(61_000, "a")], times);
    expect(placed.map((p) => [p.event.id, p.index])).toEqual([
      ["a", 12],
      ["b", 60],
    ]);
  });

  it("停下之后 15 分钟内的事件算这一趟的，落在最后一个点；更晚的、出发前很久的不算", () => {
    const end = 500_000;
    const placed = placeEvents(
      [
        ev(end + 10 * MIN, "after"),
        ev(end + AFTER_RIDE_MS + 1000, "late"),
        ev(-10 * MIN, "early"),
        { id: "bad", timestamp: "not a time" },
      ],
      times,
    );
    expect(placed.map((p) => [p.event.id, p.index])).toEqual([["after", 100]]);
    expect(placeEvents([ev(0, "x")], [])).toEqual([]);
  });

  it("零星几个事件各标各的；挤在同一段路上的并成一处，记下条数", () => {
    // 101 个点分 12 段，每段约 8 个点
    const sparse = placeEvents([ev(60_000, "a"), ev(300_000, "b")], times);
    expect(groupEvents(sparse, times.length).map((g) => g.count)).toEqual([
      1, 1,
    ]);
    const dense = placeEvents(
      [ev(5_000, "a"), ev(10_000, "b"), ev(20_000, "c"), ev(300_000, "d")],
      times,
    );
    const groups = groupEvents(dense, times.length);
    expect(groups.map((g) => [g.first.event.id, g.count])).toEqual([
      ["a", 3],
      ["d", 1],
    ]);
  });

  it("连续报警（每 5 秒一条）：最多标 12 处，条数加起来一个不少", () => {
    const flood = placeEvents(
      Array.from({ length: 100 }, (_, i) => ev(i * 5000, `e${i}`)),
      times,
    );
    const groups = groupEvents(flood, times.length);
    expect(groups).toHaveLength(12);
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(100);
    // 每一处标在这段路上最早的那一条
    expect(groups[0].first.event.id).toBe("e0");
    expect(groupEvents(flood, 1)).toEqual([]);
  });

  it("回放走到事件附近才算「正在这个事件上」，有两个时取近的", () => {
    const placed = placeEvents([ev(60_000, "a"), ev(75_000, "b")], times);
    // 101 个点的 1.2% 四舍五入是 1 个点
    expect(eventNear(placed, 12, times.length)?.event.id).toBe("a");
    expect(eventNear(placed, 13, times.length)?.event.id).toBe("a");
    expect(eventNear(placed, 14, times.length)?.event.id).toBe("b");
    expect(eventNear(placed, 40, times.length)).toBeNull();
    expect(eventNear([], 12, times.length)).toBeNull();
  });
});

describe("「在地图上查看该时刻」落在哪一趟", () => {
  const morning = ride(local(2026, 9, 7, 8, 12), 35);
  const evening = ride(local(2026, 9, 7, 18, 5), 36);
  const at = (h: number, mi: number) => local(2026, 9, 7, h, mi).getTime();

  it("在一趟的起止之间：就是这一趟", () => {
    expect(rideAt([evening, morning], at(8, 31))).toBe(morning);
    expect(rideAt([evening, morning], at(18, 40))).toBe(evening);
  });

  it("停下之后 15 分钟内（摔倒后停住、停下才按求救）仍算这一趟", () => {
    expect(rideAt([evening, morning], at(8, 55))).toBe(morning);
    expect(rideAt([evening, morning], at(9, 3))).toBeNull();
  });

  it("两趟之间、没有行程：返回空", () => {
    expect(rideAt([evening, morning], at(13, 0))).toBeNull();
    expect(rideAt([], at(13, 0))).toBeNull();
  });

  it("查的范围：往前至少两整天（同一个 24 小时网格），到那一刻之后几分钟", () => {
    const DAY = 24 * HOUR;
    const moment = at(8, 31);
    const w = rideAtWindow(moment);
    expect((w.from.getTime() - local(2026, 9, 1).getTime()) % DAY).toBe(0);
    expect(moment - w.from.getTime()).toBeGreaterThanOrEqual(2 * DAY);
    expect(moment - w.from.getTime()).toBeLessThan(3 * DAY);
    expect(w.to.getTime()).toBeGreaterThan(moment);
    expect(w.to.getTime() - moment).toBeLessThanOrEqual(5 * MIN);
  });

  it("不在任何一趟里：看前后各半小时，不超过轨迹接口的 24 小时", () => {
    const moment = at(13, 0);
    const w = momentWindowOf(moment);
    expect(Date.parse(w.from)).toBe(moment - 30 * MIN);
    expect(Date.parse(w.to)).toBe(moment + 30 * MIN);
  });
});
