// SOS / 事故记录接口（docs/API.md §7；backend/src/sos 已实现并核对）
// 状态机服务端权威（决策 #8）：App 只按 deadline 渲染倒计时，绝不自行判断超时
import type {
  AccidentDetail,
  AccidentListItem,
  ActiveSosResponse,
  Paginated,
  Sos,
} from '@helmet/shared';
import { api } from './client';

export const sosApi = {
  /** 无进行中 SOS 时返回 { sos: null } */
  active: (deviceId: string) =>
    api<ActiveSosResponse>(
      `/devices/${encodeURIComponent(deviceId)}/sos/active`,
    ),

  cancel: (sosId: string) =>
    api<Sos>(`/sos/${encodeURIComponent(sosId)}/cancel`, { method: 'POST' }),

  /** "立即求救"：跳过剩余倒计时立即通知 */
  confirm: (sosId: string) =>
    api<Sos>(`/sos/${encodeURIComponent(sosId)}/confirm`, { method: 'POST' }),

  accidents: (deviceId: string, page = 1, pageSize = 20) =>
    api<Paginated<AccidentListItem>>(
      `/devices/${encodeURIComponent(deviceId)}/accidents?page=${page}&pageSize=${pageSize}`,
    ),

  accidentDetail: (accidentId: string) =>
    api<AccidentDetail>(`/accidents/${encodeURIComponent(accidentId)}`),
};
