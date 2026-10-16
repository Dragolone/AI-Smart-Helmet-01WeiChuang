// 事件查询（docs/API.md §6；backend/src/events 已实现并验收）
import type { EventDetail, EventListItem, Paginated } from "@helmet/shared";
import { api } from "./client";

export const eventsApi = {
  /** 设备事件历史（最新在前）；type 可多值逗号分隔（EVENTS.md §3 事件类型）；from / to 选填（API.md §6） */
  list: (
    deviceId: string,
    opts: {
      type?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.type) params.set("type", opts.type);
    if (opts.from) params.set("from", opts.from);
    if (opts.to) params.set("to", opts.to);
    params.set("page", String(opts.page ?? 1));
    params.set("pageSize", String(opts.pageSize ?? 20));
    return api<Paginated<EventListItem>>(
      `/devices/${encodeURIComponent(deviceId)}/events?${params.toString()}`,
    );
  },

  detail: (eventId: string) =>
    api<EventDetail>(`/events/${encodeURIComponent(eventId)}`),
};

/**
 * 同一份列表（同一顶头盔、同一类型、同一页大小）所有页共用的键前缀，也正是第 1 页的键。
 * 按它失效 = 这份列表已取过的每一页一起重取（分页按偏移量取：新记录把旧的挤到后一页时，只重取第 1 页的话被挤走的那条就看不到了）
 */
export const eventsListPrefix = (
  deviceId: string,
  opts: { type: string; pageSize: number },
) => ["events", deviceId, opts.type, opts.pageSize] as const;

/**
 * 事件列表的查询配置：缓存键和请求参数从同一处生成，条数不同就是不同的缓存。
 * 安全页（每台 5 条）和事件页「全部」（每台 50 条）曾共用 ["events", id, type] 这个键，
 * 两页同时挂着各自 30 秒轮询，谁后轮询到就把对方的列表覆盖成自己的条数。
 * 键仍以 "events" 开头，实时通道按前缀失效（use-realtime）不受影响。
 */
export const eventsListQuery = (
  deviceId: string,
  opts: { type: string; pageSize: number; page?: number },
) => ({
  // 第 1 页的键不带页码（和以前一样，别处的缓存不受影响）；第 2 页起追加页码
  queryKey:
    (opts.page ?? 1) > 1
      ? ([...eventsListPrefix(deviceId, opts), opts.page] as const)
      : eventsListPrefix(deviceId, opts),
  queryFn: () => eventsApi.list(deviceId, opts),
});
