// 设备接口（docs/API.md §4；backend/src/devices 已实现并核对）
import type {
  BindDeviceRequest,
  DevicePublic,
  UpdateDeviceRequest,
  DeviceStatus,
  LatestLocationResponse,
  LocationPoint,
  Paginated,
} from '@helmet/shared';
import { api } from './client';

export const devicesApi = {
  bind: (body: BindDeviceRequest) =>
    api<DevicePublic>('/devices/bind', { method: 'POST', body }),

  list: () => api<DevicePublic[]>('/devices'),

  detail: (deviceId: string) =>
    api<DevicePublic>(`/devices/${encodeURIComponent(deviceId)}`),

  status: (deviceId: string) =>
    api<DeviceStatus>(`/devices/${encodeURIComponent(deviceId)}/status`),

  /** 重命名（API.md §4 PATCH）；name 传空串或 null = 清除自定义名 */
  rename: (deviceId: string, body: UpdateDeviceRequest) =>
    api<DevicePublic>(`/devices/${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      body,
    }),

  unbind: (deviceId: string) =>
    api<void>(`/devices/${encodeURIComponent(deviceId)}/binding`, {
      method: 'DELETE',
    }),

  /** 最新位置（API.md §5；无位置数据时 location 为 null）——WS 断线时的 REST 兜底 */
  latestLocation: (deviceId: string) =>
    api<LatestLocationResponse>(
      `/devices/${encodeURIComponent(deviceId)}/locations/latest`,
    ),

  /** 历史轨迹（API.md §5：from/to 必填、范围 ≤24h、timestamp 升序、pageSize ≤100） */
  locations: (
    deviceId: string,
    from: string,
    to: string,
    page: number,
    pageSize: number,
  ) =>
    api<Paginated<LocationPoint>>(
      `/devices/${encodeURIComponent(deviceId)}/locations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=${page}&pageSize=${pageSize}`,
    ),
};
