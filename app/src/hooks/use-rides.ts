// 地图页「行程」的数据：按月往前翻的行程列表、某一个月的行程（按日期找）、现在这一趟、
// 一趟的轨迹和路上的安全事件、「在地图上查看该时刻」落在哪一趟。行程由服务器按定位点事后切分（API.md §5）。
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import type { EventListItem, RideSummary } from "@helmet/shared";

import { devicesApi } from "@/api/devices";
import { eventsApi } from "@/api/events";
import {
  AFTER_RIDE_MS,
  currentRideWindow,
  isMonthBefore,
  isSameMonth,
  monthOf,
  monthWindow,
  olderMonth,
  rideAt,
  rideAtWindow,
  type MonthCursor,
} from "@/services/rides";

/** 连着这么多个月都没有行程就先停下，把「加载更早的」交还给用户点（滑雪盔一年只用一季） */
const MAX_EMPTY_MONTHS = 12;
/** 轨迹上标的事件：两类风险提醒 + 两类求救触发；「风险解除」不标 */
const RIDE_EVENT_TYPES =
  "collision_risk,obstacle_risk,possible_fall,manual_sos";
/** 事件接口单页上限 */
const RIDE_EVENTS_PAGE = 100;
/** 一趟最多取这么多页事件（300 条）；再多的如实写「还有 N 条没标出来」 */
const RIDE_EVENTS_MAX_PAGES = 3;
const CURRENT_POLL_MS = 30_000;

export interface RidePage {
  rides: RideSummary[];
  /** 更早的从哪个月接着翻；null = 已经翻到头盔登记的那个月，没有更早的了 */
  next: MonthCursor | null;
}

/**
 * 取一页：从 cursor 那个月起往前找，直到某个月有行程、或翻到 floor（头盔登记的那个月）。
 * 中间没有行程的月自动跳过，不让用户一个月一个月地点。
 */
async function fetchRidePage(
  deviceId: string,
  cursor: MonthCursor,
  floor: MonthCursor,
): Promise<RidePage> {
  const now = new Date();
  let c = cursor;
  for (let i = 0; i < MAX_EMPTY_MONTHS; i += 1) {
    const { from, to } = monthWindow(c, now);
    const { rides } = await devicesApi.rides(
      deviceId,
      from.toISOString(),
      to.toISOString(),
    );
    const older = olderMonth(c);
    const next = isMonthBefore(older, floor) ? null : older;
    if (rides.length > 0 || next === null) return { rides, next };
    c = next;
  }
  return { rides: [], next: c };
}

/**
 * 行程列表，按自然月往前翻。
 * @param since 头盔登记到系统里的时间（DevicePublic.createdAt）：比它更早不会有这顶头盔的行程，
 *   翻到那个月就是「没有更早的了」
 */
export function useRidePages(
  deviceId: string | undefined,
  since: string | undefined,
  enabled: boolean,
) {
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const floor = Number.isNaN(sinceMs)
    ? { year: 2000, month: 0 }
    : monthOf(new Date(sinceMs));
  return useInfiniteQuery({
    queryKey: ["rides", deviceId, floor.year, floor.month],
    queryFn: ({ pageParam }) => fetchRidePage(deviceId!, pageParam, floor),
    initialPageParam: monthOf(new Date()),
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: enabled && !!deviceId,
    // 失败要尽快如实告诉用户（和「没有行程」是两回事），不在后台默默重试很久
    retry: 1,
  });
}

/**
 * 某一个月的全部行程：月历上标「哪几天骑过」、以及只看某一天 / 某个月时列表里显示的那几趟。
 * 过完的月不会再变，取到就一直用；这个月的过半分钟再看一次。
 */
export function useRideMonth(
  deviceId: string | undefined,
  month: MonthCursor | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["rides-month", deviceId, month?.year, month?.month],
    queryFn: async () => {
      const { from, to } = monthWindow(month!, new Date());
      const res = await devicesApi.rides(
        deviceId!,
        from.toISOString(),
        to.toISOString(),
      );
      return res.rides;
    },
    enabled: enabled && !!deviceId && month !== null,
    staleTime: () =>
      month !== null && isSameMonth(month, monthOf(new Date()))
        ? CURRENT_POLL_MS
        : Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

/**
 * 昨天零点以来的行程，每 30 秒刷新：第一条若是「进行中」，就是现在这一趟。
 * 也用来刷新列表最上面那几条——列表那几页不轮询。
 */
export function useRecentRides(
  deviceId: string | undefined,
  opts: { enabled: boolean; poll: boolean },
) {
  return useQuery({
    queryKey: ["rides-recent", deviceId],
    queryFn: async () => {
      const { from, to } = currentRideWindow(new Date());
      const res = await devicesApi.rides(
        deviceId!,
        from.toISOString(),
        to.toISOString(),
      );
      return res.rides;
    },
    enabled: opts.enabled && !!deviceId,
    refetchInterval: opts.poll ? CURRENT_POLL_MS : false,
    retry: false,
  });
}

/**
 * 一段时间里的轨迹（服务器抽稀到最多 1000 个点，统计用全部点算）。
 * @param keepPrevious 换范围时先留着上一份。只给「进行中的那一趟」用——它的结束时间一直在变，
 *   不留的话每次刷新线都要闪一下；看历史行程时不能留，否则会把上一趟的线当成这一趟的画出来
 */
export function useRideTrack(
  deviceId: string | undefined,
  window: { from: string; to: string } | null,
  keepPrevious = false,
) {
  return useQuery({
    queryKey: ["ride-track", deviceId, window?.from, window?.to],
    queryFn: () => devicesApi.track(deviceId!, window!.from, window!.to),
    enabled: !!deviceId && !!window,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    retry: 1,
  });
}

/** 这一趟路上的安全事件（起点到终点之后 15 分钟）。键以 "events" 开头：实时通道来了新事件会一并失效 */
export function useRideEvents(
  deviceId: string | undefined,
  window: { from: string; to: string } | null,
) {
  return useQuery({
    queryKey: ["events", deviceId, "ride", window?.from, window?.to],
    queryFn: async () => {
      const items: EventListItem[] = [];
      let total = 0;
      for (let page = 1; page <= RIDE_EVENTS_MAX_PAGES; page += 1) {
        const res = await eventsApi.list(deviceId!, {
          type: RIDE_EVENT_TYPES,
          from: window!.from,
          to: new Date(Date.parse(window!.to) + AFTER_RIDE_MS).toISOString(),
          page,
          pageSize: RIDE_EVENTS_PAGE,
        });
        items.push(...res.items);
        total = res.total;
        if (items.length >= total || res.items.length < RIDE_EVENTS_PAGE) break;
      }
      return { items, total };
    },
    enabled: !!deviceId && !!window,
    retry: 1,
  });
}

/**
 * 「在地图上查看该时刻」：那一刻落在哪一趟里。
 * data 为 null = 查到了，但那一刻不在任何一趟里（比如停着的时候按了求救）。
 */
export function useRideAt(deviceId: string | undefined, atMs: number | null) {
  return useQuery({
    queryKey: ["ride-at", deviceId, atMs],
    queryFn: async () => {
      const { from, to } = rideAtWindow(atMs!);
      const res = await devicesApi.rides(
        deviceId!,
        from.toISOString(),
        to.toISOString(),
      );
      return rideAt(res.rides, atMs!);
    },
    enabled: !!deviceId && atMs !== null,
    retry: 1,
  });
}
