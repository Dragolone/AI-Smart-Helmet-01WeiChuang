// 设备接口（docs/API.md §4；backend/src/devices 已实现并核对）
import type {
  BatteryHistoryResponse,
  BindDeviceRequest,
  CommandPublic,
  DevicePublic,
  DeviceStatus,
  LatestLocationResponse,
  LocationPoint,
  LocationSummaryResponse,
  Paginated,
  PutSettingsRequest,
  ReportSettingsRequest,
  ReportSettingsResponse,
  SettingsResponse,
  UpdateDeviceRequest,
} from "@helmet/shared";
import { api } from "./client";

export const devicesApi = {
  bind: (body: BindDeviceRequest) =>
    api<DevicePublic>("/devices/bind", { method: "POST", body }),

  list: () => api<DevicePublic[]>("/devices"),

  detail: (deviceId: string) =>
    api<DevicePublic>(`/devices/${encodeURIComponent(deviceId)}`),

  /** 24h 电量历史（API.md §4；10 分钟桶） */
  batteryHistory: (deviceId: string, hours = 24) =>
    api<BatteryHistoryResponse>(
      `/devices/${encodeURIComponent(deviceId)}/battery-history?hours=${hours}`,
    ),

  status: (deviceId: string) =>
    api<DeviceStatus>(`/devices/${encodeURIComponent(deviceId)}/status`),

  /** 重命名（API.md §4 PATCH）；name 传空串或 null = 清除自定义名 */
  rename: (deviceId: string, body: UpdateDeviceRequest) =>
    api<DevicePublic>(`/devices/${encodeURIComponent(deviceId)}`, {
      method: "PATCH",
      body,
    }),

  unbind: (deviceId: string) =>
    api<void>(`/devices/${encodeURIComponent(deviceId)}/binding`, {
      method: "DELETE",
    }),

  /** 最新位置（API.md §5；无位置数据时 location 为 null）——WS 断线时的 REST 兜底 */
  latestLocation: (deviceId: string) =>
    api<LatestLocationResponse>(
      `/devices/${encodeURIComponent(deviceId)}/locations/latest`,
    ),

  /** 设备设置（API.md §8）:当前生效值 + 最近一次下发命令 */
  settings: (deviceId: string) =>
    api<SettingsResponse>(`/devices/${encodeURIComponent(deviceId)}/settings`),

  /** 下发设置（命令+回执状态机,决策 #27③④）:202 返回命令对象,回执后生效 */
  /** 头盔实际设置上报（决策 #45）：每次 BLE 握手读回 0x20–0x2D 后调用，云端据此纠正「当前生效设置」 */
  reportSettings: (deviceId: string, body: ReportSettingsRequest) =>
    api<ReportSettingsResponse>(
      `/devices/${encodeURIComponent(deviceId)}/settings/reported`,
      { method: "POST", body },
    ),

  putSettings: (deviceId: string, body: PutSettingsRequest) =>
    api<CommandPublic>(`/devices/${encodeURIComponent(deviceId)}/settings`, {
      method: "PUT",
      body,
    }),

  /** 区间轨迹统计（API.md §5 summary）：首页「今日骑行」用，服务端累加，不在 App 翻页拼 */
  locationSummary: (deviceId: string, from: string, to: string) =>
    api<LocationSummaryResponse>(
      `/devices/${encodeURIComponent(deviceId)}/locations/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
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
