// 事件查询（docs/API.md §6；backend/src/events 已实现并验收）
import type { EventDetail, EventListItem, Paginated } from '@helmet/shared';
import { api } from './client';

export const eventsApi = {
  /** 设备事件历史（最新在前）；type 可多值逗号分隔（EVENTS.md §3 事件类型） */
  list: (
    deviceId: string,
    opts: { type?: string; page?: number; pageSize?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.type) params.set('type', opts.type);
    params.set('page', String(opts.page ?? 1));
    params.set('pageSize', String(opts.pageSize ?? 20));
    return api<Paginated<EventListItem>>(
      `/devices/${encodeURIComponent(deviceId)}/events?${params.toString()}`,
    );
  },

  detail: (eventId: string) =>
    api<EventDetail>(`/events/${encodeURIComponent(eventId)}`),
};
